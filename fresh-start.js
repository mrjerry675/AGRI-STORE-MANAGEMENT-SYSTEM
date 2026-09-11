// FRESH START: wipes ALL business history from this laptop's database —
// sales, purchases, payments, returns, replacements, expenses, partners,
// investments and activity logs — while KEEPING the product list exactly
// as it is: names, categories, units, fixed prices and serial numbers.
// Stock becomes zero (stock is counted from purchases minus sales), so
// opening stock is entered as new purchases afterwards.
//
// Logins, Kisan Cards and settings (WhatsApp message, card discount %,
// serial counter) are kept.
//
// A safety backup of everything is saved into the backups folder first,
// so a mistaken run can be undone with:  node restore-backup.js <that file>
//
// To see what it would do (changes nothing):
//   cd %USERPROFILE%\kisan-depot
//   node fresh-start.js
//
// To actually wipe, you must type the word WIPE:
//   node fresh-start.js WIPE
//
const fs = require('fs');
const path = require('path');
const pool = require('./db');

const WIPE_TABLES = [
  'sale_payments', 'sale_returns', 'replacements', 'purchase_returns',
  'purchase_payments', 'sales', 'purchases', 'expenses',
  'investments', 'partners', 'logs'
];

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function buildBackup() {
  const q = s => pool.query(s).catch(() => ({ rows: [] }));
  const [products, purchases, sales, salePayments, purchasePayments, partners, investments, expenses, saleReturns, logs, replacements, kisanCards, settings, purchaseReturns] = await Promise.all([
    q('SELECT * FROM products ORDER BY id'),
    q(`SELECT id, product_id, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, qty, unit_price, transport, created_at FROM purchases ORDER BY id`),
    q(`SELECT id, product_id, to_char(sale_date, 'YYYY-MM-DD') AS sale_date, qty, sale_price, payment, customer_name, phone, address, receipt_group, replaced_note, kisan_card, orig_price, created_at FROM sales ORDER BY id`),
    q(`SELECT id, sale_id, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, amount, method, created_at FROM sale_payments ORDER BY id`),
    q(`SELECT id, purchase_id, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, amount, method, created_at FROM purchase_payments ORDER BY id`),
    q(`SELECT id, name, active, to_char(left_date, 'YYYY-MM-DD') AS left_date, final_invested, final_profit, final_expense_share, final_net, created_at FROM partners ORDER BY id`),
    q(`SELECT id, partner_id, product_id, to_char(inv_date, 'YYYY-MM-DD') AS inv_date, amount, created_at FROM investments ORDER BY id`),
    q(`SELECT id, to_char(exp_date, 'YYYY-MM-DD') AS exp_date, category, description, amount, created_at FROM expenses ORDER BY id`),
    q(`SELECT id, sale_id, to_char(return_date, 'YYYY-MM-DD') AS return_date, qty, refund, method, reason, created_at FROM sale_returns ORDER BY id`),
    q('SELECT * FROM logs ORDER BY id'),
    q(`SELECT id, sale_id, new_sale_id, to_char(rep_date, 'YYYY-MM-DD') AS rep_date, qty, from_product, from_price, to_product, to_price, reason, created_at FROM replacements ORDER BY id`),
    q('SELECT * FROM kisan_cards ORDER BY id'),
    q('SELECT * FROM settings ORDER BY key'),
    q(`SELECT id, purchase_id, to_char(return_date, 'YYYY-MM-DD') AS return_date, qty, refund, method, reason, created_at FROM purchase_returns ORDER BY id`)
  ]);
  return {
    exportedAt: new Date().toISOString(),
    products: products.rows, purchases: purchases.rows, sales: sales.rows,
    sale_payments: salePayments.rows, purchase_payments: purchasePayments.rows,
    partners: partners.rows, investments: investments.rows, expenses: expenses.rows,
    sale_returns: saleReturns.rows, logs: logs.rows, replacements: replacements.rows,
    kisan_cards: kisanCards.rows, settings: settings.rows,
    purchase_returns: purchaseReturns.rows
  };
}

(async () => {
  const counts = {};
  for (const t of ['products', ...WIPE_TABLES, 'kisan_cards']) {
    counts[t] = (await pool.query(`SELECT COUNT(*)::int n FROM ${t}`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  }
  const serials = (await pool.query('SELECT MIN(serial) lo, MAX(serial) hi FROM products')).rows[0];

  console.log('This laptop currently has:');
  console.log(`  ${counts.products} products (serials #${serials.lo || '-'} .. #${serials.hi || '-'})  <-- KEPT, with fixed prices and serial numbers`);
  console.log(`  ${counts.kisan_cards} Kisan Cards  <-- KEPT`);
  console.log(`  ${counts.sales} sales, ${counts.purchases} purchases, ${counts.sale_payments + counts.purchase_payments} payments`);
  console.log(`  ${counts.sale_returns} customer returns, ${counts.purchase_returns} supplier returns, ${counts.replacements} replacements`);
  console.log(`  ${counts.expenses} expenses, ${counts.partners} partners, ${counts.investments} investments, ${counts.logs} log entries  <-- ALL WIPED`);

  if (process.argv[2] !== 'WIPE') {
    console.log('\nNothing was changed. To really wipe the history, run:');
    console.log('  node fresh-start.js WIPE');
    await pool.end();
    return;
  }

  // safety backup first, so this can be undone
  const bdir = path.join(__dirname, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const bfile = path.join(bdir, `before-fresh-start-${stamp()}.json`);
  fs.writeFileSync(bfile, JSON.stringify(await buildBackup()));
  console.log(`\nSafety backup saved: ${bfile}`);
  console.log('(undo any time with:  node restore-backup.js "' + bfile + '")');

  await pool.query(`TRUNCATE ${WIPE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);

  // continue numbering right after the highest kept serial — leftover counter
  // positions from products deleted before the fresh start would only leave gaps
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('last_serial', (SELECT COALESCE(MAX(serial), 0)::text FROM products))
    ON CONFLICT (key) DO UPDATE SET value = (SELECT COALESCE(MAX(serial), 0)::text FROM products)`);

  const left = (await pool.query('SELECT COUNT(*)::int n FROM products')).rows[0].n;
  const sales = (await pool.query('SELECT COUNT(*)::int n FROM sales')).rows[0].n;
  const purch = (await pool.query('SELECT COUNT(*)::int n FROM purchases')).rows[0].n;
  const inv = (await pool.query('SELECT COUNT(*)::int n FROM investments')).rows[0].n;
  console.log(`\nDone. ${left} products kept with their serial numbers and fixed prices.`);
  console.log(`Sales: ${sales}, purchases: ${purch}, investments: ${inv} - everything at zero.`);
  console.log('Stock is zero everywhere: enter opening stock as new purchases.');
  console.log('Close and reopen the app page in the browser to see the clean books.');
  await pool.end();
})().catch(e => { console.error('Fresh start failed:', e.message); process.exit(1); });
