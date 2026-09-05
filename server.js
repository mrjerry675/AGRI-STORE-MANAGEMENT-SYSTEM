const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' })); // backup imports can be large
app.use(session({
  secret: process.env.SESSION_SECRET || 'kisan-depot-a8f3e1c94b7d2065',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 } // 12-hour login
}));

// ---------- Auth ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [String(username || '').trim()]);
    if (!rows.length || !bcrypt.compareSync(String(password || ''), rows[0].password_hash)) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    req.session.user = { id: rows[0].id, username: rows[0].username, role: rows[0].role || 'admin' };
    await logAction(req, 'login', 'user', `${rows[0].username} signed in (${rows[0].role || 'admin'})`);
    res.json({ ok: true, username: rows[0].username, role: rows[0].role || 'admin' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session.user) return res.json({ username: req.session.user.username, role: req.session.user.role || 'admin' });
  res.status(401).json({ error: 'Not logged in' });
});

// Everything below requires a login
app.use('/api', (req, res, next) => {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Not logged in' });
});

// Role wall: a salesman can only record daily business — sales, purchases,
// payments and replacements. Everything else (deletes, edits, refunds, money
// overviews, partners, expenses, logs, backups, staff) is admin-only.
const SALESMAN_ALLOW = [
  ['GET', /^\/products$/],
  ['GET', /^\/myday$/],
  ['GET', /^\/sales$/], ['POST', /^\/sales$/], ['POST', /^\/sales\/multi$/],
  ['POST', /^\/sales\/\d+\/payments$/], ['POST', /^\/sales\/\d+\/replace$/],
  ['GET', /^\/khata$/], ['POST', /^\/khata\/pay$/],
  ['GET', /^\/replacements$/],
  ['GET', /^\/purchases$/], ['POST', /^\/purchases$/], ['POST', /^\/purchases\/\d+\/payments$/]
];
app.use('/api', (req, res, next) => {
  if ((req.session.user.role || 'admin') !== 'salesman') return next();
  const ok = SALESMAN_ALLOW.some(([m, rx]) => m === req.method && rx.test(req.path));
  if (ok) return next();
  res.status(403).json({ error: 'Your salesman account is not allowed to do this' });
});

const isSalesman = req => (req.session.user && req.session.user.role) === 'salesman';
const SALESMAN_CREDIT_LIMIT = 20000;

