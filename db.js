const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Optional config.json beside this file can override DB settings, e.g. {"password": "mypassword"}
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}

const pool = new Pool({
  host: process.env.PGHOST || fileCfg.host || 'localhost',
  port: parseInt(process.env.PGPORT || fileCfg.port || '5432', 10),
  user: process.env.PGUSER || fileCfg.user || 'postgres',
  password: process.env.PGPASSWORD || fileCfg.password || 'postgres',
  database: process.env.PGDATABASE || fileCfg.database || 'kisan_depot'
});

module.exports = pool;
