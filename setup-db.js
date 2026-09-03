// Creates the kisan_depot database (if missing) and all tables.
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}

const cfg = {
  host: process.env.PGHOST || fileCfg.host || 'localhost',
  port: parseInt(process.env.PGPORT || fileCfg.port || '5432', 10),
  user: process.env.PGUSER || fileCfg.user || 'postgres',
  password: process.env.PGPASSWORD || fileCfg.password || 'postgres'
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Fertilizer',
  unit TEXT NOT NULL DEFAULT 'bag',
  description TEXT NOT NULL DEFAULT '',
  sale_price NUMERIC NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  purchase_date DATE NOT NULL,
  qty NUMERIC NOT NULL CHECK (qty > 0),
  unit_price NUMERIC NOT NULL CHECK (unit_price >= 0),
  transport NUMERIC NOT NULL DEFAULT 0 CHECK (transport >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sale_date DATE NOT NULL,
  qty NUMERIC NOT NULL CHECK (qty > 0),
  sale_price NUMERIC NOT NULL CHECK (sale_price >= 0),
  payment TEXT NOT NULL DEFAULT 'Cash',
  customer_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  receipt_group INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sale_payments (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  pay_date DATE NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'Cash',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sale_returns (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  return_date DATE NOT NULL,
  qty NUMERIC NOT NULL CHECK (qty > 0),
  refund NUMERIC NOT NULL DEFAULT 0 CHECK (refund >= 0),
  method TEXT NOT NULL DEFAULT 'Cash',
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replacements (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  new_sale_id INTEGER,
  rep_date DATE NOT NULL,
  qty NUMERIC NOT NULL CHECK (qty > 0),
  from_product TEXT NOT NULL DEFAULT '',
  from_price NUMERIC NOT NULL DEFAULT 0,
  to_product TEXT NOT NULL DEFAULT '',
  to_price NUMERIC NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_payments (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  pay_date DATE NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'Cash',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  exp_date DATE NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partners (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  left_date DATE,
  final_invested NUMERIC NOT NULL DEFAULT 0,
  final_profit NUMERIC NOT NULL DEFAULT 0,
  final_expense_share NUMERIC NOT NULL DEFAULT 0,
  final_net NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investments (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  inv_date DATE NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function main() {
  const admin = new Client({ ...cfg, database: 'postgres' });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'kisan_depot'");
  if (exists.rowCount === 0) {
    await admin.query('CREATE DATABASE kisan_depot');
    console.log('Database kisan_depot created.');
  } else {
    console.log('Database kisan_depot already exists.');
  }
  await admin.end();

  const db = new Client({ ...cfg, database: 'kisan_depot' });
  await db.connect();
  await db.query(SCHEMA);

  // upgrade older databases: columns that were added after the first release
  await db.query(`
    ALTER TABLE products  ADD COLUMN IF NOT EXISTS sale_price NUMERIC NOT NULL DEFAULT 0 CHECK (sale_price >= 0);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS transport NUMERIC NOT NULL DEFAULT 0 CHECK (transport >= 0);
    ALTER TABLE sales     ADD COLUMN IF NOT EXISTS receipt_group INTEGER;
    ALTER TABLE partners  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE partners  ADD COLUMN IF NOT EXISTS left_date DATE;
    ALTER TABLE partners  ADD COLUMN IF NOT EXISTS final_invested NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE partners  ADD COLUMN IF NOT EXISTS final_profit NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE partners  ADD COLUMN IF NOT EXISTS final_expense_share NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE partners  ADD COLUMN IF NOT EXISTS final_net NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE users     ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
    ALTER TABLE sales     ADD COLUMN IF NOT EXISTS replaced_note TEXT NOT NULL DEFAULT '';
  `);
  console.log('Database schema is up to date.');

  const partners = await db.query('SELECT COUNT(*)::int n FROM partners');
  if (partners.rows[0].n === 0) {
    await db.query(`INSERT INTO partners (name) VALUES ('Partner 1'), ('Partner 2'), ('Partner 3')`);
    console.log('Seeded 3 partners.');
  }

  const users = await db.query('SELECT COUNT(*)::int n FROM users');
  if (users.rows[0].n === 0) {
    const hash = bcrypt.hashSync('kisan123', 10);
    await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
    console.log('Default login created -> username: admin  password: kisan123');
  }

  await db.end();
  console.log('Tables ready.');
}

main().catch(err => { console.error(err); process.exit(1); });
