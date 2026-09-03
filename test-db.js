// Quick connection test used by the installer. Exits 0 if PostgreSQL is reachable.
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}

const client = new Client({
  host: process.env.PGHOST || cfg.host || 'localhost',
  port: parseInt(process.env.PGPORT || cfg.port || '5432', 10),
  user: process.env.PGUSER || cfg.user || 'postgres',
  password: process.env.PGPASSWORD || cfg.password || 'postgres',
  database: 'postgres' // the always-existing admin database
});

client.connect()
  .then(() => client.query('SELECT 1'))
  .then(() => { console.log('DB connection OK'); return client.end(); })
  .catch(e => { console.error('DB connection failed:', e.message); process.exit(1); });
