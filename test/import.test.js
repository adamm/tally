// Copying a site's history in from Umami (scripts/import-umami.js): only before Tally's first row,
// Umami's ids and names kept, private values removed, and no second copy without --replace.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setup, ORIGIN } from './helpers.js';
import { parseCsv } from '../scripts/import-umami.js';

let t;
let csv;
const ROOT = path.resolve(import.meta.dirname, '..');

before(async () => {
  t = await setup('import');
  await t.hit({ url: `${ORIGIN}/first-tally-page` });
  await t.db.query("UPDATE events SET created_at = '2026-11-10 00:00:00'");
  csv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tally-import-')), 'umami.csv');
  fs.writeFileSync(csv, [
    'created_at,visit_id,session_id,event_type,event_name,url_path,url_query,page_title,referrer_domain,country,browser,os,device,screen',
    '2026-11-04 10:00:00.123+00,v-1,s-1,1,,/listings,q=bay&token=secret,"BuySellHorth - Listings, all",facebook.com,US,chrome,Mac OS,laptop,1440x900',
    '2026-11-04 10:01:00+00,v-1,s-1,2,listing-posted,/listings/new,,,,US,chrome,Mac OS,laptop,1440x900',
    '2026-11-11 09:00:00+00,v-2,s-2,1,,/news,,News,,CA,ios,iOS,mobile,390x844',
  ].join('\n'));
});
after(async () => { await t?.teardown(); });

const importUmami = (...args) => new Promise((resolve) => {
  execFile(process.execPath, ['scripts/import-umami.js', ...args], { cwd: ROOT, env: t.env },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
});
const umamiRows = async () => (await t.db.query("SELECT * FROM events WHERE source = 'umami' ORDER BY created_at"))[0];

test('reads CSV as psql writes it', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,"x, ""y""",\n'), [['a', 'b', 'c'], ['1', 'x, "y"', null]]);
});

test("copies the rows from before Tally's first row, with Umami's ids and names", async () => {
  // Kept all-time totals (see stats.js) leave out the older rows, so the copy drops them.
  await t.db.query(`INSERT INTO totals (site_id, upto, first_at, pageviews, visitors, visits)
    VALUES ('demo', '2026-11-11 00:00:00', '2026-11-10 00:00:00', 1, 1, 1)`);
  const res = await importUmami('demo', csv);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Copied 2 of 3 rows/);
  assert.deepEqual((await t.db.query('SELECT * FROM totals'))[0], [], 'the kept totals are dropped');
  const [view, event] = await umamiRows();
  assert.equal(view.visitor_id, 's-1');
  assert.equal(view.visit_id, 'v-1');
  assert.equal(view.is_page_view, 1);
  assert.equal(view.url_query, '?q=bay', 'private values removed');
  assert.equal(view.page_title, 'BuySellHorth - Listings, all');
  assert.equal(view.referrer_domain, 'facebook.com');
  assert.equal(view.created_at.toISOString(), '2026-11-04T10:00:00.123Z');
  assert.equal(event.is_page_view, 0);
  assert.equal(event.event_name, 'listing-posted');
  assert.equal(event.referrer_domain, null);
});

test('refuses to copy twice, unless told to replace', async () => {
  const again = await importUmami('demo', csv);
  assert.notEqual(again.code, 0);
  assert.match(again.out, /already has 2 rows from Umami/);
  const replaced = await importUmami('demo', csv, '--replace');
  assert.equal(replaced.code, 0, replaced.out);
  assert.equal((await umamiRows()).length, 2);
});

test('refuses an unknown site', async () => {
  const res = await importUmami('nobody', csv);
  assert.notEqual(res.code, 0);
  assert.match(res.out, /no site "nobody"/);
});
