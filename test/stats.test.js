// A site's numbers for its own server (stats.js): Umami's answer shape, and the key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, SITE, ORIGIN, IPHONE } from './helpers.js';

let t;
before(async () => {
  t = await setup('stats');
  await t.hit({ url: `${ORIGIN}/one` });
  await t.hit({ url: `${ORIGIN}/two` });
  await t.hit({ type: 'event', name: 'listing-posted' });
  await t.hit({ url: `${ORIGIN}/one` }, { agent: IPHONE });
  // One visit two days ago, outside "the last day" and "active now".
  await t.hit({ url: `${ORIGIN}/old` }, { ip: '1.1.1.1' });
  await t.db.query("UPDATE events SET created_at = created_at - INTERVAL 2 DAY WHERE url_path = '/old'");
});
after(async () => { await t?.teardown(); });

const auth = { Authorization: `Bearer ${SITE.key}` };
const DAY = 24 * 60 * 60 * 1000;

test('totals for a time range, as Umami answers them', async () => {
  const now = Date.now();
  const all = await t.api(`/api/websites/demo/stats?startAt=0&endAt=${now + 1000}`, { headers: auth });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body, { pageviews: 4, visitors: 3, visits: 3 });
  const day = await t.api(`/api/websites/demo/stats?startAt=${now - DAY}&endAt=${now + 1000}`, { headers: auth });
  assert.deepEqual(day.body, { pageviews: 3, visitors: 2, visits: 2 });
});

test('active visitors are those in the last 5 minutes', async () => {
  const res = await t.api('/api/websites/demo/active', { headers: auth });
  assert.deepEqual(res.body, { visitors: 2 });
});

test('needs the right key for the right site', async () => {
  assert.equal((await t.api('/api/websites/demo/active')).status, 401);
  assert.equal((await t.api('/api/websites/demo/active', { headers: { Authorization: 'Bearer tally_wrong' } })).status, 401);
  assert.equal((await t.api('/api/websites/other/active', { headers: auth })).status, 401);
});
