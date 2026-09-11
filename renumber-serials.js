// ONE-TIME serial reset: renumbers ALL products 1..N in the order they were
// created and resets the serial counter to N. Use this when a laptop's
// numbering has gaps or a high starting point left behind by old, deleted
// data. After running, new products continue from N+1 as usual.
//
//   cd %USERPROFILE%\kisan-depot
//   node renumber-serials.js
//
const pool = require('./db');
(async () => {
  const before = await pool.query('SELECT COUNT(*)::int n, MIN(serial) lo, MAX(serial) hi FROM products');
  const b = before.rows[0];
  console.log(`Before: ${b.n} products, serials #${b.lo} .. #${b.hi}`);

  // two phases so the unique index never collides mid-update
  await pool.query('UPDATE products SET serial = serial + 1000000 WHERE serial IS NOT NULL');
  await pool.query(`
    UPDATE products p SET serial = sub.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) rn FROM products) sub
    WHERE p.id = sub.id`);
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('last_serial', (SELECT COUNT(*)::text FROM products))
    ON CONFLICT (key) DO UPDATE SET value = (SELECT COUNT(*)::text FROM products)`);

  const after = await pool.query('SELECT serial, name FROM products ORDER BY serial');
  after.rows.forEach(r => console.log(`#${r.serial}  ${r.name}`));
  console.log(`\nDone: ${after.rows.length} products renumbered #1 .. #${after.rows.length}, counter reset. New products continue from #${after.rows.length + 1}.`);
  await pool.end();
})().catch(e => { console.error('Renumbering failed:', e.message); process.exit(1); });
