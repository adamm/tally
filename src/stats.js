// A site's own numbers, for its server to show on its pages (BuySellHorth's Admin Stats tab and
// public Stats page). The routes answer in the same shape as Umami's API, so a site that read
// Umami can switch by changing the address and key:
//   GET /api/websites/:site/stats?startAt=<ms>&endAt=<ms> → { pageviews, visitors, visits }
//   GET /api/websites/:site/active                         → { visitors } (in the last 5 minutes)
// Each needs the site's key as "Authorization: Bearer tally_…".
import { pool } from './db.js';
import { findSite, keyMatches } from './sites.js';
import { VISIT_MINUTES } from './collect.js';

const asNumbers = (row) => ({ pageviews: Number(row.pageviews), visitors: Number(row.visitors), visits: Number(row.visits) });

// Totals from startAt to endAt (milliseconds since 1970, as Umami takes them). From the site's
// first event (all time), the kept totals (see keepTotals) plus what came since, so the answer
// stays quick however much history there is. Any other range is counted in full.
export async function totals(siteId, startAt, endAt) {
  const [[kept]] = await pool.execute('SELECT * FROM totals WHERE site_id = ?', [siteId]);
  if (kept && startAt <= (kept.first_at ?? kept.upto).getTime() && endAt >= kept.upto.getTime()) {
    const since = await countSince(siteId, kept.upto, new Date(endAt));
    return {
      pageviews: Number(kept.pageviews) + since.pageviews,
      visitors: Number(kept.visitors) + since.visitors,
      visits: Number(kept.visits) + since.visits,
    };
  }
  const [[row]] = await pool.execute(
    `SELECT COALESCE(SUM(is_page_view), 0) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors,
            COUNT(DISTINCT visit_id) AS visits
     FROM events WHERE site_id = ? AND created_at >= FROM_UNIXTIME(?) AND created_at < FROM_UNIXTIME(?)`,
    [siteId, startAt / 1000, endAt / 1000]
  );
  return asNumbers(row);
}

// What to add to totals kept up to `from` to bring them to `to`: page views since then, and the
// visitors and visits that first showed up since then. One seen before `from` is already in the
// kept totals, so counting it again would count it twice. Each visitor is checked once, not once
// per hit. A visit ends after VISIT_MINUTES without a hit, so one that began before `from` had a
// hit in the VISIT_MINUTES before it.
async function countSince(siteId, from, to) {
  const [[row]] = await pool.execute(
    `SELECT
       (SELECT COALESCE(SUM(is_page_view), 0) FROM events
        WHERE site_id = ? AND created_at >= ? AND created_at < ?) AS pageviews,
       (SELECT COUNT(*) FROM (SELECT DISTINCT visitor_id FROM events
          WHERE site_id = ? AND created_at >= ? AND created_at < ?) recent
        WHERE NOT EXISTS (SELECT 1 FROM events o
          WHERE o.site_id = ? AND o.visitor_id = recent.visitor_id AND o.created_at < ?)) AS visitors,
       (SELECT COUNT(DISTINCT visit_id) FROM events
        WHERE site_id = ? AND created_at >= ? AND created_at < ?
          AND visit_id NOT IN (SELECT visit_id FROM events
            WHERE site_id = ? AND created_at >= ? - INTERVAL ${VISIT_MINUTES} MINUTE AND created_at < ?)) AS visits`,
    [siteId, from, to, siteId, from, to, siteId, from, siteId, from, to, siteId, from, from]
  );
  return asNumbers(row);
}

// Brings each site's kept totals up to the start of this hour (UTC), for POST /jobs/totals, which
// runs every hour so all-time numbers only ever count an hour or so of new hits. The first time,
// it counts the site's whole history; after that, only the hours since. A site already up to date
// is left alone, so running it twice does no harm. Answers { updated }: how many sites moved forward.
export async function keepTotals() {
  const upto = new Date();
  upto.setUTCMinutes(0, 0, 0);
  const [sites] = await pool.query('SELECT id FROM sites');
  let updated = 0;
  for (const { id } of sites) {
    const [[kept]] = await pool.execute('SELECT * FROM totals WHERE site_id = ?', [id]);
    if (kept && kept.upto >= upto) continue;
    const [[{ first }]] = await pool.execute('SELECT MIN(created_at) AS first FROM events WHERE site_id = ?', [id]);
    if (kept) {
      const since = await countSince(id, kept.upto, upto);
      // Only from the totals this run read, in case another run moved them meanwhile.
      const [result] = await pool.execute(
        `UPDATE totals SET upto = ?, first_at = ?, pageviews = pageviews + ?, visitors = visitors + ?, visits = visits + ?
         WHERE site_id = ? AND upto = ?`,
        [upto, first, since.pageviews, since.visitors, since.visits, id, kept.upto]
      );
      updated += result.affectedRows;
    } else {
      const all = await totals(id, 0, upto.getTime());
      const [result] = await pool.execute(
        'INSERT IGNORE INTO totals (site_id, upto, first_at, pageviews, visitors, visits) VALUES (?, ?, ?, ?, ?, ?)',
        [id, upto, first, all.pageviews, all.visitors, all.visits]
      );
      updated += result.affectedRows;
    }
  }
  return { updated };
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
