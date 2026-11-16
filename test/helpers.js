// The test harness: each test file gets its own fresh database (tally_test_<label>), built with
// the real migrate.js, and the real server on a free port. Only the database login is read from
// .env (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { hashKey } from '../src/sites.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The database login from .env, or MySQL's defaults.
export function dbLogin() {
  const file = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return {
    host: process.env.DB_HOST || env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || env.DB_PORT || 3306),
    user: process.env.DB_USER || env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? env.DB_PASSWORD ?? '',
  };
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} failed:\n${out}`))));
  });
}

// The test site every file starts with, and its key.
export const SITE = { id: 'demo', hostnames: 'www.example.test,example.test', key: 'tally_test_key' };
export const ORIGIN = 'https://www.example.test';
export const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

export async function setup(label, { env: extraEnv = {} } = {}) {
  const login = dbLogin();
  const dbName = `tally_test_${label}`;
  // Closed even when this fails, so a login without rights to make databases fails the tests
  // rather than leaving them waiting.
  const admin = await mysql.createConnection(login);
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (err) {
    throw new Error(`The login in .env (${login.user}) can't make test databases: ${err.message}. ` +
      'Give it rights on tally\\_test\\_% databases, or set DB_USER and DB_PASSWORD for npm test.');
  } finally {
    await admin.end();
  }

  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    DB_HOST: login.host, DB_PORT: String(login.port), DB_USER: login.user, DB_PASSWORD: login.password, DB_NAME: dbName,
    PORT: String(port), HIT_LIMITS: 'off', // every test request comes from the same address
    TALLY_DATASET: '', JOBS_SECRET: '', DB_SOCKET: '', K_SERVICE: '',
    ...extraEnv,
  };
  await run(process.execPath, ['src/migrate.js'], env);

  const db = await mysql.createConnection({ ...login, database: dbName, timezone: 'Z' });
  await db.query("SET time_zone = '+00:00'");
  await db.execute('INSERT INTO sites (id, name, hostnames, api_key_hash) VALUES (?, ?, ?, ?)',
    [SITE.id, 'Demo', SITE.hostnames, hashKey(SITE.key)]);

  const server = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited:\n${log}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    if (i > 100) throw new Error(`Server didn't start:\n${log}`);
    await sleep(100);
  }

  // Sends a hit as the tracker does (JSON as text/plain), from a page on the test site by default.
  // body is merged over a page view of https://www.example.test/listings.
  async function hit(body = {}, { ip = '8.8.8.8', agent = CHROME_MAC, origin = ORIGIN } = {}) {
    const headers = { 'Content-Type': 'text/plain', 'X-Forwarded-For': ip };
    if (agent) headers['User-Agent'] = agent;
    if (origin) headers.Origin = origin;
    const res = await fetch(`${base}/hit`, {
      method: 'POST', headers,
      body: JSON.stringify({ site: SITE.id, type: 'view', url: `${ORIGIN}/listings`, screen: '1440x900', ...body }),
    });
    return { status: res.status, headers: res.headers };
  }

  // Calls any route. Answers { status, body, headers }.
  async function api(urlPath, { method = 'GET', headers = {} } = {}) {
    const res = await fetch(base + urlPath, { method, headers });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  }

  const events = async () => (await db.query('SELECT * FROM events ORDER BY id'))[0];

  async function teardown() {
    server.kill();
    await db.end();
    if (!process.env.KEEP_TEST_DB) {
      const a = await mysql.createConnection(login);
      await a.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await a.end();
    }
  }

  return { base, db, env, hit, api, events, teardown, log: () => log };
}
