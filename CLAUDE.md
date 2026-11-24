# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Tally: privacy-friendly visitor statistics, replacing Umami, for the owner's sites (first
BuySellHorth, https://www.buysellhorth.com, whose repo is the sibling folder `../BuySellSite`).
A Cloud Run service (`tally`, project `buysellhorth`) with its own MySQL database (`tally`) on
BuySellHorth's Cloud SQL server. Node 22, Express 5, ES modules, plain JavaScript, mysql2 with
no ORM, no build step. `README.md` is the user-facing reference (API, setup, deploying): keep it
current when behavior or routes change.

The owner is the only developer. Plain language everywhere: comments, error messages, commit
messages. Short sentences, no jargon. Commit, push and deploy **only when asked**.

## Layout

- `src/index.js`: the Express app and every route, each with a comment saying who calls it and
  what the body is.
- `src/collect.js`: reading and recording a hit. `src/sites.js`: sites and keys (cached a
  minute). `src/stats.js`: a site's totals. `src/export.js`: the append-only copy to BigQuery.
  `src/db.js`, `src/migrate.js`, `src/rate-limit.js`: copied from BuySellHorth and trimmed.
- `public/tally.js`: the tracker sites load. Plain old-style JavaScript (`var`, no build), since
  it runs in every visitor's browser.
- `scripts/`: `add-site.js`, `import-umami.js` (run by hand).
- `db/schema.sql` plus `db/migrations/NNN_name.sql`. **Adding a migration is three edits:** the
  file, the same change in `schema.sql`, and its name in the `schema_migrations` INSERT at
  the bottom of `schema.sql`.

## Rules that matter

- **Never store an IP address or user-agent text**, and never copy either to BigQuery. The
  visitor id is `uuidHash(month's salt, site, ip, user agent)`; salts for other months are
  deleted. Tests check that neither reaches the database.
- **Stay compatible with Umami** while sites still compare or import: browser, os and device
  names come from `detect-browser` and `deviceOf` (Umami's rule), referrers are domains without
  `www.`, and the stats routes answer in Umami's shape. Changing a name breaks charts that span
  the switch.
- `/hit` always answers 204, whatever happens. A site's page must never see an error from
  statistics. Drops are silent; real failures are logged.
- Hits are JSON sent as `text/plain`, so browsers send them without asking first (no CORS
  preflight). Only Origins in the site's `hostnames` count.
- `events` only grows; `export.js` appends after `exports.last_id`. Any new column needs adding
  to `COLUMNS` there, and BigQuery takes new nullable columns on append only if the table's schema
  is updated (do it by hand with `bq update`).
- Times are UTC everywhere (`db.js`); test connections use `timezone: 'Z'` too. To move time in
  tests, update `created_at` in SQL.

## Tests

`npm test` (about 3 seconds, needs local MySQL with the login in `.env`). Each file calls
`setup(label)` from `test/helpers.js`, which makes a fresh `tally_test_<label>` database with the
real `migrate.js`, adds the site `demo` (hosts `www.example.test`, `example.test`, key
`tally_test_key`) and starts the real server. `t.hit(body, { ip, agent, origin })` sends a hit
as the tracker would; `t.api(path, { method, headers })` calls any route; `t.events()` reads the
table; `t.db` is a direct connection. `tracker.test.js` runs `public/tally.js` in a pretend
browser (`node:vm`) with timers that run on `tick()`.

Files: `collect` (hits), `stats`, `totals` (the hourly all-time totals), `export` (a pretend
BigQuery), `tracker`, `import`.
