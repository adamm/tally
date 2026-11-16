// Copies new events to BigQuery for dashboards (Grafana). Cloud Scheduler calls POST /jobs/export
// every hour. Events only grow, so each run adds the rows after the last one copied (table
// exports remembers which, per BigQuery table) rather than replacing the table. One table holds
// every site, with a site_id column. A run that fails after a load but before the marker moves
// can copy rows twice, so views over the table should keep one row per id.
//
// TALLY_DATASET is the dataset ("project.dataset"); without it the export is off. On Cloud Run
// each call carries an access token for this service's account, from the metadata server;
// elsewhere, BIGQUERY_ACCESS_TOKEN. BIGQUERY_URL changes where the calls go (the tests use a
// pretend BigQuery). Nothing private exists to copy: events hold no IP addresses or browser text.
import { pool } from './db.js';

const DATASET = process.env.TALLY_DATASET || '';
const BIGQUERY_URL = (process.env.BIGQUERY_URL || 'https://bigquery.googleapis.com').replace(/\/$/, '');
export const exportOn = /^[\w-]+\.\w+$/.test(DATASET);

const TABLE = 'events';
// Rows per load. Each batch is held in memory twice (the rows and the JSON sent), so 50,000 rows
// went past Cloud Run's 256 MB. 10,000 stays well under, and is still only ten loads for a
// backfill of 100,000 rows.
const BATCH = Number(process.env.EXPORT_BATCH) || 10_000;
const COLUMNS = [['id', 'INT64'], ['site_id', 'STRING'], ['created_at', 'TIMESTAMP'], ['visitor_id', 'STRING'],
  ['visit_id', 'STRING'], ['is_page_view', 'BOOL'], ['event_name', 'STRING'], ['event_data', 'STRING'],
  ['url_path', 'STRING'], ['url_query', 'STRING'], ['page_title', 'STRING'], ['referrer_domain', 'STRING'],
  ['country', 'STRING'], ['browser', 'STRING'], ['os', 'STRING'], ['device', 'STRING'], ['screen', 'STRING'],
  ['source', 'STRING']];
const SELECT = `SELECT ${COLUMNS.map(([name]) => (name === 'event_data' ? 'CAST(event_data AS CHAR)' : name)).join(', ')}
  FROM events WHERE id > ? ORDER BY id LIMIT ${BATCH}`;

// A value as BigQuery's JSON loader wants it.
function bigQueryValue(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'BOOL') return !!Number(value);
  if (type === 'INT64') return Number(value);
  if (type === 'TIMESTAMP') return value instanceof Date ? value.toISOString() : String(value);
  return String(value);
}

// Turns rows (arrays, in column order) into newline-separated JSON objects.
export function toNdjson(rows, columns = COLUMNS) {
  return rows.map((row) => JSON.stringify(
    Object.fromEntries(columns.map(([name, type], i) => [name, bigQueryValue(row[i], type)]))
  )).join('\n');
}

let token = null;
let tokenExpires = 0;

async function authHeaders() {
  if (!process.env.K_SERVICE) { // not on Cloud Run: a token from `gcloud auth print-access-token`, if given
    return process.env.BIGQUERY_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.BIGQUERY_ACCESS_TOKEN}` } : {};
  }
  if (!token || Date.now() > tokenExpires) {
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`Couldn't get a token for BigQuery (${res.status}).`);
    const body = await res.json();
    token = body.access_token;
    tokenExpires = Date.now() + (body.expires_in - 300) * 1000;
  }
  return { Authorization: `Bearer ${token}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One BigQuery call. Throws with BigQuery's own message if it fails.
async function bigQuery(path, options = {}) {
  const res = await fetch(`${BIGQUERY_URL}${path}`, {
    ...options,
    headers: { ...options.headers, ...(await authHeaders()) },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`BigQuery answered ${res.status}: ${body.error?.message || 'no reason given'}`);
  return body;
}

// Adds these rows to the events table (made on the first load), and waits until BigQuery has them.
async function appendRows(rows) {
  const [project, dataset] = DATASET.split('.');
  const config = {
    configuration: {
      load: {
        destinationTable: { projectId: project, datasetId: dataset, tableId: TABLE },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_APPEND',
        createDisposition: 'CREATE_IF_NEEDED',
        schema: { fields: COLUMNS.map(([name, type]) => ({ name, type })) },
      },
    },
  };
  const boundary = `export-${Date.now()}`;
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(config),
    `--${boundary}`, 'Content-Type: application/octet-stream', '', toNdjson(rows),
    `--${boundary}--`, '',
  ].join('\r\n');
  let job = await bigQuery(`/upload/bigquery/v2/projects/${project}/jobs?uploadType=multipart`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  const { jobId, location } = job.jobReference;
  for (let wait = 500; job.status?.state !== 'DONE'; wait = Math.min(wait * 2, 5000)) {
    await sleep(wait);
    job = await bigQuery(`/bigquery/v2/projects/${project}/jobs/${jobId}?location=${location}`);
  }
  if (job.status.errorResult) throw new Error(`BigQuery couldn't load the events: ${job.status.errorResult.message}`);
}

// Adds every event not yet copied, a batch at a time, moving the marker after each batch BigQuery
// has loaded. Answers { added } (how many rows). Throws if a load fails; the next run tries again.
export async function exportToBigQuery() {
  const destination = `${DATASET}.${TABLE}`;
  const [[marker]] = await pool.execute('SELECT last_id FROM exports WHERE destination = ?', [destination]);
  let lastId = Number(marker?.last_id ?? 0);
  let added = 0;
  for (;;) {
    const [rows] = await pool.query({ sql: SELECT, rowsAsArray: true }, [lastId]);
    if (!rows.length) break;
    await appendRows(rows);
    lastId = Number(rows.at(-1)[0]);
    added += rows.length;
    await pool.execute(
      'INSERT INTO exports (destination, last_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_id = VALUES(last_id)',
      [destination, lastId]
    );
    if (rows.length < BATCH) break;
  }
  return { added };
}
