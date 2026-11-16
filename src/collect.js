// Recording a hit: one page view or event a site's tracker (public/tally.js) sends to POST /hit.
//
// Built to match what Umami recorded, so its history can be copied in and charts carry on: the
// same browser, system and device names (detect-browser is the library Umami uses, and deviceOf
// is Umami's rule), the referrer's domain without "www.", and the country as a two-letter code.
//
// Nothing that identifies a person is kept. The visitor is a hash of the site, their IP address
// and browser with a secret that changes each month (table salts); the address and browser text
// themselves are never saved. PRIVATE_VALUES are removed from page addresses here, as a backstop
// for sites' own beforeSend hooks.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Reader } from 'mmdb-lib';
import { parseUserAgent } from 'detect-browser';
import { isbot } from 'isbot';
import { pool } from './db.js';
import { findSite, originAllowed } from './sites.js';

// Query values that must never be kept: secrets in confirm-email and reset-password links, and
// email addresses passed between pages.
export const PRIVATE_VALUES = ['token', 'email'];

// A visit ends after this long without a hit.
const VISIT_MINUTES = 30;

// The visitor's IP address. On Cloud Run, Google's front end adds the address it saw as the last
// entry in X-Forwarded-For (earlier entries come from the visitor and can be faked). Locally,
// there's no such header and the connection's own address is used.
export function visitorIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = forwarded.at(-1) || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '').slice(0, 45) || null;
}

// Countries from the free DB-IP Lite database (CC BY 4.0: sites using Tally credit DB-IP in their
// privacy policy), loaded on first use. About 8 MB in memory.
let countries = null;
export function countryOf(ip) {
  if (!ip) return null;
  try {
    if (!countries) {
      const dir = path.dirname(createRequire(import.meta.url).resolve('@ip-location-db/dbip-country-mmdb/package.json'));
      countries = new Reader(fs.readFileSync(path.join(dir, 'dbip-country.mmdb')));
    }
    const code = countries.get(ip)?.country_code;
    return /^[A-Z]{2}$/.test(code || '') ? code : null;
  } catch {
    return null; // not an address the database understands
  }
}

// Umami's rule for the kind of device, from the operating system and the screen's width.
const DESKTOP_OS = ['BeOS', 'Chrome OS', 'Linux', 'Mac OS', 'Open BSD', 'OS/2', 'QNX', 'Sun OS', 'Windows 10',
  'Windows 2000', 'Windows 3.11', 'Windows 7', 'Windows 8', 'Windows 8.1', 'Windows 95', 'Windows 98', 'Windows ME',
  'Windows Server 2003', 'Windows Vista', 'Windows XP'];
const MOBILE_OS = ['Amazon OS', 'Android OS', 'BlackBerry OS', 'iOS', 'Windows Mobile'];
export function deviceOf(os, screen) {
  const width = Number(String(screen || '').split('x')[0]) || 0;
  if (!width) return null;
  if (DESKTOP_OS.includes(os)) return os === 'Chrome OS' || width < 1920 ? 'laptop' : 'desktop';
  if (MOBILE_OS.includes(os)) return os === 'Amazon OS' || width > 479 ? 'tablet' : 'mobile';
  if (width >= 1920) return 'desktop';
  if (width >= 1024) return 'laptop';
  return width >= 479 ? 'tablet' : 'mobile';
}

// This month's secret (by UTC), made the first time it's needed. Older months' secrets are
// deleted then, so last month's visitors can't be matched to this month's.
let salt = null; // { month, value }
async function monthSalt() {
  const month = new Date().toISOString().slice(0, 7);
  if (salt?.month === month) return salt.value;
  await pool.execute('INSERT IGNORE INTO salts (month, salt) VALUES (?, ?)', [month, crypto.randomBytes(32)]);
  const [[row]] = await pool.execute('SELECT salt FROM salts WHERE month = ?', [month]);
  await pool.execute('DELETE FROM salts WHERE month <> ?', [month]);
  salt = { month, value: row.salt };
  return salt.value;
}

