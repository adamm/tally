// Brings the database up to date, at every container start (npm start) and with npm run migrate.
// - Empty database: creates everything from db/schema.sql (which includes all migrations so far).
// - Otherwise: runs each db/migrations/*.sql not yet recorded in schema_migrations, in name order.
// The database itself must exist already (on Cloud SQL it's made once, see README.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { dbConfig, waitForDatabase } from './db.js';

const DB_DIR = path.resolve(import.meta.dirname, '../db');
// If the database is restarting when a new container starts, wait for it (up to
// DB_STARTUP_WAIT_SECONDS, 120) instead of failing.
let waiting = false;
const conn = await waitForDatabase(
  () => mysql.createConnection({ ...dbConfig, multipleStatements: true }),
  Number(process.env.DB_STARTUP_WAIT_SECONDS ?? 120),
  (err) => { if (!waiting) console.log(`Waiting for the database (${err.code})...`); waiting = true; }
);

const [[{ fresh }]] = await conn.query(
  `SELECT COUNT(*) = 0 AS fresh FROM information_schema.tables
   WHERE table_schema = DATABASE() AND table_name = 'events'`
);
if (fresh) {
  // schema.sql creates and selects its own database for running by hand; skip those lines here.
  const sql = (await fs.readFile(path.join(DB_DIR, 'schema.sql'), 'utf8'))
    .replace(/CREATE DATABASE[\s\S]*?;/i, '')
    .replace(/^USE .*;$/m, '');
  await conn.query(sql);
  console.log('Created tables from db/schema.sql.');
}

const [rows] = await conn.query('SELECT name FROM schema_migrations');
const done = new Set(rows.map((r) => r.name));

let count = 0;
const dir = path.join(DB_DIR, 'migrations');
for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  await conn.query(await fs.readFile(path.join(dir, file), 'utf8'));
  await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
  console.log(`applied ${file}`);
  count++;
}
console.log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
await conn.end();
