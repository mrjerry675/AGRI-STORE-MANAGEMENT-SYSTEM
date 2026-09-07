// Restores a Kisan Depot backup JSON into the database.
// Usage: node restore-backup.js <path-to-backup.json>
// WARNING: replaces ALL current shop data with the backup's contents.
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node restore-backup.js <backup.json>');
    process.exit(1);
  }
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`TRUNCATE products, purchases, sales, sale_payments, purchase_payments,
                   partners, investments, expenses, sale_returns, replacements RESTART IDENTITY CASCADE`);
    await c.query('TRUNCATE kisan_cards RESTART IDENTITY').catch(() => {});

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
    await ins('sales', b.sales, ['id', 'product_id', 'sale_date', 'qty', 'sale_price', 'payment', 'customer_name', 'phone', 'address', 'receipt_group', 'replaced_note', 'kisan_card', 'orig_price', 'created_at'],
      { payment: 'Cash', customer_name: '', phone: '', address: '', replaced_note: '', kisan_card: false, orig_price: 0 });
    await ins('kisan_cards', b.kisan_cards, ['id', 'name', 'phone', 'created_at']);
    // settings has no id column, so it can't go through ins()
    await c.query('TRUNCATE settings').catch(() => {});
    for (const s of b.settings || []) {
      await c.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`, [s.key, s.value]);
    }
    await ins('replacements', b.replacements, ['id', 'sale_id', 'new_sale_id', 'rep_date', 'qty', 'from_product', 'from_price', 'to_product', 'to_price', 'reason', 'created_at'],
      { from_product: '', from_price: 0, to_product: '', to_price: 0, reason: '' });
    await ins('sale_payments', b.sale_payments, ['id', 'sale_id', 'pay_date', 'amount', 'method', 'created_at'], { method: 'Cash' });
    await ins('sale_returns', b.sale_returns, ['id', 'sale_id', 'return_date', 'qty', 'refund', 'method', 'reason', 'created_at'], { refund: 0, method: 'Cash', reason: '' });
    await ins('purchase_payments', b.purchase_payments, ['id', 'purchase_id', 'pay_date', 'amount', 'method', 'created_at'], { method: 'Cash' });
    await ins('investments', b.investments, ['id', 'partner_id', 'product_id', 'inv_date', 'amount', 'created_at']);
    await ins('expenses', b.expenses, ['id', 'exp_date', 'category', 'description', 'amount', 'created_at'], { category: 'Other', description: '' });

    await c.query('COMMIT');
    // the activity log is NOT overwritten by a restore — it keeps this machine's own history,
    // and the restore itself becomes a log entry
    try {
      await c.query(
        `INSERT INTO logs (username, action, entity, details) VALUES ('system', 'restore', 'backup', $1)`,
        [`All shop data was REPLACED from backup file: ${path.basename(file)}`]);
    } catch {}
    console.log(`Restore complete: ${(b.products || []).length} products, ${(b.purchases || []).length} purchases, ` +
      `${(b.sales || []).length} sales, ${(b.partners || []).length} partners, ${(b.expenses || []).length} expenses.`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(e => { console.error('Restore failed:', e.message); process.exit(1); });
