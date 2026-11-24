// Tally's web service: the tracker script, hits from it, each site's numbers, the hourly copy
// to BigQuery and the hourly all-time totals. See README.md.
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { recordHit, siteFor } from './collect.js';
import { requireSiteKey, totals, activeVisitors, keepTotals } from './stats.js';
import { exportOn, exportToBigQuery } from './export.js';
import { rateLimit } from './rate-limit.js';
import { databaseDown } from './db.js';

const COMMIT = process.env.GIT_COMMIT || 'local';
const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');

const app = express();
// Cloud Run's front end adds the visitor's address as the last X-Forwarded-For entry.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.disable('x-powered-by');

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/version', (req, res) => res.json({ commit: COMMIT }));

// The tracker script sites load. Kept by browsers for an hour, so a change reaches everyone soon.
app.get('/tally.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(PUBLIC_DIR, 'tally.js'));
});

// Lets the browser read the answer when the page is on one of the site's hosts. Hits are sent as
// text/plain, so browsers don't ask first; OPTIONS is answered anyway, for anything that does.
async function allowSite(req, res, next) {
  const found = await siteFor(req).catch(() => null);
  if (found) {
    res.set('Access-Control-Allow-Origin', req.get('Origin'));
    res.set('Vary', 'Origin');
  }
  next();
}
app.options('/hit', (req, res) => {
  const origin = req.get('Origin');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.status(204).end();
});

// Anyone's browser, from a site's page. Body (JSON, sent as text/plain): { site, type: 'view' |
// 'event', url (the page's full address), title, referrer, screen ("widthxheight"), name and data
// (an event's name, lowercase words with dashes, and a small object) }. Always 204, even when
// nothing is recorded (see collect.js), so statistics never cause an error on a page.
app.post('/hit',
  rateLimit(process.env.HIT_LIMITS || '300/10', 'Too many hits. Please slow down.'),
  express.text({ type: '*/*', limit: '8kb' }),
  allowSite,
  async (req, res) => {
    try {
      await recordHit(req);
    } catch (err) {
      console.error('Recording a hit failed:', err.message);
    }
    res.status(204).end();
  });

// A site's own server, with its key. See stats.js.
app.get('/api/websites/:site/stats', requireSiteKey, async (req, res) => {
  const endAt = Number(req.query.endAt) || Date.now();
  const startAt = Number(req.query.startAt) || 0;
  res.json(await totals(req.site.id, startAt, endAt));
});
app.get('/api/websites/:site/active', requireSiteKey, async (req, res) => {
  res.json(await activeVisitors(req.site.id));
});

// Whether a timer's request carries JOBS_SECRET in its X-Job-Secret header. Answers 403 if not.
const secretHash = (s) => crypto.createHash('sha256').update(String(s)).digest();
function jobSecretMatches(req, res) {
  const given = req.get('X-Job-Secret');
  if (given && crypto.timingSafeEqual(secretHash(given), secretHash(process.env.JOBS_SECRET))) return true;
  res.status(403).json({ error: 'Wrong or missing job secret.' });
  return false;
}

// Cloud Scheduler, every hour, with JOBS_SECRET in an X-Job-Secret header: adds new events to
// BigQuery (see export.js). Answers { added } when done; 404 when TALLY_DATASET or JOBS_SECRET
// isn't set; 500 if BigQuery refused (the next run tries again).
app.post('/jobs/export', async (req, res) => {
  if (!process.env.JOBS_SECRET || !exportOn) return res.status(404).json({ error: 'The export is off.' });
  if (!jobSecretMatches(req, res)) return;
  res.json(await exportToBigQuery());
});

// Cloud Scheduler, every hour, the same way: brings each site's all-time totals up to the start
// of the hour, so all-time numbers stay quick (see keepTotals in stats.js). Answers { updated };
// 404 when JOBS_SECRET isn't set. A missed run only makes all-time numbers a little slower.
app.post('/jobs/totals', async (req, res) => {
  if (!process.env.JOBS_SECRET) return res.status(404).json({ error: 'Jobs are off.' });
  if (!jobSecretMatches(req, res)) return;
  res.json(await keepTotals());
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Express 5 forwards errors from async handlers here.
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (databaseDown(err)) return res.status(503).set('Retry-After', '30').json({ error: 'The database is restarting.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log(`Tally listening on port ${PORT} (commit ${COMMIT})`));