// ---------- My Day: today's counter summary (allowed for salesmen) ----------
app.get('/api/myday', async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM sales WHERE sale_date = CURRENT_DATE) sales_count,
        (SELECT COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * s.sale_price), 0) FROM sales s
           LEFT JOIN (SELECT sale_id, SUM(qty) rqty FROM sale_returns GROUP BY sale_id) r ON r.sale_id = s.id
           WHERE s.sale_date = CURRENT_DATE) sales_total,
        (SELECT COALESCE(SUM(amount), 0) FROM sale_payments WHERE pay_date = CURRENT_DATE AND method = 'Cash') cash_in,
        (SELECT COALESCE(SUM(amount), 0) FROM sale_payments WHERE pay_date = CURRENT_DATE AND method <> 'Cash') bank_in,
        (SELECT COALESCE(SUM(refund), 0) FROM sale_returns WHERE return_date = CURRENT_DATE) refunds_out,
        (SELECT COALESCE(SUM(refund), 0) FROM sale_returns WHERE return_date = CURRENT_DATE AND method = 'Cash') refunds_cash_out,
        (SELECT COUNT(*) FROM sale_returns WHERE return_date = CURRENT_DATE) returns_count,
        (SELECT COALESCE(SUM(amount), 0) FROM purchase_payments WHERE pay_date = CURRENT_DATE AND method = 'Cash') supplier_cash_out,
        (SELECT COUNT(*) FROM purchases WHERE purchase_date = CURRENT_DATE) purchases_count,
        (SELECT COALESCE(SUM(qty * unit_price + transport), 0) FROM purchases WHERE purchase_date = CURRENT_DATE) purchases_total`);
    const r = q.rows[0];
    res.json({
      salesCount: parseInt(r.sales_count, 10), salesTotal: num(r.sales_total),
      cashIn: num(r.cash_in), bankIn: num(r.bank_in),
      refundsOut: num(r.refunds_out), refundsCashOut: num(r.refunds_cash_out),
      returnsCount: parseInt(r.returns_count, 10),
      supplierCashOut: num(r.supplier_cash_out),
      purchasesCount: parseInt(r.purchases_count, 10), purchasesTotal: num(r.purchases_total),
      // only refunds handed back as physical cash leave the drawer —
      // bank/wallet refunds are netted in the bank figures instead
      netCash: num(r.cash_in) - num(r.refunds_cash_out) - num(r.supplier_cash_out)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Staff accounts (admin only — the role wall blocks salesmen) ----------
app.get('/api/staff', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, username, role FROM users ORDER BY id");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/staff', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username: 3–20 letters/numbers, no spaces' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const dup = await pool.query('SELECT 1 FROM users WHERE LOWER(username) = $1', [username]);
    if (dup.rowCount) return res.status(400).json({ error: 'This username already exists' });
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'salesman') RETURNING id, username, role",
      [username, bcrypt.hashSync(password, 10)]);
    await logAction(req, 'created', 'user', `Salesman account created: ${username}`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/staff/:id/password', async (req, res) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const { rows } = await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2 AND role = 'salesman' RETURNING username",
      [bcrypt.hashSync(password, 10), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Salesman account not found' });
    await logAction(req, 'password', 'user', `Password reset for salesman: ${rows[0].username}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM users WHERE id = $1 AND role = 'salesman' RETURNING username", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Salesman account not found (admin accounts cannot be deleted)' });
    await logAction(req, 'deleted', 'user', `Salesman account DELETED: ${rows[0].username}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/change-password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (!bcrypt.compareSync(String(current_password || ''), rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2',
      [bcrypt.hashSync(String(new_password), 10), req.session.user.id]);
    await logAction(req, 'password', 'user', 'Password was changed');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send visitors without a session to the login page
const guardPage = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login.html');
};
app.get('/', guardPage);
app.get('/index.html', guardPage);

app.use(express.static(path.join(__dirname, 'public')));

const num = v => parseFloat(v) || 0;
const fRs = v => 'Rs ' + Math.round(num(v)).toLocaleString('en-PK');

// Append-only activity log. Every save/delete/payment is recorded here;
// there is intentionally no way to edit or remove log entries.
async function logAction(req, action, entity, details) {
  try {
    const user = (req.session && req.session.user && req.session.user.username) || 'system';
    await pool.query(
      'INSERT INTO logs (username, action, entity, details) VALUES ($1, $2, $3, $4)',
      [user, action, entity, details]);
  } catch (e) { console.error('log failed:', e.message); }
}

// ---------- Current-rate costing ----------
// Every purchase keeps its own recorded price forever. A sale's cost is the
// rate in force on the sale's date (the most recent purchase on or before it,
// including that purchase's transport). Old profits never change when a new
// purchase arrives — the new rate applies only from its own date onward.
async function buildCostIndex() {
  const { rows } = await pool.query(`
    SELECT product_id, to_char(purchase_date, 'YYYY-MM-DD') AS d, id, qty, unit_price, transport
    FROM purchases ORDER BY purchase_date, id`);
  const byProduct = {};
  rows.forEach(r => {
    const unitCost = (num(r.qty) * num(r.unit_price) + num(r.transport)) / num(r.qty);
    (byProduct[r.product_id] = byProduct[r.product_id] || []).push({ d: r.d, unitCost });
  });
  const costAt = (pid, date) => {
    const list = byProduct[pid];
    if (!list || !list.length) return 0;
    let c = null;
    for (const p of list) { if (p.d <= date) c = p.unitCost; else break; }
    return c !== null ? c : list[0].unitCost; // sold before the first purchase: use the first known rate
  };
  const currentCost = pid => {
    const list = byProduct[pid];
    return list && list.length ? list[list.length - 1].unitCost : 0;
  };
  return { costAt, currentCost };
}

// SQL version of the same rule, for chart/analytics queries (alias s = sales)
const SALE_COST_SQL = `
  COALESCE((
    SELECT (pu.qty * pu.unit_price + pu.transport) / pu.qty FROM purchases pu
    WHERE pu.product_id = s.product_id AND pu.purchase_date <= s.sale_date
    ORDER BY pu.purchase_date DESC, pu.id DESC LIMIT 1
  ), (
    SELECT (pu.qty * pu.unit_price + pu.transport) / pu.qty FROM purchases pu
    WHERE pu.product_id = s.product_id
    ORDER BY pu.purchase_date ASC, pu.id ASC LIMIT 1
  ), 0)`;

// Per-product aggregates: purchased qty/amount, sold qty/amount, current cost, remaining, stock value, profit
async function productStats() {
  const [prodQ, puQ, sQ, cost] = await Promise.all([
    pool.query('SELECT id, name, category, unit, description, sale_price, pack_size, pack_unit FROM products ORDER BY name'),
    pool.query('SELECT product_id, qty, unit_price, transport FROM purchases'),
    pool.query(`
      SELECT s.product_id, to_char(s.sale_date, 'YYYY-MM-DD') AS d, s.qty, s.sale_price,
             COALESCE(r.rqty, 0) AS ret
      FROM sales s
      LEFT JOIN (SELECT sale_id, SUM(qty) rqty FROM sale_returns GROUP BY sale_id) r ON r.sale_id = s.id`),
    buildCostIndex()
  ]);
  const agg = {};
  prodQ.rows.forEach(p => {
    agg[p.id] = {
      id: p.id, name: p.name, category: p.category, unit: p.unit, description: p.description,
      salePrice: num(p.sale_price),
      packSize: num(p.pack_size), packUnit: p.pack_unit || '',
      purchasedQty: 0, purchasedAmt: 0, soldQty: 0, soldAmt: 0, profit: 0
    };
  });
  puQ.rows.forEach(r => {
    const a = agg[r.product_id]; if (!a) return;
    a.purchasedQty += num(r.qty);
    a.purchasedAmt += num(r.qty) * num(r.unit_price) + num(r.transport);
  });
  sQ.rows.forEach(s => {
    const a = agg[s.product_id]; if (!a) return;
    const eff = num(s.qty) - num(s.ret);
    a.soldQty += eff;
    a.soldAmt += eff * num(s.sale_price);
    a.profit += eff * (num(s.sale_price) - cost.costAt(s.product_id, s.d));
  });
  return Object.values(agg).map(a => {
    const avgCost = cost.currentCost(a.id); // "current cost" = today's rate
    const remaining = a.purchasedQty - a.soldQty;
    return { ...a, avgCost, remaining, stockValue: remaining * avgCost };
  }).sort((x, y) => x.name.localeCompare(y.name));
}

// ---------- Products ----------
app.get('/api/products', async (req, res) => {
  try {
    const stats = await productStats();
    if (isSalesman(req)) {
      // cost figures are the shop's margin secret — salesmen get stock and sale info only
      return res.json(stats.map(p => ({
        id: p.id, name: p.name, category: p.category, unit: p.unit, description: p.description,
        salePrice: p.salePrice, remaining: p.remaining,
        packSize: p.packSize, packUnit: p.packUnit, // needed for loose sales, not a cost secret
        purchasedQty: p.purchasedQty, soldQty: p.soldQty,
        avgCost: 0, purchasedAmt: 0, soldAmt: 0, stockValue: 0, profit: 0
      })));
    }
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, category, unit, description, sale_price, pack_size, pack_unit } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });
    if (num(sale_price) < 0) return res.status(400).json({ error: 'Sale price cannot be negative' });
    if (num(pack_size) < 0) return res.status(400).json({ error: 'Pack size cannot be negative' });
    const dup = await pool.query(
      'SELECT name FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))', [name]);
    if (dup.rowCount) {
      return res.status(400).json({ error: `A product named "${dup.rows[0].name}" already exists — edit it instead of adding it again` });
    }
    const { rows } = await pool.query(
      'INSERT INTO products (name, category, unit, description, sale_price, pack_size, pack_unit) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name.trim(), category || 'Fertilizer', unit || 'bag', description || '', sale_price || 0,
       pack_size || 0, num(pack_size) > 0 ? (pack_unit || 'kg') : '']);
    await logAction(req, 'created', 'product', `Product added: ${rows[0].name} (${rows[0].category}, per ${rows[0].unit})` +
      (num(sale_price) > 0 ? ` — fixed price ${fRs(sale_price)}` : ''));
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { name, category, unit, description, sale_price, pack_size, pack_unit } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });
    if (num(sale_price) < 0) return res.status(400).json({ error: 'Sale price cannot be negative' });
    if (num(pack_size) < 0) return res.status(400).json({ error: 'Pack size cannot be negative' });
    const dup = await pool.query(
      'SELECT name FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND id <> $2', [name, req.params.id]);
    if (dup.rowCount) {
      return res.status(400).json({ error: `Another product named "${dup.rows[0].name}" already exists` });
    }
    const oldQ = await pool.query('SELECT name, category, unit, description, sale_price, pack_size, pack_unit FROM products WHERE id = $1', [req.params.id]);
    if (!oldQ.rows.length) return res.status(404).json({ error: 'Product not found' });
    const o = oldQ.rows[0];
    const { rows } = await pool.query(
      'UPDATE products SET name = $1, category = $2, unit = $3, description = $4, sale_price = $5, pack_size = $6, pack_unit = $7 WHERE id = $8 RETURNING *',
      [name.trim(), category || 'Fertilizer', unit || 'bag', description || '', sale_price || 0,
       pack_size || 0, num(pack_size) > 0 ? (pack_unit || 'kg') : '', req.params.id]);
    const n = rows[0];
    const changes = [];
    if (o.name !== n.name) changes.push(`name "${o.name}" → "${n.name}"`);
    if (o.category !== n.category) changes.push(`category ${o.category} → ${n.category}`);
    if (o.unit !== n.unit) changes.push(`unit ${o.unit} → ${n.unit}`);
    if (o.description !== n.description) changes.push(`description "${o.description}" → "${n.description}"`);
    if (num(o.sale_price) !== num(n.sale_price)) changes.push(`fixed price ${fRs(o.sale_price)} → ${fRs(n.sale_price)}`);
    if (num(o.pack_size) !== num(n.pack_size) || o.pack_unit !== n.pack_unit) {
      changes.push(`pack ${num(o.pack_size) > 0 ? `${num(o.pack_size)} ${o.pack_unit}` : 'none'} → ${num(n.pack_size) > 0 ? `${num(n.pack_size)} ${n.pack_unit}` : 'none'}`);
    }
    if (changes.length) {
      await logAction(req, 'edited', 'product', `Product "${n.name}" edited — ${changes.join(', ')}`);
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const info = await pool.query(`
      SELECT p.name, p.category,
        (SELECT COUNT(*) FROM purchases WHERE product_id = p.id) pc,
        (SELECT COUNT(*) FROM sales WHERE product_id = p.id) sc,
        (SELECT COUNT(*) FROM investments WHERE product_id = p.id) ic,
        (SELECT COALESCE(SUM(amount), 0) FROM investments WHERE product_id = p.id) iamt
      FROM products p WHERE p.id = $1`, [req.params.id]);
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    if (info.rows.length) {
      const i = info.rows[0];
      await logAction(req, 'deleted', 'product',
        `Product DELETED: ${i.name} (${i.category}) — this also removed ${i.pc} purchase(s) and ${i.sc} sale(s) linked to it` +
        (num(i.iamt) > 0 ? ` and ${i.ic} partner investment record(s) totalling ${fRs(i.iamt)}` : ''));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Purchases (Stock In) ----------
app.get('/api/purchases', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pu.*, to_char(pu.purchase_date, 'YYYY-MM-DD') AS purchase_date,
             p.name, p.category, p.unit,
             COALESCE(pp.paid, 0) AS paid
      FROM purchases pu
      JOIN products p ON p.id = pu.product_id
      LEFT JOIN (SELECT purchase_id, SUM(amount) paid FROM purchase_payments GROUP BY purchase_id) pp
        ON pp.purchase_id = pu.id
      ORDER BY pu.purchase_date DESC, pu.id DESC`);
    if (isSalesman(req)) {
      // no cost browsing for salesmen: quantities and dates only
      return res.json(rows.map(r => ({
        id: r.id, product_id: r.product_id, purchase_date: r.purchase_date,
        name: r.name, category: r.category, unit: r.unit, qty: r.qty,
        unit_price: 0, transport: 0, paid: 0, remaining: 0
      })));
    }
    res.json(rows.map(r => ({ ...r, remaining: num(r.qty) * num(r.unit_price) + num(r.transport) - num(r.paid) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/purchases', async (req, res) => {
  try {
    const { product_id, purchase_date, qty, unit_price, transport, paid_now } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Choose a product' });
    if (!purchase_date) return res.status(400).json({ error: 'Purchase date is required' });
    if (num(qty) <= 0) return res.status(400).json({ error: 'Quantity must be more than 0' });
    if (num(transport) < 0) return res.status(400).json({ error: 'Transport charges cannot be negative' });

    if (isSalesman(req) && purchase_date !== localStamp()) {
      return res.status(400).json({ error: 'Salesman accounts can only record purchases for today' });
    }

    const total = num(qty) * num(unit_price) + num(transport);
    // blank "paid now" means fully paid; otherwise it must be between 0 and the total
    const paid = (paid_now === undefined || paid_now === null || paid_now === '') ? total : num(paid_now);
    if (paid < 0) return res.status(400).json({ error: 'Paid amount cannot be negative' });
    if (paid > total) return res.status(400).json({ error: `Paid amount cannot be more than the total (Rs ${total})` });

    const { rows } = await pool.query(
      'INSERT INTO purchases (product_id, purchase_date, qty, unit_price, transport) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [product_id, purchase_date, qty, unit_price || 0, transport || 0]);
    if (paid > 0) {
      await pool.query(
        'INSERT INTO purchase_payments (purchase_id, pay_date, amount, method) VALUES ($1, $2, $3, $4)',
        [rows[0].id, purchase_date, paid, 'Cash']);
    }
    const pn = await pool.query('SELECT name, unit FROM products WHERE id = $1', [product_id]);
    await logAction(req, 'created', 'purchase',
      `Purchase #${rows[0].id} saved: ${num(qty)} ${pn.rows[0].unit} ${pn.rows[0].name} @ ${fRs(unit_price)}` +
      (num(transport) > 0 ? ` + ${fRs(transport)} transport` : '') +
      ` = ${fRs(total)} (paid now ${fRs(paid)}${paid < total ? `, due ${fRs(total - paid)}` : ''})`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Purchases cannot be edited once recorded — delete and re-enter to correct a mistake.

// Record a later payment to the supplier for a purchase
app.post('/api/purchases/:id/payments', async (req, res) => {
  try {
    const { amount, pay_date, method } = req.body;
    if (num(amount) <= 0) return res.status(400).json({ error: 'Amount must be more than 0' });
    if (!pay_date) return res.status(400).json({ error: 'Payment date is required' });
    if (isSalesman(req) && pay_date !== localStamp()) {
      return res.status(400).json({ error: 'Salesman accounts can only record payments for today' });
    }
    const { rows } = await pool.query(`
      SELECT pu.qty * pu.unit_price + pu.transport AS total, COALESCE(SUM(pp.amount), 0) AS paid
      FROM purchases pu LEFT JOIN purchase_payments pp ON pp.purchase_id = pu.id
      WHERE pu.id = $1 GROUP BY pu.id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Purchase not found' });
    const remaining = num(rows[0].total) - num(rows[0].paid);
    if (num(amount) > remaining + 0.001) {
      return res.status(400).json({ error: `Only Rs ${remaining} is remaining on this purchase` });
    }
    await pool.query(
      'INSERT INTO purchase_payments (purchase_id, pay_date, amount, method) VALUES ($1, $2, $3, $4)',
      [req.params.id, pay_date, amount, method || 'Cash']);
    await logAction(req, 'payment', 'purchase',
      `Supplier paid ${fRs(amount)} (${method || 'Cash'}) on purchase #${req.params.id} — ${fRs(remaining - num(amount))} still due`);
    res.json({ ok: true, remaining: remaining - num(amount) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/purchases/:id', async (req, res) => {
  try {
    const info = await pool.query(`
      SELECT to_char(pu.purchase_date, 'DD-Mon-YYYY') d, pu.qty, pu.unit_price, pu.transport,
             p.name, p.unit,
             COALESCE((SELECT SUM(amount) FROM purchase_payments WHERE purchase_id = pu.id), 0) paid
      FROM purchases pu JOIN products p ON p.id = pu.product_id WHERE pu.id = $1`, [req.params.id]);
    await pool.query('DELETE FROM purchases WHERE id = $1', [req.params.id]);
    if (info.rows.length) {
      const i = info.rows[0];
      const total = num(i.qty) * num(i.unit_price) + num(i.transport);
      await logAction(req, 'deleted', 'purchase',
        `Purchase DELETED: [${i.d}] ${num(i.qty)} ${i.unit} ${i.name} @ ${fRs(i.unit_price)}` +
        (num(i.transport) > 0 ? ` + ${fRs(i.transport)} transport` : '') +
        ` = ${fRs(total)} (had paid ${fRs(i.paid)})`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Sales ----------
app.get('/api/sales', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date,
             p.name, p.category, p.unit, p.pack_size, p.pack_unit,
             COALESCE(sp.paid, 0) AS paid,
             COALESCE(sr.rqty, 0) AS returned,
             COALESCE(sr.refunded, 0) AS refunded
      FROM sales s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN (SELECT sale_id, SUM(amount) paid FROM sale_payments GROUP BY sale_id) sp
        ON sp.sale_id = s.id
      LEFT JOIN (SELECT sale_id, SUM(qty) rqty, SUM(refund) refunded FROM sale_returns GROUP BY sale_id) sr
        ON sr.sale_id = s.id
      ORDER BY s.sale_date DESC, s.id DESC`);
    res.json(rows.map(r => {
      const effQty = num(r.qty) - num(r.returned);
      const effTotal = effQty * num(r.sale_price);
      const paidNet = num(r.paid) - num(r.refunded);
      return { ...r, effQty, effTotal, paidNet, remaining: effTotal - paidNet };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sales', async (req, res) => {
  try {
    const { product_id, sale_date, qty, sale_price, payment, customer_name, phone, address, paid_now } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Choose a product' });
    if (!sale_date) return res.status(400).json({ error: 'Sale date is required' });
    if (num(qty) <= 0) return res.status(400).json({ error: 'Quantity must be more than 0' });
    if (num(sale_price) <= 0) return res.status(400).json({ error: 'Sale price must be more than 0' });

    const stats = await productStats();
    const prod = stats.find(p => p.id === parseInt(product_id, 10));
    if (!prod) return res.status(400).json({ error: 'Product not found' });
    if (num(qty) > prod.remaining) {
      return res.status(400).json({ error: `Only ${prod.remaining} ${prod.unit} in stock for ${prod.name}` });
    }

    const method = payment || 'Cash';
    const total = num(qty) * num(sale_price);
    // blank "received now" means: credit sale -> nothing received, otherwise fully received
    const paid = (paid_now === undefined || paid_now === null || paid_now === '')
      ? (method === 'Credit (Udhaar)' ? 0 : total) : num(paid_now);
    if (paid < 0) return res.status(400).json({ error: 'Received amount cannot be negative' });
    if (paid > total) return res.status(400).json({ error: `Received amount cannot be more than the total (Rs ${total})` });

    if (isSalesman(req)) {
      if (sale_date !== localStamp()) return res.status(400).json({ error: 'Salesman accounts can only record sales for today' });
      const due = total - paid;
      if (due > 0.001 && (!(customer_name || '').trim() || !(phone || '').trim())) {
        return res.status(400).json({ error: 'Udhaar sale needs the customer name AND phone number' });
      }
      if (due > SALESMAN_CREDIT_LIMIT) {
        return res.status(400).json({ error: `Credit above ${fRs(SALESMAN_CREDIT_LIMIT)} needs the admin` });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO sales (product_id, sale_date, qty, sale_price, payment, customer_name, phone, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [product_id, sale_date, qty, sale_price || 0, method, customer_name || '', phone || '', address || '']);
    if (paid > 0) {
      await pool.query(
        'INSERT INTO sale_payments (sale_id, pay_date, amount, method) VALUES ($1, $2, $3, $4)',
        [rows[0].id, sale_date, paid, method === 'Credit (Udhaar)' ? 'Cash' : method]);
    }
    await logAction(req, 'created', 'sale',
      `Sale KD-${rows[0].id} saved: ${num(qty)} ${prod.unit} ${prod.name} @ ${fRs(sale_price)} = ${fRs(total)}` +
      (customer_name ? ` to ${customer_name}` : '') +
      ` — received ${fRs(paid)} (${method})${paid < total ? `, due ${fRs(total - paid)}` : ''}`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Editing a sale can only change the date and customer details — product,
// quantity, price and payment method are locked once recorded.
app.put('/api/sales/:id', async (req, res) => {
  try {
    const { sale_date, customer_name, phone, address } = req.body;
    if (!sale_date) return res.status(400).json({ error: 'Sale date is required' });
    const oldQ = await pool.query(
      `SELECT to_char(sale_date, 'YYYY-MM-DD') AS sale_date, customer_name, phone, address FROM sales WHERE id = $1`,
      [req.params.id]);
    if (!oldQ.rows.length) return res.status(404).json({ error: 'Sale not found' });
    const o = oldQ.rows[0];
    const { rows } = await pool.query(
      `UPDATE sales SET sale_date = $1, customer_name = $2, phone = $3, address = $4
       WHERE id = $5 RETURNING *`,
      [sale_date, customer_name || '', phone || '', address || '', req.params.id]);
    const changes = [];
    if (o.sale_date !== sale_date) changes.push(`date ${o.sale_date} → ${sale_date}`);
    if (o.customer_name !== (customer_name || '')) changes.push(`customer "${o.customer_name}" → "${customer_name || ''}"`);
    if (o.phone !== (phone || '')) changes.push(`phone "${o.phone}" → "${phone || ''}"`);
    if (o.address !== (address || '')) changes.push(`address "${o.address}" → "${address || ''}"`);
    if (changes.length) {
      await logAction(req, 'edited', 'sale', `Sale KD-${req.params.id} edited — ${changes.join(', ')}`);
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Customer khata: every named customer's account in one place ----------
// A customer is identified by name+phone (case-insensitive name). Sales with no
// customer name are walk-in cash sales and stay out of the khata.
async function buildKhata() {
  const { rows } = await pool.query(`
    SELECT s.id, to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date, s.qty, s.sale_price,
           s.customer_name, s.phone, s.address, s.payment, s.created_at,
           p.name AS product_name, p.unit,
           COALESCE(sp.paid, 0) AS paid,
           COALESCE(sr.rqty, 0) AS returned,
           COALESCE(sr.refunded, 0) AS refunded
    FROM sales s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN (SELECT sale_id, SUM(amount) paid FROM sale_payments GROUP BY sale_id) sp ON sp.sale_id = s.id
    LEFT JOIN (SELECT sale_id, SUM(qty) rqty, SUM(refund) refunded FROM sale_returns GROUP BY sale_id) sr ON sr.sale_id = s.id
    WHERE TRIM(s.customer_name) <> ''
    ORDER BY s.sale_date, s.id`);

  const groups = {};
  rows.forEach(r => {
    const key = r.customer_name.trim().toLowerCase() + '|' + String(r.phone || '').trim();
    const g = groups[key] || (groups[key] = {
      key, name: r.customer_name.trim(), phone: String(r.phone || '').trim(),
      address: '', salesCount: 0, totalBought: 0, totalPaid: 0, due: 0,
      lastSale: null, unpaid: []
    });
    const effTotal = (num(r.qty) - num(r.returned)) * num(r.sale_price);
    const paidNet = num(r.paid) - num(r.refunded);
    const due = effTotal - paidNet;
    g.salesCount++;
    g.totalBought += effTotal;
    g.totalPaid += paidNet;
    if (due > 0.001) {
      g.due += due;
      g.unpaid.push({
        id: r.id, date: r.sale_date, product: r.product_name, unit: r.unit,
        qty: num(r.qty) - num(r.returned), total: effTotal, paid: paidNet, due
      });
    }
    if (String(r.address || '').trim()) g.address = r.address.trim();
    g.lastSale = r.sale_date; // rows come oldest-first, so the last write wins
  });

  return Object.values(groups).sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));
}

app.get('/api/khata', async (req, res) => {
  try { res.json(await buildKhata()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Collect one payment from a customer and spread it over their unpaid bills,
// oldest first — the way a paper khata is settled.
app.post('/api/khata/pay', async (req, res) => {
  try {
    const { name, phone, amount, pay_date, method } = req.body;
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Customer name is required' });
    if (num(amount) <= 0) return res.status(400).json({ error: 'Amount must be more than 0' });
    if (!pay_date) return res.status(400).json({ error: 'Payment date is required' });
    if (isSalesman(req) && pay_date !== localStamp()) {
      return res.status(400).json({ error: 'Salesman accounts can only record payments for today' });
    }

    const khata = await buildKhata();
    const key = String(name).trim().toLowerCase() + '|' + String(phone || '').trim();
    const cust = khata.find(g => g.key === key);
    if (!cust) return res.status(404).json({ error: 'No khata found for this customer' });
    if (num(amount) > cust.due + 0.001) {
      return res.status(400).json({ error: `${cust.name} only owes ${fRs(cust.due)} — cannot receive more than that` });
    }

    const via = method || 'Cash';
    const c = await pool.connect();
    const filled = [];
    try {
      await c.query('BEGIN');
      let left = num(amount);
      for (const bill of cust.unpaid) { // already oldest-first
        if (left <= 0.001) break;
        const put = Math.min(left, bill.due);
        await c.query(
          'INSERT INTO sale_payments (sale_id, pay_date, amount, method) VALUES ($1, $2, $3, $4)',
          [bill.id, pay_date, put, via]);
        filled.push(`KD-${bill.id} ${fRs(put)}`);
        left -= put;
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }

    await logAction(req, 'payment', 'khata',
      `Udhaar collected: ${fRs(amount)} from ${cust.name}${cust.phone ? ` (${cust.phone})` : ''} via ${via}` +
      ` — spread over ${filled.length} bill(s): ${filled.join(', ')}. Remaining due: ${fRs(cust.due - num(amount))}`);
    res.json({ ok: true, bills: filled.length, remainingDue: cust.due - num(amount) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Sale returns ----------
async function saleFinances(saleId) {
  const { rows } = await pool.query(`
    SELECT s.qty, s.sale_price, s.customer_name, s.product_id, s.payment, s.phone, s.address, s.receipt_group,
           to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date,
           p.name AS pname, p.unit,
           COALESCE(sp.paid, 0) AS paid,
           COALESCE(sr.rqty, 0) AS returned,
           COALESCE(sr.refunded, 0) AS refunded
    FROM sales s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN (SELECT sale_id, SUM(amount) paid FROM sale_payments GROUP BY sale_id) sp ON sp.sale_id = s.id
    LEFT JOIN (SELECT sale_id, SUM(qty) rqty, SUM(refund) refunded FROM sale_returns GROUP BY sale_id) sr ON sr.sale_id = s.id
    WHERE s.id = $1`, [saleId]);
  return rows[0];
}

// EXCEPTION refund (admin only): official shop policy is no refunds — only
// 3-day replacements. But for close relatives and trusted customers the owner
// can take goods back. There is no day limit, a reason is required, and the
// exception is logged loudly. The qty goes back to stock; whatever the
// customer has then overpaid is handed back so the books stay balanced.
const REFUND_METHODS = ['Cash', 'JazzCash / Easypaisa', 'Bank Alfalah', 'Bank of Punjab', 'Meezan Bank'];

app.post('/api/sales/:id/returns', async (req, res) => {
  try {
    if (isSalesman(req)) {
      return res.status(403).json({ error: 'Only the admin can make a refund exception — the shop policy is no refunds' });
    }
    const { qty, return_date, reason, method } = req.body;
    if (num(qty) <= 0) return res.status(400).json({ error: 'Return quantity must be more than 0' });
    if (!return_date) return res.status(400).json({ error: 'Return date is required' });
    if (!String(reason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required — this is an exception to the no-refund policy' });
    }

    const f = await saleFinances(req.params.id);
    if (!f) return res.status(404).json({ error: 'Sale not found' });
    const diffDays = (new Date(return_date + 'T00:00:00') - new Date(f.sale_date + 'T00:00:00')) / 86400000;
    if (diffDays < 0) return res.status(400).json({ error: 'Return date cannot be before the sale date' });

    const keptSoFar = num(f.qty) - num(f.returned);
    if (num(qty) > keptSoFar + 0.001) {
      return res.status(400).json({ error: `Only ${keptSoFar} of this sale can still be returned` });
    }
    // whatever the customer has now overpaid is given back automatically
    const newTotal = (keptSoFar - num(qty)) * num(f.sale_price);
    const paidNet = num(f.paid) - num(f.refunded);
    const refund = Math.max(0, paidNet - newTotal);
    const via = REFUND_METHODS.includes(method) ? method : 'Cash';

    const { rows } = await pool.query(
      `INSERT INTO sale_returns (sale_id, return_date, qty, refund, method, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, return_date, qty, refund, via, String(reason).trim()]);
    await logAction(req, 'return', 'sale',
      `EXCEPTION REFUND on KD-${req.params.id} (no-refund policy waived by admin): ` +
      `${num(qty)} ${f.unit} ${f.pname} back to stock` +
      (f.customer_name ? ` from ${f.customer_name}` : '') +
      (refund > 0.001 ? `, ${fRs(refund)} paid back via ${via}` : ', due amount reduced instead — no money out') +
      ` — ${String(reason).trim()}`);
    res.json({ ...rows[0], refundGiven: refund });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/returns', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.sale_id, to_char(r.return_date, 'YYYY-MM-DD') AS return_date,
             r.qty, r.refund, r.method, r.reason,
             s.sale_price, s.customer_name, s.phone,
             p.name AS product_name, p.category, p.unit
      FROM sale_returns r
      JOIN sales s ON s.id = r.sale_id
      JOIN products p ON p.id = s.product_id
      ORDER BY r.return_date DESC, r.id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/returns/:id', async (req, res) => {
  try {
    const info = await pool.query(`
      SELECT r.sale_id, r.qty, r.refund, p.name, p.unit
      FROM sale_returns r JOIN sales s ON s.id = r.sale_id JOIN products p ON p.id = s.product_id
      WHERE r.id = $1`, [req.params.id]);
    await pool.query('DELETE FROM sale_returns WHERE id = $1', [req.params.id]);
    if (info.rows.length) {
      const i = info.rows[0];
      await logAction(req, 'deleted', 'return',
        `Return UNDONE on KD-${i.sale_id}: ${num(i.qty)} ${i.unit} ${i.name} counts as sold again` +
        (num(i.refund) > 0.001 ? ` (${fRs(i.refund)} refund cancelled)` : ''));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One customer buying several products in one visit: each item stays its own
// sale row (so stock/profit/returns math is unchanged), linked by receipt_group
// so they print on one receipt. The paid amount fills items one by one.
app.post('/api/sales/multi', async (req, res) => {
  try {
    const { sale_date, payment, customer_name, phone, address, paid_now, items } = req.body;
    if (!sale_date) return res.status(400).json({ error: 'Sale date is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Add at least one product' });
    for (const it of items) {
      if (!it.product_id) return res.status(400).json({ error: 'Choose a product for every line' });
      if (num(it.qty) <= 0) return res.status(400).json({ error: 'Every quantity must be more than 0' });
      if (num(it.sale_price) <= 0) return res.status(400).json({ error: 'Every sale price must be more than 0' });
    }

    const stats = await productStats();
    // check stock per product (the same product may appear on more than one line)
    const needed = {};
    items.forEach(it => { needed[it.product_id] = (needed[it.product_id] || 0) + num(it.qty); });
    for (const pid of Object.keys(needed)) {
      const prod = stats.find(p => p.id === parseInt(pid, 10));
      if (!prod) return res.status(400).json({ error: 'Product not found' });
      if (needed[pid] > prod.remaining + 0.001) {
        return res.status(400).json({ error: `Only ${prod.remaining} ${prod.unit} in stock for ${prod.name}` });
      }
    }

    const method = payment || 'Cash';
    const total = items.reduce((s, it) => s + num(it.qty) * num(it.sale_price), 0);
    const paid = (paid_now === undefined || paid_now === null || paid_now === '')
      ? (method === 'Credit (Udhaar)' ? 0 : total) : num(paid_now);
    if (paid < 0) return res.status(400).json({ error: 'Received amount cannot be negative' });
    if (paid > total) return res.status(400).json({ error: `Received amount cannot be more than the total (Rs ${total})` });

    if (isSalesman(req)) {
      if (sale_date !== localStamp()) return res.status(400).json({ error: 'Salesman accounts can only record sales for today' });
      const due = total - paid;
      if (due > 0.001 && (!(customer_name || '').trim() || !(phone || '').trim())) {
        return res.status(400).json({ error: 'Udhaar sale needs the customer name AND phone number' });
      }
      if (due > SALESMAN_CREDIT_LIMIT) {
        return res.status(400).json({ error: `Credit above ${fRs(SALESMAN_CREDIT_LIMIT)} needs the admin` });
      }
    }

    const c = await pool.connect();
    let group;
    try {
      await c.query('BEGIN');
      let remainingPay = paid;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const { rows } = await c.query(
          `INSERT INTO sales (product_id, sale_date, qty, sale_price, payment, customer_name, phone, address, receipt_group)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [it.product_id, sale_date, it.qty, it.sale_price, method,
           customer_name || '', phone || '', address || '', group || null]);
        if (i === 0) {
          group = rows[0].id;
          await c.query('UPDATE sales SET receipt_group = $1 WHERE id = $1', [group]);
        }
        // fill this line's payment from what the customer handed over
        const lineTotal = num(it.qty) * num(it.sale_price);
        const alloc = Math.min(remainingPay, lineTotal);
        if (alloc > 0.001) {
          await c.query(
            'INSERT INTO sale_payments (sale_id, pay_date, amount, method) VALUES ($1, $2, $3, $4)',
            [rows[0].id, sale_date, alloc, method === 'Credit (Udhaar)' ? 'Cash' : method]);
          remainingPay -= alloc;
        }
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }

    const nameOf = {}; stats.forEach(p => { nameOf[p.id] = p.name; });
    const itemList = items.map(it => `${num(it.qty)} x ${nameOf[it.product_id]}`).join(', ');
    await logAction(req, 'created', 'sale',
      `Sale KD-${group} saved (${items.length} items): ${itemList} = ${fRs(total)}` +
      (customer_name ? ` to ${customer_name}` : '') +
      ` — received ${fRs(paid)} (${method})${paid < total ? `, due ${fRs(total - paid)}` : ''}`);
    res.json({ ok: true, id: group, items: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Replacements (shop policy: no refunds, exchange within 3 days) ----------
const REPLACE_DAYS = 3;

app.post('/api/sales/:id/replace', async (req, res) => {
  try {
    const { qty, new_product_id, new_price, rep_date, reason } = req.body;
    const R = num(qty);
    if (R <= 0) return res.status(400).json({ error: 'Quantity must be more than 0' });
    if (!rep_date) return res.status(400).json({ error: 'Replacement date is required' });
    if (isSalesman(req) && rep_date !== localStamp()) {
      return res.status(400).json({ error: 'Salesman accounts can only record replacements for today' });
    }
    if (!new_product_id) return res.status(400).json({ error: 'Choose the replacement product' });
    if (num(new_price) <= 0) return res.status(400).json({ error: 'Replacement price must be more than 0' });

    const f = await saleFinances(req.params.id);
    if (!f) return res.status(404).json({ error: 'Sale not found' });

    // eligibility: within 3 days of the sale
    const diffDays = (new Date(rep_date + 'T00:00:00') - new Date(f.sale_date + 'T00:00:00')) / 86400000;
    if (diffDays < 0) return res.status(400).json({ error: 'Replacement date cannot be before the sale date' });
    if (diffDays > REPLACE_DAYS) {
      const last = new Date(new Date(f.sale_date).getTime() + REPLACE_DAYS * 86400000).toISOString().slice(0, 10);
      return res.status(400).json({ error: `Not eligible — replacements are only accepted within ${REPLACE_DAYS} days of the sale (sale was on ${f.sale_date}, last day was ${last})` });
    }
    const effQty = num(f.qty) - num(f.returned);
    if (R > effQty + 0.001) return res.status(400).json({ error: `Only ${effQty} ${f.unit} of this sale can be replaced` });

    const stats = await productStats();
    const B = stats.find(p => p.id === parseInt(new_product_id, 10));
    if (!B) return res.status(400).json({ error: 'Replacement product not found' });
    const sameProduct = B.id === f.product_id;
    if (!sameProduct && R > B.remaining + 0.001) {
      return res.status(400).json({ error: `Only ${B.remaining} ${B.unit} in stock for ${B.name}` });
    }
    // a full-line swap to a different product would leave this sale's old return
    // records pointing at the wrong product — replace less, or the same product
    if (!sameProduct && num(f.returned) > 0 && R >= effQty - 0.001) {
      return res.status(400).json({ error: 'This sale has an old return record on it — replace a smaller quantity, or replace with the same product' });
    }

    // no refunds: the replacement must be worth at least what is being handed back
    const valueBack = R * num(f.sale_price);
    const valueNew = R * num(new_price);
    if (valueNew + 0.001 < valueBack) {
      return res.status(400).json({ error: `No refunds — the replacement must be of equal or higher value (at least ${fRs(valueBack)}). Pick a dearer item or the same one.` });
    }
    const note = `Replaced ${R} ${f.unit} ${f.pname} → ${R} ${B.unit} ${B.name} on ${rep_date}`;

    const c = await pool.connect();
    let newSaleId;
    try {
      await c.query('BEGIN');
      if (R >= effQty - 0.001) {
        // whole line replaced: swap the product/price in place, payments stay as they are
        await c.query('UPDATE sales SET product_id = $1, sale_price = $2, replaced_note = $3 WHERE id = $4',
          [B.id, new_price, note, req.params.id]);
        newSaleId = parseInt(req.params.id, 10);
      } else {
        // part of the line: shrink the original, add a line for the replacement on the same receipt
        await c.query('UPDATE sales SET qty = qty - $1 WHERE id = $2', [R, req.params.id]);
        let group = f.receipt_group;
        if (!group) {
          group = parseInt(req.params.id, 10);
          await c.query('UPDATE sales SET receipt_group = $1 WHERE id = $1', [group]);
        }
        const ins = await c.query(
          `INSERT INTO sales (product_id, sale_date, qty, sale_price, payment, customer_name, phone, address, receipt_group, replaced_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [B.id, f.sale_date, R, new_price, f.payment, f.customer_name, f.phone, f.address, group, note]);
        newSaleId = ins.rows[0].id;
        // carry the money already paid for the returned goods over to the replacement line
        let toMove = Math.min(valueBack, num(f.paid) - num(f.refunded));
        const pays = await c.query('SELECT id, amount, method, pay_date FROM sale_payments WHERE sale_id = $1 ORDER BY id DESC', [req.params.id]);
        for (const p of pays.rows) {
          if (toMove <= 0.001) break;
          const move = Math.min(num(p.amount), toMove);
          if (move >= num(p.amount) - 0.001) await c.query('DELETE FROM sale_payments WHERE id = $1', [p.id]);
          else await c.query('UPDATE sale_payments SET amount = amount - $1 WHERE id = $2', [move, p.id]);
          await c.query('INSERT INTO sale_payments (sale_id, pay_date, amount, method) VALUES ($1, $2, $3, $4)',
            [newSaleId, p.pay_date, move, p.method]);
          toMove -= move;
        }
      }
      await c.query(
        `INSERT INTO replacements (sale_id, new_sale_id, rep_date, qty, from_product, from_price, to_product, to_price, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [req.params.id, newSaleId, rep_date, R, f.pname, f.sale_price, B.name, new_price, reason || '']);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }

    const extra = valueNew - valueBack;
    await logAction(req, 'return', 'sale',
      `Replacement on KD-${f.receipt_group || req.params.id}: ${R} ${f.unit} ${f.pname} → ${R} ${B.unit} ${B.name} @ ${fRs(new_price)}` +
      (f.customer_name ? ` for ${f.customer_name}` : '') +
      (extra > 0.001 ? ` — customer pays extra ${fRs(extra)}` : ' — equal value, no money moved') +
      (reason ? ` — ${reason}` : ''));
    res.json({ ok: true, newSaleId, extra });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/replacements', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.sale_id, r.new_sale_id, to_char(r.rep_date, 'YYYY-MM-DD') AS rep_date,
             r.qty, r.from_product, r.from_price, r.to_product, r.to_price, r.reason,
             s.customer_name, s.phone, s.receipt_group
      FROM replacements r JOIN sales s ON s.id = r.sale_id
      ORDER BY r.rep_date DESC, r.id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a later payment received from a customer for a sale
app.post('/api/sales/:id/payments', async (req, res) => {
  try {
    const { amount, pay_date, method } = req.body;
    if (num(amount) <= 0) return res.status(400).json({ error: 'Amount must be more than 0' });
    if (!pay_date) return res.status(400).json({ error: 'Payment date is required' });
    if (isSalesman(req) && pay_date !== localStamp()) {
      return res.status(400).json({ error: 'Salesman accounts can only record payments for today' });
    }
    const f = await saleFinances(req.params.id);
    if (!f) return res.status(404).json({ error: 'Sale not found' });
    const remaining = (num(f.qty) - num(f.returned)) * num(f.sale_price) - (num(f.paid) - num(f.refunded));
    if (num(amount) > remaining + 0.001) {
      return res.status(400).json({ error: `Only Rs ${remaining} is remaining on this sale` });
    }
    await pool.query(
      'INSERT INTO sale_payments (sale_id, pay_date, amount, method) VALUES ($1, $2, $3, $4)',
      [req.params.id, pay_date, amount, method || 'Cash']);
    await logAction(req, 'payment', 'sale',
      `Received ${fRs(amount)} (${method || 'Cash'}) on sale KD-${req.params.id} — ${fRs(remaining - num(amount))} still due`);
    res.json({ ok: true, remaining: remaining - num(amount) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sales/:id', async (req, res) => {
  try {
    const info = await pool.query(`
      SELECT to_char(s.sale_date, 'DD-Mon-YYYY') d, s.qty, s.sale_price, s.customer_name, s.payment,
             p.name, p.unit,
             COALESCE((SELECT SUM(amount) FROM sale_payments WHERE sale_id = s.id), 0) paid,
             COALESCE((SELECT SUM(qty) FROM sale_returns WHERE sale_id = s.id), 0) returned,
             COALESCE((SELECT SUM(refund) FROM sale_returns WHERE sale_id = s.id), 0) refunded
      FROM sales s JOIN products p ON p.id = s.product_id WHERE s.id = $1`, [req.params.id]);
    await pool.query('DELETE FROM sales WHERE id = $1', [req.params.id]);
    if (info.rows.length) {
      const i = info.rows[0];
      const effTotal = (num(i.qty) - num(i.returned)) * num(i.sale_price);
      const due = effTotal - (num(i.paid) - num(i.refunded));
      await logAction(req, 'deleted', 'sale',
        `Sale KD-${req.params.id} DELETED: [${i.d}] ${num(i.qty)} ${i.unit} ${i.name} @ ${fRs(i.sale_price)} = ${fRs(effTotal)}` +
        (i.customer_name ? ` to ${i.customer_name}` : '') +
        (num(i.returned) > 0 ? ` (${num(i.returned)} had been returned)` : '') +
        ` — had received ${fRs(num(i.paid) - num(i.refunded))}${due > 0.001 ? `, ${fRs(due)} was still due` : ''}`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Dashboard ----------
app.get('/api/dashboard', async (req, res) => {
  try {
    const stats = await productStats();
    const stockValue = stats.reduce((a, p) => a + p.stockValue, 0);
    const totalProfit = stats.reduce((a, p) => a + p.profit, 0);
    const totalSales = stats.reduce((a, p) => a + p.soldAmt, 0);
    const totalPurchases = stats.reduce((a, p) => a + p.purchasedAmt, 0);

    const today = await pool.query(`
      SELECT COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * s.sale_price), 0) amt, COUNT(*) n
      FROM sales s
      LEFT JOIN (SELECT sale_id, SUM(qty) rqty FROM sale_returns GROUP BY sale_id) r ON r.sale_id = s.id
      WHERE s.sale_date = CURRENT_DATE`);
    const expensesQ = await pool.query('SELECT COALESCE(SUM(amount), 0) total FROM expenses');
    const totalExpenses = num(expensesQ.rows[0].total);
    // Received = actual payment transactions minus refunds given on returns
    const received = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN method = 'Cash' THEN amount END), 0) cash,
        COALESCE(SUM(CASE WHEN method <> 'Cash' THEN amount END), 0) bank,
        COALESCE(SUM(amount), 0) total
      FROM (
        SELECT method, amount FROM sale_payments
        UNION ALL
        SELECT method, -refund FROM sale_returns WHERE refund > 0
      ) t`);
    const purchasePaid = await pool.query('SELECT COALESCE(SUM(amount), 0) paid FROM purchase_payments');
    const pay = {
      cash: num(received.rows[0].cash),
      bank: num(received.rows[0].bank),
      credit: totalSales - num(received.rows[0].total),          // still owed by customers
      payable: totalPurchases - num(purchasePaid.rows[0].paid)   // still owed to suppliers
    };

    const last7 = await pool.query(`
      WITH ret AS (
        SELECT sale_id, SUM(qty) rqty FROM sale_returns GROUP BY sale_id
      )
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
             COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * s.sale_price), 0) amt,
             COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * (s.sale_price - ${SALE_COST_SQL})), 0) profit
      FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') d
      LEFT JOIN sales s ON s.sale_date = d::date
      LEFT JOIN ret r ON r.sale_id = s.id
      GROUP BY d ORDER BY d`);

    const sold = stats.filter(p => p.soldQty > 0);
    const bestSellers = sold.slice().sort((a, b) => b.profit - a.profit).slice(0, 3)
      .map(p => ({ name: p.name, category: p.category, soldQty: p.soldQty, unit: p.unit, profit: p.profit }));
    const slowMovers = stats.filter(p => p.remaining > 0)
      .sort((a, b) => a.soldQty - b.soldQty || b.stockValue - a.stockValue).slice(0, 3)
      .map(p => ({ name: p.name, category: p.category, soldQty: p.soldQty, unit: p.unit, remaining: p.remaining, stockValue: p.stockValue }));

    res.json({
      stockValue, totalProfit, profitShare: totalProfit * 0.05,
      totalExpenses, netProfit: totalProfit - totalExpenses,
      bestSellers, slowMovers,
      todaySales: num(today.rows[0].amt), todayCount: parseInt(today.rows[0].n, 10),
      cashReceived: pay.cash, bankReceived: pay.bank,
      creditOutstanding: pay.credit, supplierPayable: pay.payable,
      totalSales, totalPurchases,
      last7: last7.rows.map(r => ({ day: r.day, amt: num(r.amt), profit: num(r.profit) })),
      lowStock: stats.filter(p => p.purchasedQty > 0 && p.remaining <= 10)
        .map(p => ({ name: p.name, category: p.category, remaining: p.remaining, unit: p.unit }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Chart data (monthly overview or daily detail of one month) ----------
app.get('/api/chart', async (req, res) => {
  try {
    // profit per sale = qty x (sale price - the rate in force on the sale's date)
    const RET_CTE = `
      WITH ret AS (
        SELECT sale_id, SUM(qty) rqty FROM sale_returns GROUP BY sale_id
      )`;
    if (req.query.view === 'months') {
      // one bar-pair per month, from the first recorded sale to now
      const { rows } = await pool.query(`${RET_CTE}
        SELECT to_char(m, 'YYYY-MM') AS label,
               COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * s.sale_price), 0) amt,
               COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * (s.sale_price - ${SALE_COST_SQL})), 0) profit
        FROM generate_series(
          date_trunc('month', COALESCE((SELECT MIN(sale_date) FROM sales), CURRENT_DATE)),
          date_trunc('month', CURRENT_DATE), '1 month') m
        LEFT JOIN sales s ON date_trunc('month', s.sale_date) = m
        LEFT JOIN ret r ON r.sale_id = s.id
        GROUP BY m ORDER BY m`);
      return res.json(rows.map(r => ({ label: r.label, amt: num(r.amt), profit: num(r.profit) })));
    }
    // daily view for one month (?month=YYYY-MM)
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const { rows } = await pool.query(`${RET_CTE}
      SELECT to_char(d, 'YYYY-MM-DD') AS label,
             COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * s.sale_price), 0) amt,
             COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * (s.sale_price - ${SALE_COST_SQL})), 0) profit
      FROM generate_series(
        to_date($1, 'YYYY-MM'),
        (to_date($1, 'YYYY-MM') + interval '1 month' - interval '1 day')::date, '1 day') d
      LEFT JOIN sales s ON s.sale_date = d::date
      LEFT JOIN ret r ON r.sale_id = s.id
      GROUP BY d ORDER BY d`, [month]);
    res.json(rows.map(r => ({ label: r.label, amt: num(r.amt), profit: num(r.profit) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Full analytics: month-by-month sales, profit, purchases, expenses ----------
app.get('/api/analytics', async (req, res) => {
  try {
    // day-by-day mode: ?from=YYYY-MM-DD&to=YYYY-MM-DD
    if (req.query.from && req.query.to) {
      const { from, to } = req.query;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
      }
      const { rows } = await pool.query(`
        WITH ret AS (SELECT sale_id, SUM(qty) rqty FROM sale_returns GROUP BY sale_id),
        days AS (SELECT generate_series($1::date, $2::date, '1 day') AS d)
        SELECT to_char(days.d, 'YYYY-MM-DD') AS label,
          (SELECT COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * s.sale_price), 0)
             FROM sales s LEFT JOIN ret r ON r.sale_id = s.id WHERE s.sale_date = days.d) AS sales,
          (SELECT COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * (s.sale_price - ${SALE_COST_SQL})), 0)
             FROM sales s LEFT JOIN ret r ON r.sale_id = s.id WHERE s.sale_date = days.d) AS profit,
          (SELECT COALESCE(SUM(pu.qty * pu.unit_price + pu.transport), 0)
             FROM purchases pu WHERE pu.purchase_date = days.d) AS purchases,
          (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE e.exp_date = days.d) AS expenses
        FROM days ORDER BY days.d`, [from, to]);
      return res.json(rows.map(r => ({
        label: r.label, sales: num(r.sales), profit: num(r.profit),
        purchases: num(r.purchases), expenses: num(r.expenses),
        net: num(r.profit) - num(r.expenses)
      })));
    }

    const { rows } = await pool.query(`
      WITH ret AS (
        SELECT sale_id, SUM(qty) rqty FROM sale_returns GROUP BY sale_id
      ), months AS (
        SELECT generate_series(
          date_trunc('month', LEAST(
            COALESCE((SELECT MIN(sale_date) FROM sales), CURRENT_DATE),
            COALESCE((SELECT MIN(purchase_date) FROM purchases), CURRENT_DATE),
            COALESCE((SELECT MIN(exp_date) FROM expenses), CURRENT_DATE))),
          date_trunc('month', CURRENT_DATE), '1 month') AS m
      )
      SELECT to_char(months.m, 'YYYY-MM') AS label,
        (SELECT COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * s.sale_price), 0)
           FROM sales s LEFT JOIN ret r ON r.sale_id = s.id
           WHERE date_trunc('month', s.sale_date) = months.m) AS sales,
        (SELECT COALESCE(SUM((s.qty - COALESCE(r.rqty, 0)) * (s.sale_price - ${SALE_COST_SQL})), 0)
           FROM sales s LEFT JOIN ret r ON r.sale_id = s.id
           WHERE date_trunc('month', s.sale_date) = months.m) AS profit,
        (SELECT COALESCE(SUM(pu.qty * pu.unit_price + pu.transport), 0)
           FROM purchases pu WHERE date_trunc('month', pu.purchase_date) = months.m) AS purchases,
        (SELECT COALESCE(SUM(e.amount), 0)
           FROM expenses e WHERE date_trunc('month', e.exp_date) = months.m) AS expenses
      FROM months ORDER BY months.m`);
    res.json(rows.map(r => ({
      label: r.label, sales: num(r.sales), profit: num(r.profit),
      purchases: num(r.purchases), expenses: num(r.expenses),
      net: num(r.profit) - num(r.expenses)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Full Register (18 columns) ----------
app.get('/api/register', async (req, res) => {
  try {
    const costIndex = await buildCostIndex();

    const purchases = await pool.query(`
      SELECT pu.id, pu.product_id, to_char(pu.purchase_date, 'YYYY-MM-DD') AS date,
             pu.qty, pu.unit_price, pu.transport, pu.created_at,
             p.name AS product_name, p.category, p.unit, p.description
      FROM purchases pu JOIN products p ON p.id = pu.product_id`);
    const sales = await pool.query(`
      SELECT s.id, s.product_id, to_char(s.sale_date, 'YYYY-MM-DD') AS date,
             s.qty, s.sale_price, s.payment,
             s.customer_name, s.phone, s.address, s.created_at,
             p.name AS product_name, p.category, p.unit, p.description,
             COALESCE(sp.paid, 0) AS paid,
             COALESCE(sr.rqty, 0) AS returned,
             COALESCE(sr.refunded, 0) AS refunded
      FROM sales s JOIN products p ON p.id = s.product_id
      LEFT JOIN (SELECT sale_id, SUM(amount) paid FROM sale_payments GROUP BY sale_id) sp
        ON sp.sale_id = s.id
      LEFT JOIN (SELECT sale_id, SUM(qty) rqty, SUM(refund) refunded FROM sale_returns GROUP BY sale_id) sr
        ON sr.sale_id = s.id`);

    let entries = [
      ...purchases.rows.map(r => ({ kind: 'purchase', ...r })),
      ...sales.rows.map(r => ({ kind: 'sale', ...r }))
    ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Running totals per product, in entry order
    const purchasedSoFar = {}, soldSoFar = {};
    const rows = entries.map((e, i) => {
      const pid = e.product_id;
      purchasedSoFar[pid] = purchasedSoFar[pid] || 0;
      soldSoFar[pid] = soldSoFar[pid] || 0;

      const row = {
        sr: i + 1,
        kind: e.kind,
        rowId: e.id,
        product_id: pid,
        // col 1: description
        description: e.product_name, category: e.category, unit: e.unit,
        // purchase side (cols 2-6)
        pDate: null, pQty: null, pUnitPrice: null, pTotal: null, totalStock: null,
        // sale side (cols 7-12)
        sDate: null, sQty: null, sPrice: null, sTotal: null, payment: null, profit: null,
        // customer (cols 13-15)
        name: null, phone: null, address: null,
        // cols 16-18
        remainingStock: null, profitShare: null, stockPrice: null
      };

      const cost = costIndex.costAt(pid, e.date); // the rate in force on this entry's date
      if (e.kind === 'purchase') {
        purchasedSoFar[pid] += num(e.qty);
        row.pDate = e.date; row.pQty = num(e.qty); row.pUnitPrice = num(e.unit_price);
        row.pTotal = num(e.qty) * num(e.unit_price) + num(e.transport); // total includes transport
      } else {
        const effQty = num(e.qty) - num(e.returned);
        soldSoFar[pid] += effQty;
        row.sDate = e.date; row.sQty = effQty; row.sPrice = num(e.sale_price);
        row.sReturned = num(e.returned);
        row.sTotal = effQty * num(e.sale_price);
        row.payment = e.payment;
        row.sDue = row.sTotal - (num(e.paid) - num(e.refunded));
        row.profit = effQty * (num(e.sale_price) - cost);
        row.name = e.customer_name; row.phone = e.phone; row.address = e.address;
        row.profitShare = row.profit * 0.05;
      }
      row.totalStock = purchasedSoFar[pid];
      row.remainingStock = purchasedSoFar[pid] - soldSoFar[pid];
      row.stockPrice = row.remainingStock * cost;
      return row;
    });

    // Filters apply to display only (running totals already computed over full history)
    let out = rows;
    const { product_id, from, to } = req.query;
    if (product_id) out = out.filter(r => r.product_id === parseInt(product_id, 10));
    // dates are 'YYYY-MM-DD' strings, so plain string comparison is exact
    const dateOf = r => (r.pDate || r.sDate);
    if (from) out = out.filter(r => dateOf(r) >= from);
    if (to) out = out.filter(r => dateOf(r) <= to);

    res.json(out.reverse()); // newest first, like the screenshots
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Expenses ----------
app.get('/api/expenses', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, to_char(exp_date, 'YYYY-MM-DD') AS exp_date, category, description, amount
      FROM expenses ORDER BY exp_date DESC, id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { exp_date, category, description, amount } = req.body;
    if (!exp_date) return res.status(400).json({ error: 'Date is required' });
    if (num(amount) <= 0) return res.status(400).json({ error: 'Amount must be more than 0' });
    const { rows } = await pool.query(
      'INSERT INTO expenses (exp_date, category, description, amount) VALUES ($1, $2, $3, $4) RETURNING *',
      [exp_date, category || 'Other', description || '', amount]);
    await logAction(req, 'created', 'expense',
      `Expense saved: ${fRs(amount)} — ${category || 'Other'}${description ? ` (${description})` : ''}`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Editing an expense can only change the date, category and description —
// the amount is locked once recorded.
app.put('/api/expenses/:id', async (req, res) => {
  try {
    const { exp_date, category, description } = req.body;
    if (!exp_date) return res.status(400).json({ error: 'Date is required' });
    const oldQ = await pool.query(
      `SELECT to_char(exp_date, 'YYYY-MM-DD') AS exp_date, category, description, amount FROM expenses WHERE id = $1`,
      [req.params.id]);
    if (!oldQ.rows.length) return res.status(404).json({ error: 'Expense not found' });
    const o = oldQ.rows[0];
    const { rows } = await pool.query(
      'UPDATE expenses SET exp_date = $1, category = $2, description = $3 WHERE id = $4 RETURNING *',
      [exp_date, category || 'Other', description || '', req.params.id]);
    const changes = [];
    if (o.exp_date !== exp_date) changes.push(`date ${o.exp_date} → ${exp_date}`);
    if (o.category !== (category || 'Other')) changes.push(`category ${o.category} → ${category || 'Other'}`);
    if (o.description !== (description || '')) changes.push(`description "${o.description}" → "${description || ''}"`);
    if (changes.length) {
      await logAction(req, 'edited', 'expense', `Expense (${fRs(o.amount)}) edited — ${changes.join(', ')}`);
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const info = await pool.query(
      `SELECT to_char(exp_date, 'DD-Mon-YYYY') d, category, description, amount FROM expenses WHERE id = $1`,
      [req.params.id]);
    await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    if (info.rows.length) {
      const i = info.rows[0];
      await logAction(req, 'deleted', 'expense',
        `Expense DELETED: [${i.d}] ${fRs(i.amount)} — ${i.category}${i.description ? ` (${i.description})` : ''}`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Partners ----------
// A product's profit is split between partners in proportion to what each invested in that product
async function getPartnersData() {
    const stats = await productStats();
    const profitOf = {}, nameOf = {}, catOf = {};
    stats.forEach(p => { profitOf[p.id] = p.profit; nameOf[p.id] = p.name; catOf[p.id] = p.category; });

    const partners = await pool.query('SELECT * FROM partners ORDER BY id');
    const inv = await pool.query(`
      SELECT partner_id, product_id, SUM(amount) amt
      FROM investments GROUP BY partner_id, product_id`);

    const productTotal = {}; // total invested per product (all partners)
    inv.rows.forEach(r => { productTotal[r.product_id] = (productTotal[r.product_id] || 0) + num(r.amt); });

    const out = partners.rows.map(p => {
      const items = inv.rows.filter(r => r.partner_id === p.id).map(r => {
        const invested = num(r.amt);
        const share = productTotal[r.product_id] > 0 ? invested / productTotal[r.product_id] : 0;
        return {
          product_id: r.product_id,
          product: nameOf[r.product_id] || '(deleted product)',
          category: catOf[r.product_id] || '',
          invested,
          sharePct: share * 100,
          profit: share * (profitOf[r.product_id] || 0)
        };
      }).sort((a, b) => b.invested - a.invested);
      return {
        id: p.id, name: p.name,
        active: p.active !== false,
        leftDate: (() => {
          if (!p.left_date) return null;
          const d = new Date(p.left_date);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })(),
        finalInvested: num(p.final_invested), finalProfit: num(p.final_profit),
        finalExpenseShare: num(p.final_expense_share), finalNet: num(p.final_net),
        totalInvested: items.reduce((s, x) => s + x.invested, 0),
        totalProfit: items.reduce((s, x) => s + x.profit, 0),
        items
      };
    });

    // expenses are shared between partners in proportion to their investment
    const expQ = await pool.query('SELECT COALESCE(SUM(amount), 0) t FROM expenses');
    const expensesTotal = num(expQ.rows[0].t);
    const totalInvestedAll = out.reduce((s, p) => s + p.totalInvested, 0);
    out.forEach(p => {
      p.investShare = totalInvestedAll > 0 ? p.totalInvested / totalInvestedAll : 0;
      p.expenseShare = p.investShare * expensesTotal;
      p.netAfterExpenses = p.totalProfit - p.expenseShare;
    });
    return out;
}

app.get('/api/partners', async (req, res) => {
  try { res.json(await getPartnersData()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// A partner leaves: their final figures are frozen onto their record forever,
// then their investment rows are released so shares pass to the remaining partners.
app.post('/api/partners/:id/leave', async (req, res) => {
  try {
    const all = await getPartnersData();
    const p = all.find(x => x.id === parseInt(req.params.id, 10));
    if (!p) return res.status(404).json({ error: 'Partner not found' });
    if (!p.active) return res.status(400).json({ error: 'This partner has already left' });

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE partners SET active = false, left_date = CURRENT_DATE,
           final_invested = $1, final_profit = $2, final_expense_share = $3, final_net = $4
         WHERE id = $5`,
        [p.totalInvested, p.totalProfit, p.expenseShare, p.netAfterExpenses, p.id]);
      await c.query('DELETE FROM investments WHERE partner_id = $1', [p.id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }

    await logAction(req, 'edited', 'partner',
      `Partner LEFT the business: ${p.name} — final record frozen: invested ${fRs(p.totalInvested)}, ` +
      `profit ${fRs(p.totalProfit)}, expense share ${fRs(p.expenseShare)}, net ${fRs(p.netAfterExpenses)}. ` +
      `Their investment share passes to the remaining partners.`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/partners', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Partner name cannot be empty' });
    const { rows } = await pool.query('INSERT INTO partners (name) VALUES ($1) RETURNING *', [name]);
    await logAction(req, 'created', 'partner', `Partner added: ${name}`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/partners/:id', async (req, res) => {
  try {
    const info = await pool.query(`
      SELECT pa.name, COALESCE(SUM(i.amount), 0) invested, COUNT(i.id) n
      FROM partners pa LEFT JOIN investments i ON i.partner_id = pa.id
      WHERE pa.id = $1 GROUP BY pa.id`, [req.params.id]);
    await pool.query('DELETE FROM partners WHERE id = $1', [req.params.id]);
    if (info.rows.length) {
      const i = info.rows[0];
      await logAction(req, 'deleted', 'partner',
        `Partner DELETED: ${i.name} — ${i.n} investment record(s) totalling ${fRs(i.invested)} removed with them`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/partners/:id', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Partner name cannot be empty' });
    const oldQ = await pool.query('SELECT name FROM partners WHERE id = $1', [req.params.id]);
    if (!oldQ.rows.length) return res.status(404).json({ error: 'Partner not found' });
    const { rows } = await pool.query('UPDATE partners SET name = $1 WHERE id = $2 RETURNING *', [name, req.params.id]);
    if (oldQ.rows[0].name !== name) {
      await logAction(req, 'edited', 'partner', `Partner renamed — "${oldQ.rows[0].name}" → "${name}"`);
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/investments', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.id, i.partner_id, i.product_id, to_char(i.inv_date, 'YYYY-MM-DD') AS inv_date, i.amount,
             pa.name AS partner_name, pr.name AS product_name, pr.category
      FROM investments i
      JOIN partners pa ON pa.id = i.partner_id
      JOIN products pr ON pr.id = i.product_id
      ORDER BY i.inv_date DESC, i.id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/investments', async (req, res) => {
  try {
    const { partner_id, product_id, inv_date, amount } = req.body;
    if (!partner_id) return res.status(400).json({ error: 'Choose a partner' });
    if (!product_id) return res.status(400).json({ error: 'Choose a product' });
    if (!inv_date) return res.status(400).json({ error: 'Investment date is required' });
    if (num(amount) <= 0) return res.status(400).json({ error: 'Amount must be more than 0' });
    const { rows } = await pool.query(
      'INSERT INTO investments (partner_id, product_id, inv_date, amount) VALUES ($1, $2, $3, $4) RETURNING *',
      [partner_id, product_id, inv_date, amount]);
    const names = await pool.query(
      'SELECT (SELECT name FROM partners WHERE id = $1) pa, (SELECT name FROM products WHERE id = $2) pr',
      [partner_id, product_id]);
    await logAction(req, 'created', 'investment',
      `${names.rows[0].pa} invested ${fRs(amount)} in ${names.rows[0].pr}`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One investment spread over several products (or all): the amount is split
// equally, one row per product, so the per-product profit shares stay exact.
app.post('/api/investments/batch', async (req, res) => {
  try {
    const { partner_id, product_ids, inv_date, amount } = req.body;
    if (!partner_id) return res.status(400).json({ error: 'Choose a partner' });
    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({ error: 'Choose at least one product' });
    }
    if (!inv_date) return res.status(400).json({ error: 'Investment date is required' });
    if (num(amount) <= 0) return res.status(400).json({ error: 'Amount must be more than 0' });

    const n = product_ids.length;
    const per = Math.round((num(amount) / n) * 100) / 100;
    const last = Math.round((num(amount) - per * (n - 1)) * 100) / 100; // keeps the sum exact

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < n; i++) {
        await c.query(
          'INSERT INTO investments (partner_id, product_id, inv_date, amount) VALUES ($1, $2, $3, $4)',
          [partner_id, product_ids[i], inv_date, i === n - 1 ? last : per]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
    const pn = await pool.query('SELECT name FROM partners WHERE id = $1', [partner_id]);
    await logAction(req, 'created', 'investment',
      `${pn.rows.length ? pn.rows[0].name : 'Partner'} invested ${fRs(amount)}` +
      (n > 1 ? ` across ${n} products (~${fRs(per)} each)` : ''));
    res.json({ ok: true, products: n, perProduct: per });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/investments/:id', async (req, res) => {
  try {
    const info = await pool.query(`
      SELECT i.amount, pa.name AS partner, pr.name AS product
      FROM investments i JOIN partners pa ON pa.id = i.partner_id JOIN products pr ON pr.id = i.product_id
      WHERE i.id = $1`, [req.params.id]);
    await pool.query('DELETE FROM investments WHERE id = $1', [req.params.id]);
    if (info.rows.length) {
      const i = info.rows[0];
      await logAction(req, 'deleted', 'investment',
        `Investment DELETED: ${i.partner}'s ${fRs(i.amount)} in ${i.product}`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Activity log (append-only: view and export, never edit or delete) ----------
// The Logs section has its own password on top of the normal login.
const LOGS_PASSWORD = 'kisanlogs';
const logsGuard = (req, res, next) =>
  req.session.logsUnlocked ? next() : res.status(401).json({ error: 'Logs are locked' });

app.get('/api/logs/status', (req, res) => res.json({ unlocked: !!req.session.logsUnlocked }));

app.post('/api/logs/unlock', async (req, res) => {
  if (String(req.body.password || '') === LOGS_PASSWORD) {
    req.session.logsUnlocked = true;
    await logAction(req, 'login', 'logs', 'Logs section unlocked');
    return res.json({ ok: true });
  }
  await logAction(req, 'password', 'logs', 'WRONG password entered for the Logs section');
  res.status(401).json({ error: 'Wrong logs password' });
});

app.get('/api/logs', logsGuard, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '1000', 10) || 1000, 5000);
    const where = [];
    const params = [];
    if (req.query.hours) {
      params.push(parseFloat(req.query.hours) || 3);
      where.push(`ts >= now() - ($${params.length} || ' hours')::interval`);
    } else {
      if (req.query.from) { params.push(req.query.from); where.push(`ts >= $${params.length}::timestamptz`); }
      if (req.query.to) { params.push(req.query.to); where.push(`ts <= $${params.length}::timestamptz`); }
    }
    params.push(limit);
    const { rows } = await pool.query(`
      SELECT id, to_char(ts, 'DD-Mon-YYYY') AS d, to_char(ts, 'HH12:MI AM') AS t,
             username, action, entity, details
      FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT $${params.length}`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs/export.csv', logsGuard, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT to_char(ts, 'DD-Mon-YYYY') AS d, to_char(ts, 'HH12:MI AM') AS t,
             username, action, details
      FROM logs ORDER BY id`);
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = 'Date,Time,User,Action,Details\r\n' +
      rows.map(r => [q(r.d), q(r.t), q(r.username), q(r.action), q(r.details)].join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kisan-depot-logs-${localStamp()}.csv"`);
    res.send('\uFEFF' + csv); // BOM so Excel opens Urdu/special characters correctly
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PDF export: a styled report rendered through Edge's print engine
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function findEdge() {
  for (const p of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(p)) return p;
  return null;
}

app.get('/api/logs/export.pdf', logsGuard, async (req, res) => {
  try {
    const edge = findEdge();
    if (!edge) return res.status(500).json({ error: 'PDF export needs Microsoft Edge installed' });

    const { rows } = await pool.query(`
      SELECT to_char(ts, 'DD-Mon-YYYY') AS d, to_char(ts, 'HH12:MI AM') AS t,
             username, action, details
      FROM logs ORDER BY id DESC`);

    const BADGE = {
      created: ['Saved', '#e7f6ec', '#15803d'], deleted: ['Deleted', '#fdecec', '#b91c1c'],
      edited: ['Edited', '#f0ebfc', '#6d28d9'], payment: ['Payment', '#fdf3d7', '#b45309'],
      return: ['Return', '#e3effd', '#1d4ed8'], login: ['Login', '#eef1f4', '#475569'],
      password: ['Password', '#eef1f4', '#475569'], restore: ['Restore', '#eef1f4', '#475569']
    };
    const body = rows.map(r => {
      const [label, bg, fg] = BADGE[r.action] || [r.action, '#eef1f4', '#475569'];
      return `<tr>
        <td class="nw">${escHtml(r.d)}</td><td class="nw">${escHtml(r.t)}</td>
        <td class="nw">${escHtml(r.username)}</td>
        <td class="nw"><span class="pill" style="background:${bg};color:${fg}">${label}</span></td>
        <td>${escHtml(r.details)}</td></tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      @page { size: A4; margin: 14mm 12mm; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: "Segoe UI", Arial, sans-serif; color: #1e1b2e; font-size: 10.5px; }
      .head { display: flex; justify-content: space-between; align-items: flex-end;
              border-bottom: 3px solid #2a1b52; padding-bottom: 10px; margin-bottom: 14px; }
      h1 { font-size: 22px; color: #2a1b52; }
      .sub { color: #666; font-size: 11px; margin-top: 3px; }
      .meta { text-align: right; color: #666; font-size: 10.5px; line-height: 1.6; }
      table { width: 100%; border-collapse: collapse; }
      thead th { background: #2a1b52; color: #fff; text-align: left; padding: 6px 8px;
                 font-size: 9.5px; text-transform: uppercase; letter-spacing: .6px; }
      tbody td { padding: 5.5px 8px; border-bottom: 1px solid #e8e4f2; vertical-align: top; line-height: 1.45; }
      tbody tr:nth-child(even) td { background: #f8f6fd; }
      td.nw { white-space: nowrap; }
      .pill { display: inline-block; padding: 1.5px 9px; border-radius: 999px; font-weight: 600; font-size: 9.5px; }
      .foot { margin-top: 12px; color: #999; font-size: 9.5px; text-align: center; }
    </style></head><body>
      <div class="head">
        <div><h1>Kisan Depot — Activity Log</h1>
        <div class="sub">Fertilizers • Seeds • Pesticides</div></div>
        <div class="meta">Exported: ${localStamp()}<br>${rows.length} entries (newest first)</div>
      </div>
      <table><thead><tr><th>Date</th><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>${body}</tbody></table>
      <div class="foot">This log is append-only — entries cannot be edited or removed inside Kisan Depot.</div>
    </body></html>`;

    const stamp = Date.now();
    const tmpHtml = path.join(os.tmpdir(), `kd-logs-${stamp}.html`);
    const tmpPdf = path.join(os.tmpdir(), `kd-logs-${stamp}.pdf`);
    fs.writeFileSync(tmpHtml, html);

    const { execFile } = require('child_process');
    execFile(edge, ['--headless', '--disable-gpu', '--no-pdf-header-footer',
      `--print-to-pdf=${tmpPdf}`, 'file:///' + tmpHtml.replace(/\\/g, '/')],
      { timeout: 60000 }, err => {
        try {
          if (err || !fs.existsSync(tmpPdf)) {
            res.status(500).json({ error: 'PDF generation failed — try the CSV export instead' });
          } else {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="kisan-depot-logs-${localStamp()}.pdf"`);
            res.send(fs.readFileSync(tmpPdf));
          }
        } finally {
          try { fs.unlinkSync(tmpHtml); } catch {}
          try { fs.unlinkSync(tmpPdf); } catch {}
        }
      });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Backup ----------
// local date, not UTC — otherwise the stamp is a day behind before 5 a.m.
const localStamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function buildBackup() {
  // dates are exported as plain YYYY-MM-DD text so a backup restores identically
  // on any computer, whatever its timezone is set to
  const [products, purchases, sales, salePayments, purchasePayments, partners, investments, expenses, saleReturns, logs, replacements] = await Promise.all([
    pool.query('SELECT * FROM products ORDER BY id'),
    pool.query(`SELECT id, product_id, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, qty, unit_price, transport, created_at FROM purchases ORDER BY id`),
    pool.query(`SELECT id, product_id, to_char(sale_date, 'YYYY-MM-DD') AS sale_date, qty, sale_price, payment, customer_name, phone, address, receipt_group, replaced_note, created_at FROM sales ORDER BY id`),
    pool.query(`SELECT id, sale_id, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, amount, method, created_at FROM sale_payments ORDER BY id`),
    pool.query(`SELECT id, purchase_id, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, amount, method, created_at FROM purchase_payments ORDER BY id`),
    pool.query(`SELECT id, name, active, to_char(left_date, 'YYYY-MM-DD') AS left_date, final_invested, final_profit, final_expense_share, final_net, created_at FROM partners ORDER BY id`),
    pool.query(`SELECT id, partner_id, product_id, to_char(inv_date, 'YYYY-MM-DD') AS inv_date, amount, created_at FROM investments ORDER BY id`),
    pool.query(`SELECT id, to_char(exp_date, 'YYYY-MM-DD') AS exp_date, category, description, amount, created_at FROM expenses ORDER BY id`),
    pool.query(`SELECT id, sale_id, to_char(return_date, 'YYYY-MM-DD') AS return_date, qty, refund, method, reason, created_at FROM sale_returns ORDER BY id`),
    pool.query('SELECT * FROM logs ORDER BY id'),
    pool.query(`SELECT id, sale_id, new_sale_id, to_char(rep_date, 'YYYY-MM-DD') AS rep_date, qty, from_product, from_price, to_product, to_price, reason, created_at FROM replacements ORDER BY id`)
  ]);
  return {
    exportedAt: new Date().toISOString(),
    products: products.rows, purchases: purchases.rows, sales: sales.rows,
    sale_payments: salePayments.rows, purchase_payments: purchasePayments.rows,
    partners: partners.rows, investments: investments.rows, expenses: expenses.rows,
    sale_returns: saleReturns.rows, logs: logs.rows, replacements: replacements.rows
  };
}

app.get('/api/backup', async (req, res) => {
  try {
    res.setHeader('Content-Disposition', `attachment; filename="kisan-depot-backup-${localStamp()}.json"`);
    res.json(await buildBackup());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Auto-backup: on start and every hour, one file per day, keep last 30 ----------
const BACKUP_DIR = path.join(__dirname, 'backups');

function pruneBackups(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => /^kisan-depot-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  files.slice(0, Math.max(0, files.length - 30))
    .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
}

async function autoBackup() {
  try {
    const json = JSON.stringify(await buildBackup(), null, 2);
    const name = `kisan-depot-backup-${localStamp()}.json`;

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, name), json);
    pruneBackups(BACKUP_DIR);

    // second copy into OneDrive when available, so backups survive this PC
    const oneDrive = path.join(os.homedir(), 'OneDrive');
    if (fs.existsSync(oneDrive)) {
      const dir = path.join(oneDrive, 'Kisan Depot Backups');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), json);
      pruneBackups(dir);
    }
    console.log(`Auto-backup saved (${name})`);
  } catch (e) { console.error('Auto-backup failed:', e.message); }
}

// ---------- Import (restore) a backup file ----------
async function restoreData(b) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`TRUNCATE products, purchases, sales, sale_payments, purchase_payments,
                   partners, investments, expenses, sale_returns, replacements RESTART IDENTITY CASCADE`);
    // legacy backups saved dates as UTC instants written by a Pakistan (UTC+5) machine;
    // normalise every date to plain YYYY-MM-DD so nothing shifts on any timezone
    const DATE_COLS = new Set(['purchase_date', 'sale_date', 'pay_date', 'return_date', 'inv_date', 'exp_date', 'rep_date', 'left_date']);
    const normDate = v => {
      if (v === null || v === undefined || v === '') return null;
      const s = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      return new Date(new Date(s).getTime() + 5 * 3600000).toISOString().slice(0, 10);
    };
    const ins = async (table, rows, cols, defaults = {}) => {
      for (const r of rows || []) {
        const vals = cols.map(k => {
          let v = r[k] === undefined ? (defaults[k] !== undefined ? defaults[k] : null) : r[k];
          if (DATE_COLS.has(k)) v = normDate(v);
          return v;
        });
        await c.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
          vals);
      }
      if ((rows || []).length) {
        await c.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), (SELECT MAX(id) FROM ${table}))`);
      }
    };
    await ins('products', b.products, ['id', 'name', 'category', 'unit', 'description', 'sale_price', 'pack_size', 'pack_unit', 'created_at'], { sale_price: 0, pack_size: 0, pack_unit: '' });
    await ins('partners', b.partners,
      ['id', 'name', 'active', 'left_date', 'final_invested', 'final_profit', 'final_expense_share', 'final_net', 'created_at'],
      { active: true, final_invested: 0, final_profit: 0, final_expense_share: 0, final_net: 0 });
    await ins('purchases', b.purchases, ['id', 'product_id', 'purchase_date', 'qty', 'unit_price', 'transport', 'created_at'], { transport: 0 });
    await ins('sales', b.sales, ['id', 'product_id', 'sale_date', 'qty', 'sale_price', 'payment', 'customer_name', 'phone', 'address', 'receipt_group', 'replaced_note', 'created_at'],
      { payment: 'Cash', customer_name: '', phone: '', address: '', replaced_note: '' });
    await ins('replacements', b.replacements, ['id', 'sale_id', 'new_sale_id', 'rep_date', 'qty', 'from_product', 'from_price', 'to_product', 'to_price', 'reason', 'created_at'],
      { from_product: '', from_price: 0, to_product: '', to_price: 0, reason: '' });
    await ins('sale_payments', b.sale_payments, ['id', 'sale_id', 'pay_date', 'amount', 'method', 'created_at'], { method: 'Cash' });
    await ins('sale_returns', b.sale_returns, ['id', 'sale_id', 'return_date', 'qty', 'refund', 'method', 'reason', 'created_at'], { refund: 0, method: 'Cash', reason: '' });
    await ins('purchase_payments', b.purchase_payments, ['id', 'purchase_id', 'pay_date', 'amount', 'method', 'created_at'], { method: 'Cash' });
    await ins('investments', b.investments, ['id', 'partner_id', 'product_id', 'inv_date', 'amount', 'created_at']);
    await ins('expenses', b.expenses, ['id', 'exp_date', 'category', 'description', 'amount', 'created_at'], { category: 'Other', description: '' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

app.post('/api/restore', async (req, res) => {
  try {
    const b = req.body;
    if (!b || !Array.isArray(b.products) || !Array.isArray(b.purchases) || !Array.isArray(b.sales)) {
      return res.status(400).json({ error: 'This is not a valid Kisan Depot backup file' });
    }
    // safety net: snapshot the current data before it is replaced
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const safetyFile = `kisan-depot-before-import-${localStamp()}-${String(Date.now()).slice(-6)}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, safetyFile), JSON.stringify(await buildBackup(), null, 2));

    await restoreData(b);
    await logAction(req, 'restore', 'backup',
      `All shop data REPLACED by an imported backup (${b.products.length} products, ${b.purchases.length} purchases, ` +
      `${b.sales.length} sales, ${(b.expenses || []).length} expenses). Previous data saved in backups\\${safetyFile}`);
    res.json({ ok: true, safetyFile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Kisan Depot running at http://localhost:${PORT}`);
  autoBackup();
  setInterval(autoBackup, 60 * 60 * 1000);
});
