// The hourly copy of events to BigQuery (export.js), against a pretend BigQuery that records each
// upload: rows are added, never replaced, only new ones are sent, and nothing private.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, ORIGIN } from './helpers.js';

const SECRET = 'export-secret';
const uploads = []; // { load, rows } for each upload, in order
let failNext = false;
let fake, t;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') { // checking on a job
        return res.end(JSON.stringify({ jobReference: { jobId: 'j', location: 'US' }, status: { state: 'DONE' } }));
      }
      const boundary = req.headers['content-type'].match(/boundary=(.+)$/)[1];
      const [config, data] = body.split(`--${boundary}`).slice(1, 3).map((part) => part.split('\r\n\r\n')[1].trim());
      uploads.push({ load: JSON.parse(config).configuration.load, rows: data.split('\n').map((line) => JSON.parse(line)) });
      const status = failNext ? { state: 'DONE', errorResult: { message: 'Pretend failure.' } } : { state: 'RUNNING' };
      failNext = false;
      res.end(JSON.stringify({ jobReference: { jobId: 'j', location: 'US' }, status }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t = await setup('export', { env: {
    JOBS_SECRET: SECRET, TALLY_DATASET: 'test-project.tally', BIGQUERY_URL: `http://127.0.0.1:${fake.address().port}`,
  } });
});
after(async () => { await t?.teardown(); fake?.close(); });

const runExport = (secret = SECRET) => t.api('/jobs/export', {
  method: 'POST', headers: secret ? { 'X-Job-Secret': secret } : {},
});
const visit = (path) => t.hit({ url: `${ORIGIN}${path}`, screen: '1920x1080' }, { ip: '8.8.4.4' });

test('needs the job secret', async () => {
  assert.equal((await runExport(null)).status, 403);
  assert.equal((await runExport('wrong')).status, 403);
});

test('with nothing to copy, uploads nothing', async () => {
  const res = await runExport();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { added: 0 });
  assert.equal(uploads.length, 0);
});

test('adds events to BigQuery, without the IP address or browser text', async () => {
  await visit('/one');
  await t.hit({ type: 'event', name: 'listing-posted', data: { type: 'fixed' } }, { ip: '8.8.4.4' });
  const res = await runExport();
  assert.deepEqual(res.body, { added: 2 });
  const [sent] = uploads;
  assert.equal(sent.load.writeDisposition, 'WRITE_APPEND');
  assert.deepEqual(sent.load.destinationTable, { projectId: 'test-project', datasetId: 'tally', tableId: 'events' });
  const [view, event] = sent.rows;
  assert.equal(view.site_id, 'demo');
  assert.equal(view.url_path, '/one');
  assert.equal(view.is_page_view, true);
  assert.equal(view.browser, 'chrome');
  assert.equal(view.device, 'desktop');
  assert.match(view.created_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(event.event_name, 'listing-posted');
  assert.deepEqual(JSON.parse(event.event_data), { type: 'fixed' });
  const text = JSON.stringify(sent);
  assert.ok(!text.includes('8.8.4.4') && !text.includes('Mozilla'));
});

test('a second run sends only rows added since', async () => {
  assert.deepEqual((await runExport()).body, { added: 0 });
  assert.equal(uploads.length, 1, 'nothing uploaded');
  await visit('/two');
  assert.deepEqual((await runExport()).body, { added: 1 });
  assert.deepEqual(uploads.at(-1).rows.map((r) => r.url_path), ['/two']);
});

test("a refused load doesn't move the marker, so the next run sends those rows again", async () => {
  await visit('/three');
  failNext = true;
  assert.equal((await runExport()).status, 500);
  assert.deepEqual((await runExport()).body, { added: 1 });
  assert.deepEqual(uploads.at(-1).rows.map((r) => r.url_path), ['/three']);
});
