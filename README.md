# Tally

Privacy-friendly visitor statistics for our sites, in place of Umami. A site adds one script
tag; Tally counts its page views and a few events, keeps them in MySQL, gives the site's own
server its totals, and copies everything to BigQuery every hour for dashboards (Grafana).

- **No cookies, no IP addresses, no browser text kept.** A visitor is a hash of the site, the IP
  address and the browser with a secret that changes every month. Older secrets are deleted, so
  visitors can't be followed from one month to the next. Sites need no cookie banner for it.
- **Matches Umami**, so a site's Umami history can be copied in and its charts carry on: the same
  browser, system and device names, referrer domains without `www.`, two-letter countries, and
  the same API answers for totals and active visitors.
- One Cloud Run service (`tally`) for every site, on BuySellHorth's Cloud SQL MySQL server with
  its own database (`tally`) and login.

## Adding Tally to a site

1. Add the site (prints its key once):
   ```bash
   npm run add-site -- bsh www.buysellhorth.com "BuySellHorth"
   ```
   The id (`bsh`) goes in the script tag. The hostnames are the only pages allowed to report for
   it (comma-separated; add `localhost` for trying it locally). Running it again for the same id
   changes the hostnames and makes a new key. A running Tally keeps each site for a minute, so
   changes take up to a minute to apply (and the old key works until then).
2. Load the script on every page:
   ```html
   <script defer src="https://tally.buysellhorth.com/tally.js" data-site="bsh"
           data-before-send="tallyBeforeSend"></script>
   ```
   - It counts each new address (path and query), in single-page apps too. Each view waits up to
     a second for the page's title, and is sent sooner when the visitor moves on or leaves.
   - `data-before-send` (optional) names a function on `window`, called as `hook(type, payload)`
     before each hit (`'view'` or `'event'`). Return the payload, changed if you like, or `null`
     to send nothing. **Use it to remove secrets and personal values from `payload.url` and
     `payload.referrer`** (Tally also removes `token` and `email` from queries itself), and to
     skip your own administrators.
   - Events: `window.tally?.track('listing-posted', { type: 'fixed' })`. Names are lowercase words
     with dashes; data is a small object.
