// The tracker script (public/tally.js), run in a small pretend browser: one view per new address,
// the wait for the title, the referrer only once, events, and the site's beforeSend hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, '../public/tally.js'), 'utf8');

// A pretend page at `address`, with the script loaded. Timers run only when tick() is called.
function page({ address = 'https://www.example.test/', referrer = 'https://www.google.com/', hook } = {}) {
  const sent = []; // { endpoint, payload, options }
  const timers = new Map();
  const listeners = {};
  let nextTimer = 1;
  const location = new URL(address);
  const history = {
    pushState(state, title, url) { const next = new URL(url, location.href); location.href = next.href; },
    replaceState(state, title, url) { const next = new URL(url, location.href); location.href = next.href; },
  };
  // location as the page sees it: URL objects have the same fields as window.location.
  const window = {
    URL, JSON, history,
    location,
    screen: { width: 1440, height: 900 },
    document: {
      title: 'Home',
      referrer,
      currentScript: {
        src: 'https://tally.example.test/tally.js',
        getAttribute: (name) => ({ 'data-site': 'demo', 'data-before-send': hook ? 'hook' : null }[name] ?? null),
      },
    },
    fetch: (endpoint, options) => { sent.push({ endpoint, payload: JSON.parse(options.body), options }); return Promise.resolve(); },
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    hook,
  };
  window.window = window;
  vm.runInNewContext(SOURCE, window);
  return {
    window, sent,
    tick() { const fns = [...timers.values()]; timers.clear(); fns.forEach((fn) => fn()); },
    fire(name) { (listeners[name] || []).forEach((fn) => fn()); },
    go(url) { window.history.pushState({}, '', url); },
  };
}

test('waits for the title, then sends the first view with the referrer', () => {
  const p = page();
  assert.equal(p.sent.length, 0, 'waits a moment first');
  p.window.document.title = 'Listings';
  p.tick();
  assert.equal(p.sent.length, 1);
  const { endpoint, payload, options } = p.sent[0];
  assert.equal(endpoint, 'https://tally.example.test/hit');
  assert.equal(options.headers['Content-Type'], 'text/plain');
  assert.equal(options.keepalive, true);
  assert.equal(options.credentials, 'omit');
  assert.deepEqual(payload, { site: 'demo', type: 'view', url: 'https://www.example.test/', title: 'Listings',
    screen: '1440x900', referrer: 'https://www.google.com/' });
});

test('one view per new address; only the first carries the referrer; a hash alone is not a new page', () => {
  const p = page();
  p.tick();
  p.go('/listings/abc');
  p.go('/listings/abc#pictures');
  p.window.history.replaceState({}, '', '/listings/abc');
  p.tick();
  p.go('/news?month=2026-11');
  p.tick();
  assert.deepEqual(p.sent.map((s) => s.payload.url), ['https://www.example.test/',
    'https://www.example.test/listings/abc', 'https://www.example.test/news?month=2026-11']);
  assert.deepEqual(p.sent.map((s) => s.payload.referrer), ['https://www.google.com/', null, null]);
});

test('moving on before the second is up sends the waiting view at once, with the title it has', () => {
  const p = page();
  p.go('/a');
  assert.equal(p.sent.length, 1, 'the first page was sent when the visitor moved on');
  assert.equal(p.sent[0].payload.url, 'https://www.example.test/');
});

test('leaving the page sends the waiting view', () => {
  const p = page();
  p.fire('pagehide');
  assert.equal(p.sent.length, 1);
  p.fire('pagehide');
  assert.equal(p.sent.length, 1, 'only once');
});

test('Back and Forward count as new pages', () => {
  const p = page();
  p.tick();
  p.window.location.href = 'https://www.example.test/vendors/xyz';
  p.fire('popstate');
  p.tick();
  assert.equal(p.sent.at(-1).payload.url, 'https://www.example.test/vendors/xyz');
});

test('events go out at once with their name and data', () => {
  const p = page();
  p.tick();
  p.window.tally.track('listing-posted', { type: 'fixed' });
  assert.deepEqual(p.sent.at(-1).payload.type, 'event');
  assert.deepEqual(p.sent.at(-1).payload.name, 'listing-posted');
  assert.deepEqual(p.sent.at(-1).payload.data, { type: 'fixed' });
});

test("the site's beforeSend hook can change a hit or drop it", () => {
  let admin = false;
  const hook = (type, payload) => (admin ? null : { ...payload, url: payload.url.replace(/token=\w+/, '') });
  const p = page({ address: 'https://www.example.test/reset?token=secret', hook });
  p.tick();
  assert.equal(p.sent[0].payload.url, 'https://www.example.test/reset?');
  admin = true;
  p.go('/admin');
  p.tick();
  p.window.tally.track('listing-posted');
  assert.equal(p.sent.length, 1, 'nothing sent while the hook says no');
});

test('a hook that throws drops the hit rather than breaking the page', () => {
  const p = page({ hook: () => { throw new Error('oops'); } });
  assert.doesNotThrow(() => p.tick());
  assert.equal(p.sent.length, 0);
});
