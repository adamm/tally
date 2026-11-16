// Copies a site's history from Umami into Tally, so its charts carry on from before Tally. Rows
// are saved with source = 'umami', keeping Umami's visit and visitor ids, and only for the time
// before the site's first Tally row (when both ran, Tally's own count wins).
//
// 1. Export from Umami's Postgres to a CSV file (psql, logged in to Umami's database):
//      \copy (SELECT e.created_at, e.visit_id, e.session_id, e.event_type, e.event_name, e.url_path,
//               e.url_query, e.page_title, e.referrer_domain, s.country, s.browser, s.os, s.device, s.screen
//             FROM website_event e JOIN session s ON s.session_id = e.session_id
//             WHERE e.event_type IN (1, 2) AND e.website_id = '<Umami website id>'
//             ORDER BY e.created_at) TO 'umami.csv' WITH CSV HEADER
// 2. npm run import-umami -- <site id> umami.csv
//
// Runs once per site. It refuses when the site already has Umami rows, since those may have been
// copied to BigQuery already; with --replace it deletes and copies them again (then remove the
// old ones from BigQuery's events table too, or they count twice).
import fs from 'node:fs';
import { pool } from '../src/db.js';
import { findSite, validSiteId } from '../src/sites.js';
import { cleanQuery } from '../src/collect.js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [siteId, file] = args.filter((a) => a !== '--replace');

// Reads CSV text (as psql writes it) into rows of strings; an unquoted empty field is null.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') { quoted = true; wasQuoted = true; }
    else if (c === ',' || c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field === '' && !wasQuoted ? null : field);
      field = '';
      wasQuoted = false;
      if (c !== ',') { rows.push(row); row = []; }
    } else field += c;
  }
  if (field !== '' || wasQuoted || row.length) { row.push(field === '' && !wasQuoted ? null : field); rows.push(row); }
  return rows;
}

const cut = (value, max) => (value == null ? null : String(value).slice(0, max));

async function main() {
  if (!validSiteId(siteId) || !file) {
    console.error('Usage: npm run import-umami -- <site id> <file.csv> [--replace]');
    process.exitCode = 1;
    return;
  }
  if (!(await findSite(siteId))) throw new Error(`There's no site "${siteId}". Add it first (npm run add-site).`);
  const [[{ existing }]] = await pool.execute(
    "SELECT COUNT(*) AS existing FROM events WHERE site_id = ? AND source = 'umami'", [siteId]);
  if (Number(existing) && !replace) {
    throw new Error(`"${siteId}" already has ${existing} rows from Umami. Use --replace to copy them again.`);
  }
  const [[{ first }]] = await pool.execute(
    "SELECT MIN(created_at) AS first FROM events WHERE site_id = ? AND source = 'tally'", [siteId]);

  const [header, ...lines] = parseCsv(fs.readFileSync(file, 'utf8')).filter((r) => r.length > 1);
  const col = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const name of ['created_at', 'visit_id', 'session_id', 'event_type', 'url_path']) {
    if (!(name in col)) throw new Error(`The file has no ${name} column. Export it as described at the top of this script.`);
  }
  const rows = [];
  for (const r of lines) {
    const at = new Date(r[col.created_at].replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    if (Number.isNaN(at.getTime()) || (first && at >= first)) continue;
    rows.push([siteId, at, r[col.session_id], r[col.visit_id], r[col.event_type] === '1', cut(r[col.event_name], 50),
      cut(r[col.url_path] || '/', 500), cleanQuery(r[col.url_query] ? `?${r[col.url_query].replace(/^\?/, '')}` : ''),
      cut(r[col.page_title], 300), cut(r[col.referrer_domain] || null, 255), cut(r[col.country], 2),
      cut(r[col.browser], 30), cut(r[col.os], 30), cut(r[col.device], 20), cut(r[col.screen], 11), 'umami']);
  }

  if (replace) await pool.execute("DELETE FROM events WHERE site_id = ? AND source = 'umami'", [siteId]);
  for (let i = 0; i < rows.length; i += 1000) {
    await pool.query(
      `INSERT INTO events (site_id, created_at, visitor_id, visit_id, is_page_view, event_name, url_path, url_query,
         page_title, referrer_domain, country, browser, os, device, screen, source) VALUES ?`,
      [rows.slice(i, i + 1000)]
    );
  }
  console.log(`Copied ${rows.length} of ${lines.length} rows from Umami into "${siteId}"` +
    (first ? ` (those before Tally's first row, ${first.toISOString()}).` : '.'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await main(); } catch (err) { console.error(err.message); process.exitCode = 1; } finally { await pool.end(); }
}