// A hash shaped like a UUID, as Umami's ids are.
function uuidHash(...parts) {
  const hex = crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const text = (value, max) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : null;
};

// A query string ("?a=1&b=2") without its private values, or null when nothing is left.
export function cleanQuery(query) {
  const s = typeof query === 'string' ? query.replace(/^\?/, '') : '';
  if (!s) return null;
  const params = new URLSearchParams(s);
  PRIVATE_VALUES.forEach((name) => params.delete(name));
  const left = params.toString();
  return left ? `?${left}`.slice(0, 500) : null;
}

// The referring site's domain without "www.", or null for none and for the site's own pages
// (moving between its pages isn't a referral). Also works for apps' referrers (android-app://…).
export function referrerDomain(referrer, site) {
  if (typeof referrer !== 'string' || !referrer) return null;
  let host;
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { return null; }
  if (!host || site.hostnames.includes(host)) return null;
  return host.replace(/^www\./, '').slice(0, 255);
}

// The hit's body: the tracker sends JSON as text/plain, so browsers don't ask permission first.
function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try {
    const body = JSON.parse(String(req.body || ''));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// What the tracker reported, cleaned, or null when it isn't recorded: unknown sites, pages on
// hosts the site doesn't list, bots, a page address that isn't one, or an event name that isn't
// a plain word.
export function readHit(body, site, userAgent) {
  if (!body || !userAgent || isbot(userAgent)) return null;
  const isPageView = body.type === 'view';
  if (!isPageView && body.type !== 'event') return null;
  let url;
  try { url = new URL(body.url); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const urlPath = url.pathname.slice(0, 500);
  const eventName = isPageView ? null : text(body.name, 50);
  if (!isPageView && !/^[a-z][a-z-]*$/.test(eventName || '')) return null;
  let eventData = null;
  if (!isPageView && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const json = JSON.stringify(body.data);
    if (json.length <= 1000) eventData = json;
  }
  const screen = /^\d{1,5}x\d{1,5}$/.test(body.screen || '') ? body.screen : null;
  const agent = parseUserAgent(userAgent);
  const os = agent?.os?.slice(0, 30) || null;
  return {
    isPageView, eventName, eventData, urlPath, screen, os,
    urlQuery: cleanQuery(url.search),
    pageTitle: text(body.title, 300),
    referrer: referrerDomain(body.referrer, site),
    browser: agent?.name?.slice(0, 30) || null,
    device: deviceOf(os, screen),
  };
}

// The site a request may report for: the one named in its body, when the browser's page (the
// Origin header) is on one of the site's hosts. Null otherwise.
export async function siteFor(req) {
  const body = parseBody(req);
  const site = await findSite(body?.site);
  if (!site || !originAllowed(site, req.get('Origin'))) return null;
  return { site, body };
}

// Records one hit. Answers whether it was recorded.
export async function recordHit(req) {
  const found = await siteFor(req);
  if (!found) return false;
  const userAgent = req.get('User-Agent') || '';
  const hit = readHit(found.body, found.site, userAgent);
  if (!hit) return false;
  const ip = visitorIp(req);
  const visitorId = uuidHash(await monthSalt(), found.site.id, ip, userAgent);
  // The visit carries on if this visitor was here in the last 30 minutes.
  const [[last]] = await pool.execute(
    `SELECT visit_id FROM events
     WHERE site_id = ? AND visitor_id = ? AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL ${VISIT_MINUTES} MINUTE
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [found.site.id, visitorId]
  );
  await pool.execute(
    `INSERT INTO events (site_id, visitor_id, visit_id, is_page_view, event_name, event_data, url_path, url_query,
       page_title, referrer_domain, country, browser, os, device, screen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [found.site.id, visitorId, last?.visit_id || crypto.randomUUID(), hit.isPageView, hit.eventName, hit.eventData,
      hit.urlPath, hit.urlQuery, hit.pageTitle, hit.referrer, countryOf(ip), hit.browser, hit.os, hit.device, hit.screen]
  );
  return true;
}
