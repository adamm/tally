// The sites that report to Tally (table sites), and their keys. A site's id goes in its script
// tag; its key stays on the site's own server, for reading its numbers back (stats.js).
import crypto from 'node:crypto';
import { pool } from './db.js';

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

// Site ids are short plain names: lowercase letters, digits and dashes.
export const validSiteId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,29}$/.test(id);

// Sites are read on nearly every request, so each is kept for a minute.
const CACHE_MS = 60_000;
const cache = new Map(); // id -> { at, site }

// The site with this id, as { id, name, hostnames: [...], apiKeyHash }, or null.
export async function findSite(id) {
  if (!validSiteId(id)) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.site;
  const [[row]] = await pool.execute('SELECT * FROM sites WHERE id = ?', [id]);
  const site = row ? {
    id: row.id,
    name: row.name,
    hostnames: row.hostnames.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    apiKeyHash: row.api_key_hash,
  } : null;
  cache.set(id, { at: Date.now(), site });
  return site;
}

// Whether a browser on this page address (an Origin header) may report for the site.
export function originAllowed(site, origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return site.hostnames.includes(host);
}

// Whether `key` is the site's key, compared in constant time.
export function keyMatches(site, key) {
  if (!key) return false;
  const given = Buffer.from(hashKey(key), 'hex');
  const expected = Buffer.from(site.apiKeyHash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Makes a site, or gives an existing one new hostnames and a new key. Answers the key, which
// is shown once and never stored.
export async function saveSite({ id, name, hostnames }) {
  if (!validSiteId(id)) throw new Error('A site id is lowercase letters, digits and dashes, up to 30 characters.');
  const hosts = hostnames.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) throw new Error('Give at least one hostname.');
  const key = `tally_${crypto.randomBytes(24).toString('hex')}`;
  await pool.execute(
    `INSERT INTO sites (id, name, hostnames, api_key_hash) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), hostnames = VALUES(hostnames), api_key_hash = VALUES(api_key_hash)`,
    [id, name || id, hosts.join(','), hashKey(key)]
  );
  cache.delete(id);
  return key;
}
