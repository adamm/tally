// Hits (POST /hit, collect.js): what's recorded, visitors and visits, who and what isn't
// counted, and what's never kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ORIGIN, IPHONE } from './helpers.js';
import { deviceOf, referrerDomain, cleanQuery } from '../src/collect.js';

let t;
before(async () => { t = await setup('collect'); });
after(async () => { await t?.teardown(); });

const latest = async () => (await t.events()).at(-1);

test('a page view is recorded with its page, referrer, country, browser and device', async () => {
  await t.db.query("INSERT INTO salts (month, salt) VALUES ('2000-01', REPEAT('x', 32))");
  const res = await t.hit({ url: `${ORIGIN}/listings/abcd2345?q=bay&sort=price`, title: 'Listings - Bay mare',
    referrer: 'https://www.facebook.com/some/post' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const row = await latest();
  assert.equal(row.site_id, 'demo');
  assert.equal(row.is_page_view, 1);
  assert.equal(row.url_path, '/listings/abcd2345');
  assert.equal(row.url_query, '?q=bay&sort=price');
  assert.equal(row.page_title, 'Listings - Bay mare');
  assert.equal(row.referrer_domain, 'facebook.com');
  assert.equal(row.country, 'US');
  assert.equal(row.browser, 'chrome');
  assert.equal(row.os, 'Mac OS');
  assert.equal(row.device, 'laptop');
  assert.equal(row.screen, '1440x900');
  assert.equal(row.source, 'tally');
  assert.match(row.visitor_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("keeps only this month's secret", async () => {
  const [salts] = await t.db.query('SELECT month FROM salts');
  assert.deepEqual(salts.map((s) => s.month), [new Date().toISOString().slice(0, 7)]);
});

test('never keeps the IP address or the browser text', async () => {
  const kept = JSON.stringify(await t.events());
  assert.ok(!kept.includes('8.8.8.8'));
  assert.ok(!kept.includes('Mozilla'));
});

test('the same address and browser are the same visitor and visit; another browser is another visitor', async () => {
  const first = await latest();
  await t.hit({ url: `${ORIGIN}/vendors/abcd2345` });
  const second = await latest();
  assert.equal(second.visitor_id, first.visitor_id);
  assert.equal(second.visit_id, first.visit_id);
  await t.hit({ screen: '390x844' }, { agent: IPHONE });
  const phone = await latest();
  assert.notEqual(phone.visitor_id, first.visitor_id);
  assert.notEqual(phone.visit_id, first.visit_id);
  assert.equal(phone.browser, 'ios');
  assert.equal(phone.device, 'mobile');
});

test('after 30 minutes away, the same visitor starts a new visit', async () => {
  const before = await latest();
  await t.db.query('UPDATE events SET created_at = created_at - INTERVAL 31 MINUTE WHERE visitor_id = ?', [before.visitor_id]);
  await t.hit({ screen: '390x844' }, { agent: IPHONE });
  const after = await latest();
  assert.equal(after.visitor_id, before.visitor_id);
  assert.notEqual(after.visit_id, before.visit_id);
});

test('events are recorded with their name and data', async () => {
  assert.equal((await t.hit({ type: 'event', name: 'listing-posted', data: { type: 'fixed' } })).status, 204);
  const row = await latest();
  assert.equal(row.is_page_view, 0);
  assert.equal(row.event_name, 'listing-posted');
  assert.deepEqual(typeof row.event_data === 'string' ? JSON.parse(row.event_data) : row.event_data, { type: 'fixed' });
});

test("private values are removed, and the site's own pages aren't a referrer", async () => {
  await t.hit({ url: `${ORIGIN}/reset-password?token=abc123&email=a%40b.com&from=login`,
    referrer: 'https://example.test/login?email=a@b.com' });
  const row = await latest();
  assert.equal(row.url_query, '?from=login');
  assert.equal(row.referrer_domain, null);
  assert.ok(!JSON.stringify(await t.events()).includes('abc123'));
});

test("unknown sites, other hosts, bots and nonsense aren't recorded, but are still answered 204", async () => {
  const count = (await t.events()).length;
  const tries = [
    t.hit({ site: 'nobody' }),
    t.hit({}, { origin: 'https://evil.example.com' }),
    t.hit({}, { origin: null }),
    t.hit({}, { agent: 'Googlebot/2.1 (+http://www.google.com/bot.html)' }),
    t.hit({}, { agent: null }),
    t.hit({ url: 'listings' }),
    t.hit({ url: 'javascript:alert(1)' }),
    t.hit({ type: 'click' }),
    t.hit({ type: 'event', name: 'Not A Name!' }),
  ];
  for (const res of await Promise.all(tries)) assert.equal(res.status, 204);
  assert.equal((await t.events()).length, count);
  const res = await t.hit({}, { origin: 'https://evil.example.com' });
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS for other hosts');
});

test('a body that is not JSON is answered 204 and dropped', async () => {
  const count = (await t.events()).length;
  const res = await fetch(`${t.base}/hit`, { method: 'POST', headers: { Origin: ORIGIN }, body: 'not json' });
  assert.equal(res.status, 204);
  assert.equal((await t.events()).length, count);
});

test('long text is cut to fit and a local address has no country', async () => {
  await t.hit({ url: `${ORIGIN}/${'a'.repeat(600)}`, title: 'T'.repeat(400) }, { ip: '127.0.0.1' });
  const row = await latest();
  assert.equal(row.url_path.length, 500);
  assert.equal(row.page_title.length, 300);
  assert.equal(row.country, null);
});

test('serves the tracker script', async () => {
  const res = await fetch(`${t.base}/tally.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
});

test("device, referrer and query rules match Umami's", () => {
  const site = { hostnames: ['www.example.test'] };
  assert.equal(deviceOf('Windows 10', '1920x1080'), 'desktop');
  assert.equal(deviceOf('Windows 10', '1536x864'), 'laptop');
  assert.equal(deviceOf('Chrome OS', '2560x1440'), 'laptop');
  assert.equal(deviceOf('iOS', '820x1180'), 'tablet');
  assert.equal(deviceOf('Android OS', '412x915'), 'mobile');
  assert.equal(deviceOf('iOS', null), null);
  assert.equal(referrerDomain('android-app://com.google.android.gm/', site), 'com.google.android.gm');
  assert.equal(referrerDomain('https://www.google.com/', site), 'google.com');
  assert.equal(referrerDomain('not an address', site), null);
  assert.equal(cleanQuery('?token=x'), null);
  assert.equal(cleanQuery(''), null);
});
