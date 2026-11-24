// The hourly all-time totals (keepTotals in stats.js): all-time numbers from the kept totals plus
// what came since must match counting everything, with nobody who came back counted twice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, SITE, ORIGIN, IPHONE } from './helpers.js';

const JOBS_SECRET = 'test-jobs-secret';
const auth = { Authorization: `Bearer ${SITE.key}` };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// The job keeps totals up to the start of the hour. earlier: as if it last ran a day before that.
const hour = new Date();
hour.setUTCMinutes(0, 0, 0);
const earlier = new Date(hour.getTime() - DAY);
const minutes = (from, n) => new Date(from.getTime() + n * 60 * 1000);

let t;
before(async () => {
  t = await setup('totals', { env: { JOBS_SECRET } });
  // Each page is a hit, moved to its time below. Hits from one address and browser are one visitor,
  // and hits sent together are one visit.
  const pages = [
    ['/back-early', '1.1.1.1', minutes(earlier, -2 * 24 * 60)], // came three days ago...
    ['/back-late', '1.1.1.1', minutes(hour, 1)], //               ...and again this hour: one visitor
    ['/cross-before', '2.2.2.2', minutes(earlier, -10)], //      one visit across the earlier run
    ['/cross-after', '2.2.2.2', minutes(earlier, 5)],
    ['/late-before', '4.4.4.4', minutes(hour, -10)], //           and one across this hour's start
    ['/late-after', '4.4.4.4', hour],
    ['/once', '3.3.3.3', minutes(earlier, 60)], //               only after the earlier run
  ];
  for (const [page, ip] of pages) await t.hit({ url: `${ORIGIN}${page}` }, { ip });
  await t.hit({ type: 'event', name: 'listing-posted' }, { ip: '3.3.3.3' });
  await t.db.query("UPDATE events SET created_at = ? WHERE event_name = 'listing-posted'", [minutes(earlier, 61)]);
  for (const [page, , at] of pages) await t.db.query('UPDATE events SET created_at = ? WHERE url_path = ?', [at, page]);
  // Three days apart is a new visit (the hits were sent moments apart, so they shared one).
  await newVisit('/back-late');
});

const newVisit = (page) => t.db.query('UPDATE events SET visit_id = UUID() WHERE url_path = ?', [page]);
after(async () => { await t?.teardown(); });

// Everything before `to`, counted in full.
async function counted(to = new Date(Date.now() + HOUR)) {
  const [[row]] = await t.db.query(
    `SELECT COALESCE(SUM(is_page_view), 0) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors,
       COUNT(DISTINCT visit_id) AS visits FROM events WHERE site_id = ? AND created_at < ?`, [SITE.id, to]);
  return { pageviews: Number(row.pageviews), visitors: Number(row.visitors), visits: Number(row.visits) };
}
const allTime = async () =>
  (await t.api(`/api/websites/demo/stats?startAt=0&endAt=${Date.now() + HOUR}`, { headers: auth })).body;
const runJob = (secret = JOBS_SECRET) => t.api('/jobs/totals', { method: 'POST', headers: { 'X-Job-Secret': secret } });
const kept = async () => (await t.db.query('SELECT * FROM totals WHERE site_id = ?', [SITE.id]))[0][0];

test('before the first run, all-time numbers are counted in full', async () => {
  assert.equal(await kept(), undefined);
  assert.deepEqual(await counted(), { pageviews: 7, visitors: 4, visits: 5 });
  assert.deepEqual(await allTime(), await counted());
});

test('the job needs the secret', async () => {
  assert.equal((await runJob('wrong')).status, 403);
  assert.equal((await t.api('/jobs/totals', { method: 'POST' })).status, 403);
  assert.equal(await kept(), undefined);
});

test('the first run counts the whole history up to the start of the hour', async () => {
  const res = await runJob();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { updated: 1 });
  const row = await kept();
  assert.equal(row.upto.getTime(), hour.getTime());
  assert.equal(row.first_at.getTime(), minutes(earlier, -2 * 24 * 60).getTime());
  assert.deepEqual(
    { pageviews: Number(row.pageviews), visitors: Number(row.visitors), visits: Number(row.visits) },
    await counted(hour));
  assert.deepEqual((await runJob()).body, { updated: 0 }, 'a second run in the same hour changes nothing');
});

test('all-time numbers are the kept totals plus what came since, counting returning visitors once', async () => {
  assert.deepEqual(await allTime(), await counted());
  // They really come from the kept totals.
  await t.db.query('UPDATE totals SET pageviews = pageviews + 1000 WHERE site_id = ?', [SITE.id]);
  assert.equal((await allTime()).pageviews, (await counted()).pageviews + 1000);
  await t.db.query('UPDATE totals SET pageviews = pageviews - 1000 WHERE site_id = ?', [SITE.id]);

  // New hits now: a new visitor, and the one from three days ago in a new visit.
  await t.hit({ url: `${ORIGIN}/new` }, { ip: '5.5.5.5', agent: IPHONE });
  await t.hit({ url: `${ORIGIN}/back-again` }, { ip: '1.1.1.1' });
  await newVisit('/back-again'); // in case their hit this hour was under 30 minutes ago
  assert.deepEqual(await allTime(), await counted());
  assert.deepEqual(await counted(), { pageviews: 9, visitors: 5, visits: 7 });
});

test('each run adds only what came since the last, the same as counting everything', async () => {
  // As if the totals were last kept a day ago: the next run adds that day's hits.
  const before = await counted(earlier);
  await t.db.query('UPDATE totals SET upto = ?, pageviews = ?, visitors = ?, visits = ? WHERE site_id = ?',
    [earlier, before.pageviews, before.visitors, before.visits, SITE.id]);
  assert.deepEqual(await allTime(), await counted(), 'right before the run too');
  assert.deepEqual((await runJob()).body, { updated: 1 });
  const row = await kept();
  assert.equal(row.upto.getTime(), hour.getTime());
  assert.deepEqual(
    { pageviews: Number(row.pageviews), visitors: Number(row.visitors), visits: Number(row.visits) },
    await counted(hour));
  assert.deepEqual(await allTime(), await counted());
});

test('other time ranges are counted as before', async () => {
  const now = Date.now();
  const lastDay = await t.api(`/api/websites/demo/stats?startAt=${now - DAY}&endAt=${now + HOUR}`, { headers: auth });
  const [[row]] = await t.db.query(
    `SELECT COALESCE(SUM(is_page_view), 0) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors,
       COUNT(DISTINCT visit_id) AS visits FROM events WHERE created_at >= ? AND created_at < ?`,
    [new Date(now - DAY), new Date(now + HOUR)]);
  assert.deepEqual(lastDay.body, { pageviews: Number(row.pageviews), visitors: Number(row.visitors), visits: Number(row.visits) });
  // A range ending before the kept totals' hour can't use them.
  const old = await t.api(`/api/websites/demo/stats?startAt=0&endAt=${earlier.getTime()}`, { headers: auth });
  assert.deepEqual(old.body, await counted(earlier));
});
