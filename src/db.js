import mysql from 'mysql2/promise';

// Locally: host and port. On Cloud Run: DB_SOCKET=/cloudsql/<project>:<region>:<instance>.
export const dbConfig = {
  ...(process.env.DB_SOCKET
    ? { socketPath: process.env.DB_SOCKET }
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306) }),
  user: process.env.DB_USER || 'tally',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tally',
  connectTimeout: 5000,
};

// Errors that mean the database can't be reached right now (restarting, or the connection
// dropped), rather than a mistake in a query.
const DOWN_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST', 'ER_SERVER_SHUTDOWN', 'ER_CON_COUNT_ERROR',
]);
export const databaseDown = (err) => DOWN_CODES.has(err?.code);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls connect() until it works, waiting a little longer each time, for up to `seconds`.
// Only for getting a connection: no query has been sent yet, so trying again is always safe.
export async function waitForDatabase(connect, seconds, onWait) {
  const end = Date.now() + seconds * 1000;
  for (let delay = 250; ; delay = Math.min(delay * 2, 2000)) {
    try {
      return await connect();
    } catch (err) {
      if (!databaseDown(err) || Date.now() + delay > end) throw err;
      onWait?.(err);
      await sleep(delay);
    }
  }
}

// Tally talks to MySQL in UTC both ways, so times come out right whatever time zone the
// machine is in.
const rawPool = mysql.createPool({ ...dbConfig, connectionLimit: 10, timezone: 'Z' });
rawPool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

// While the database restarts, requests wait up to DB_RETRY_SECONDS (15) for it.
const RETRY_SECONDS = Number(process.env.DB_RETRY_SECONDS ?? 15);
const connect = () => waitForDatabase(() => rawPool.getConnection(), RETRY_SECONDS);

// Used like a mysql2 pool. Each call borrows a connection, runs one statement and gives it back.
export const pool = {
  async execute(sql, params) {
    const conn = await connect();
    try { return await conn.execute(sql, params); } finally { conn.release(); }
  },
  async query(sql, params) {
    const conn = await connect();
    try { return await conn.query(sql, params); } finally { conn.release(); }
  },
  end: () => rawPool.end(),
};