3. Credit the country database in the site's privacy policy: countries come from
   [IP Geolocation by DB-IP](https://db-ip.com) (CC BY 4.0).
4. To show numbers on the site, its server reads them with the key (see the API below).

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/tally.js` | anyone | the tracker script, kept for an hour |
| POST | `/hit` | browsers on a site's pages | one hit, JSON sent as `text/plain`: `{ site, type: 'view' \| 'event', url, title, referrer, screen, name, data }`. The `Origin` must be one of the site's hostnames. Always 204; anything not recorded (unknown site, other hosts, bots, malformed) is dropped quietly. Speed limit per address: `HIT_LIMITS` (default `300/10`) |
| GET | `/api/websites/:site/stats?startAt=&endAt=` | the site's server, `Authorization: Bearer <key>` | totals for a time range (milliseconds since 1970) → `{ pageviews, visitors, visits }`, as Umami's API answers |
| GET | `/api/websites/:site/active` | the same | visitors in the last 5 minutes → `{ visitors }` |
| POST | `/jobs/export` | Cloud Scheduler, `X-Job-Secret` header | adds new events to BigQuery → `{ added }`; 404 without `TALLY_DATASET` or `JOBS_SECRET`, 500 if BigQuery refused (the next run tries again) |
| GET | `/health`, `/version` | anyone | `{ ok: true }`, `{ commit }` |

## What's kept (MySQL database `tally`)

- `sites`: id, name, hostnames, and the SHA-256 of each site's key.
- `events`: one row per page view or event: site, time, visitor and visit ids, page path, query
  (without private values), title, referrer domain, country, browser, system, device, screen
  size, and for events their name and data. A visit is a visitor's hits with no gap of 30
  minutes or more. `source` is `umami` for rows copied from Umami.
- `salts`: this month's secret for visitor ids. `exports`: how far the BigQuery copy has got.

## BigQuery

Every hour Cloud Scheduler calls `POST /jobs/export`, which adds the events not yet copied to
`buysellhorth.tally.events` (one table for every site; filter on `site_id`). Rows are only ever
added, so if a run fails after BigQuery loaded a batch, the same rows can arrive twice: views
should keep one row per `id`, for example
`QUALIFY ROW_NUMBER() OVER (PARTITION BY id) = 1`. Dashboards' views live with each site (for
BuySellHorth, in its `analytics/views.sql`).

## Running it locally

Needs Node 22 and MySQL. Put the database login in `.env`:
```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=…
DB_NAME=tally
PORT=3300
```
then:
```bash
npm install
mysql -u root -p -e "CREATE DATABASE tally CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
npm run dev                  # makes the tables, then serves on PORT with --watch
npm run add-site -- bsh localhost "BuySellHorth (local)"
npm test                     # about 3 seconds; each file gets its own tally_test_* database
KEEP_TEST_DB=1 npm test      # the same, keeping the test databases afterwards
```
To try the export from your machine, into a development dataset (never `tally`):
```bash
TALLY_DATASET=buysellhorth.tally_dev JOBS_SECRET=x BIGQUERY_ACCESS_TOKEN=$(gcloud auth print-access-token) npm run dev
curl -X POST -H 'X-Job-Secret: x' http://localhost:3300/jobs/export
```

## Copying a site's history from Umami

`scripts/import-umami.js` copies a CSV exported from Umami's Postgres (the `\copy` command is at
the top of the script) into `events` as `source = 'umami'`, only for the time before the site's
first Tally row, keeping Umami's visitor and visit ids:
```bash
npm run import-umami -- bsh umami.csv
```
It refuses a second copy unless given `--replace`.

## Deploying

```bash
./deploy.sh
```
Builds this folder and deploys the Cloud Run service `tally` (project `buysellhorth`,
`us-central1`). Each container start brings the database up to date (`src/migrate.js`).
Logs: `gcloud run services logs read tally --project buysellhorth --region us-central1`.

### One-time setup (in this order)

1. **Database and login** on `buysell-db-us` (as an admin login, through `cloud-sql-proxy` or the
   console's Cloud SQL Studio):
   ```sql
   CREATE DATABASE tally CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'tally'@'%' IDENTIFIED BY '…';
   GRANT ALL PRIVILEGES ON tally.* TO 'tally'@'%';
   ```
   and the same password in Secret Manager (type it in your own terminal, not a chat):
   ```bash
   printf '%s' '…' | gcloud secrets create tally-db-password --project buysellhorth --data-file=-
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets create tally-jobs-secret --project buysellhorth --data-file=-
   ```
2. **Service account** `tally-run`:
   ```bash
   gcloud iam service-accounts create tally-run --project buysellhorth --display-name "Tally"
   for role in roles/cloudsql.client roles/bigquery.jobUser; do
     gcloud projects add-iam-policy-binding buysellhorth --member serviceAccount:tally-run@buysellhorth.iam.gserviceaccount.com --role $role
   done
   for s in tally-db-password tally-jobs-secret; do
     gcloud secrets add-iam-policy-binding $s --project buysellhorth --member serviceAccount:tally-run@buysellhorth.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   done
   ```
   If the Cloud Build deploy needs it, also let your own account act as `tally-run`
   (`roles/iam.serviceAccountUser`).
3. **BigQuery dataset** `buysellhorth:tally` (and `tally_dev` for local tries), with WRITER for
   `tally-run` and READER for Grafana's account:
   ```bash
   bq mk --location=US -d buysellhorth:tally
   bq mk --location=US -d buysellhorth:tally_dev
   ```
   then give access in the console (dataset → Sharing → Permissions), or with `bq update`.
4. **Deploy** with `./deploy.sh`.
5. **Domain** `tally.buysellhorth.com`: a Cloud Run domain mapping on `tally`, and a CNAME to
   `ghs.googlehosted.com.` in the DNS zone `buysellhorth` (project `array-224823`):
   ```bash
   gcloud beta run domain-mappings create --service tally --domain tally.buysellhorth.com --project buysellhorth --region us-central1
   gcloud dns record-sets create tally.buysellhorth.com. --zone buysellhorth --project array-224823 --type CNAME --ttl 300 --rrdatas ghs.googlehosted.com.
   ```
6. **Sites:** run `npm run add-site` against production (through `cloud-sql-proxy`, with the
   `tally` login in `.env`), and give each site's server its key.
7. **Timer:**
   ```bash
   gcloud scheduler jobs create http tally-export --project buysellhorth --location us-central1 --schedule="10 * * * *" --time-zone=America/Chicago --uri=https://tally.buysellhorth.com/jobs/export --http-method=POST --attempt-deadline=600s --headers="X-Job-Secret=$(gcloud secrets versions access latest --secret=tally-jobs-secret --project buysellhorth)"
   ```
