// A site's own numbers, for its server to show on its pages (BuySellHorth's Admin Stats tab and
// public Stats page). The routes answer in the same shape as Umami's API, so a site that read
// Umami can switch by changing the address and key:
//   GET /api/websites/:site/stats?startAt=<ms>&endAt=<ms> → { pageviews, visitors, visits }
//   GET /api/websites/:site/active                         → { visitors } (in the last 5 minutes)
// Each needs the site's key as "Authorization: Bearer tally_…".
import { pool } from './db.js';
import { findSite, keyMatches } from './sites.js';

// Totals from startAt to endAt (milliseconds since 1970, as Umami takes them).
export async function totals(siteId, startAt, endAt) {
  const [[row]] = await pool.execute(
    `SELECT COALESCE(SUM(is_page_view), 0) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors,
            COUNT(DISTINCT visit_id) AS visits
     FROM events WHERE site_id = ? AND created_at >= FROM_UNIXTIME(?) AND created_at < FROM_UNIXTIME(?)`,
    [siteId, startAt / 1000, endAt / 1000]
  );
  return { pageviews: Number(row.pageviews), visitors: Number(row.visitors), visits: Number(row.visits) };
}

// Different visitors in the last 5 minutes (Umami's "active" measure).
export async function activeVisitors(siteId) {
  const [[row]] = await pool.execute(
    `SELECT COUNT(DISTINCT visitor_id) AS visitors FROM events
     WHERE site_id = ? AND created_at >= CURRENT_TIMESTAMP(3) - INTERVAL 5 MINUTE`,
    [siteId]
  );
  return { visitors: Number(row.visitors) };
}

// Middleware: the site in :site, if the request carries its key. 401 otherwise, the same answer
// for an unknown site as for a wrong key.
export async function requireSiteKey(req, res, next) {
  const site = await findSite(req.params.site);
  const key = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!site || !keyMatches(site, key)) return res.status(401).json({ error: 'Wrong or missing key.' });
  req.site = site;
  next();
}
