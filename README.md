# Tally

Small, privacy-friendly visitor statistics for your own sites. A site adds one script tag. Tally
counts its page views and a few events, keeps them in MySQL, gives the site's own server its
totals, and copies everything to BigQuery every hour for dashboards (Grafana, Looker Studio, or
plain SQL). It was written to replace a self-hosted [Umami](https://umami.is) with something
smaller that runs on an existing MySQL server.

- **No cookies, no IP addresses, no browser text kept.** A visitor is a hash of the site, the IP
  address and the browser, mixed with a secret that changes every month. Older secrets are
  deleted, so visitors can't be followed from one month to the next.
- **Compatible with Umami**, so a site's Umami history can be copied in and its charts carry on:
  the same browser, system and device names, referrer domains without `www.`, two-letter
  countries, and the same API answers for totals and active visitors.
- **One service for many sites.** Each site has its own id, allowed hostnames and key.
- Node 22, Express 5 and MySQL 8, no build step. Made to run on Google Cloud Run with Cloud SQL,
  but it's an ordinary Node server: anything that runs one and reaches MySQL will do (the BigQuery
  export is optional).

## Adding Tally to a site

1. Add the site (it prints the site's key once):
   ```bash
   npm run add-site -- blog www.example.com "My Blog"
   ```
   The id (`blog`) goes in the script tag. The hostnames are the only pages allowed to report
   for it (comma-separated; add `localhost` for trying it locally). Running it again for the same
   id changes the hostnames and makes a new key. A running Tally keeps each site for a minute,
   so changes take up to a minute to apply (and the old key works until then).
2. Load the script on every page:
   ```html
   <script defer src="https://tally.example.com/tally.js" data-site="blog"
           data-before-send="tallyBeforeSend"></script>
   ```
   - It counts each new address (path and query), in single-page apps too. Each view waits up to
     a second for the page's title, and is sent sooner when the visitor moves on or leaves.
   - `data-before-send` (optional) names a function on `window`, called as `hook(type, payload)`
     before each hit (`'view'` or `'event'`). Return the payload, changed if you like, or `null`
     to send nothing. **Use it to remove secrets and personal values from `payload.url` and
     `payload.referrer`** (Tally also removes `token` and `email` from queries itself), and to
     skip your own administrators. For example:
     ```js
     window.tallyBeforeSend = (type, payload) => {
       if (isAdmin()) return null;
       const url = new URL(payload.url);
       url.searchParams.delete('invite');
       return { ...payload, url: url.toString() };
     };
     ```
   - Events: `window.tally?.track('signup', { plan: 'free' })`. Names are lowercase words with
     dashes; data is a small object.
3. Credit the country database in the site's privacy policy: countries come from
   [IP Geolocation by DB-IP](https://db-ip.com) (CC BY 4.0).
4. To show numbers on the site, its server reads them with the key (see the API below). Keep the
   key on the server; it never belongs in the browser.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/tally.js` | anyone | the tracker script, kept for an hour |
| POST | `/hit` | browsers on a site's pages | one hit, JSON sent as `text/plain`: `{ site, type: 'view' \| 'event', url, title, referrer, screen, name, data }`. The `Origin` must be one of the site's hostnames. Always 204; anything not recorded (unknown site, other hosts, bots, malformed) is dropped quietly. Speed limit per address: `HIT_LIMITS` (default `300/10`) |
| GET | `/api/websites/:site/stats?startAt=&endAt=` | the site's server, `Authorization: Bearer <key>` | totals for a time range (milliseconds since 1970) → `{ pageviews, visitors, visits }`, as Umami's API answers |
| GET | `/api/websites/:site/active` | the same | visitors in the last 5 minutes → `{ visitors }` |
| POST | `/jobs/export` | a timer, with an `X-Job-Secret` header | adds new events to BigQuery → `{ added }`; 404 without `TALLY_DATASET` or `JOBS_SECRET`, 500 if BigQuery refused (the next run tries again) |
| GET | `/health`, `/version` | anyone | `{ ok: true }`, `{ commit }` |

The service itself is public: browsers must reach `/tally.js` and `/hit`. The key only guards
reading a site's numbers, so strangers (and other sites) can't.

## Settings

| Setting | Meaning |
|---|---|
| `DB_HOST`, `DB_PORT` or `DB_SOCKET` | where MySQL is (a socket path such as `/cloudsql/<project>:<region>:<instance>` on Cloud Run) |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | the login and database (default user and database `tally`) |
| `PORT` | the port to listen on (Cloud Run sets it; default 8080) |
| `TALLY_DATASET` | the BigQuery dataset for the export, as `project.dataset`; empty turns the export off |
| `JOBS_SECRET` | the secret `/jobs/export` expects in `X-Job-Secret`; empty turns the export off |
| `HIT_LIMITS` | speed limit for hits per address, `count/minutes` (comma-separated for several), or `off` |
| `TRUST_PROXY` | how many proxies sit in front (default 1, Cloud Run's) |
| `GIT_COMMIT` | shown by `/version` (set it when deploying) |

## What's kept (MySQL database `tally`)

- `sites`: id, name, hostnames, and the SHA-256 of each site's key.
- `events`: one row per page view or event: site, time, visitor and visit ids, page path, query
  (without private values), title, referrer domain, country, browser, system, device, screen
  size, and for events their name and data. A visit is a visitor's hits with no gap of 30
  minutes or more. `source` is `umami` for rows copied from Umami.
- `salts`: this month's secret for visitor ids. `exports`: how far the BigQuery copy has got.

## BigQuery

Every hour a timer (Cloud Scheduler) calls `POST /jobs/export`, which adds the events not yet
copied to `<TALLY_DATASET>.events` (one table for every site; filter on `site_id`). The table is
made on the first export that has rows to send. Rows are only ever added, so if a run fails after
BigQuery loaded a batch, the same rows can arrive twice: views should keep one row per `id`, for
example
```sql
SELECT * FROM `my-project.tally.events`
WHERE site_id = 'blog'
QUALIFY ROW_NUMBER() OVER (PARTITION BY id) = 1
```

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
npm run add-site -- blog localhost "My Blog (local)"
npm test                     # about 3 seconds; each file gets its own tally_test_* database
KEEP_TEST_DB=1 npm test      # the same, keeping the test databases afterwards
```
To try the export from your machine, into a development dataset:
```bash
TALLY_DATASET=my-project.tally_dev JOBS_SECRET=x BIGQUERY_ACCESS_TOKEN=$(gcloud auth print-access-token) npm run dev
curl -X POST -H 'X-Job-Secret: x' http://localhost:3300/jobs/export
```

To add a site or change one in production, run `add-site` on your machine against the
production database, with the settings on the command line (they win over `.env`). On Cloud
SQL, open a tunnel first with
`cloud-sql-proxy --gcloud-auth --port 3307 <project>:<region>:<instance>`, then:
```bash
DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=tally DB_NAME=tally DB_PASSWORD='…' npm run add-site -- blog www.example.com "My Blog"
```

## Copying a site's history from Umami

`scripts/import-umami.js` copies a CSV exported from Umami's Postgres (the `\copy` command is at
the top of the script) into `events` as `source = 'umami'`, only for the time before the site's
first Tally row, keeping Umami's visitor and visit ids:
```bash
npm run import-umami -- blog umami.csv
```
It refuses a second copy unless given `--replace`.

## Deploying to Cloud Run

Build this folder (its `Dockerfile`) and deploy it as the Cloud Run service `tally`, connected
to the Cloud SQL instance, with the settings above. Each container start brings the database up
to date (`src/migrate.js`). For example:
```bash
gcloud run deploy tally --project <project> --region <region> --source . \
  --service-account tally-run@<project>.iam.gserviceaccount.com \
  --add-cloudsql-instances <project>:<region>:<instance> \
  --set-env-vars "DB_SOCKET=/cloudsql/<project>:<region>:<instance>,DB_USER=tally,DB_NAME=tally,TALLY_DATASET=<project>.tally,GIT_COMMIT=$(git rev-parse --short HEAD)" \
  --set-secrets "DB_PASSWORD=tally-db-password:latest,JOBS_SECRET=tally-jobs-secret:latest" \
  --allow-unauthenticated --min-instances 0 --max-instances 2 --memory 256Mi --timeout 600
gcloud run services logs read tally --project <project> --region <region>
```
A `deploy.sh` holding your own version of that command is ignored by git.

### One-time setup (in this order)

Below, `<project>`, `<region>` and `<instance>` are your Google Cloud project, region and Cloud
SQL instance.

1. **Database and login** on the MySQL instance (as an admin login, through `cloud-sql-proxy` or
   the console's Cloud SQL Studio):
   ```sql
   CREATE DATABASE tally CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'tally'@'%' IDENTIFIED BY '…';
   GRANT ALL PRIVILEGES ON tally.* TO 'tally'@'%';
   ```
   and the same password, plus a job secret, in Secret Manager (type the password in your own
   terminal):
   ```bash
   printf '%s' '…' | gcloud secrets create tally-db-password --project <project> --data-file=-
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets create tally-jobs-secret --project <project> --data-file=-
   ```
2. **Service account** `tally-run`:
   ```bash
   gcloud iam service-accounts create tally-run --project <project> --display-name "Tally"
   for role in roles/cloudsql.client roles/bigquery.jobUser; do
     gcloud projects add-iam-policy-binding <project> --member serviceAccount:tally-run@<project>.iam.gserviceaccount.com --role $role
   done
   for s in tally-db-password tally-jobs-secret; do
     gcloud secrets add-iam-policy-binding $s --project <project> --member serviceAccount:tally-run@<project>.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   done
   ```
   If the deploy needs it, also let your own account act as `tally-run`
   (`roles/iam.serviceAccountUser`).
3. **BigQuery dataset** `tally` (and `tally_dev` for local tries), with WRITER for `tally-run`,
   and READER for whatever draws your dashboards:
   ```bash
   bq mk --location=US -d <project>:tally
   bq mk --location=US -d <project>:tally_dev
   ```
   then give access in the console (dataset → Sharing → Permissions), or with `bq update`.
4. **Deploy** (above).
5. **Domain** (optional; the service's own `run.app` address works too): a Cloud Run domain
   mapping on `tally`, and a CNAME to `ghs.googlehosted.com.` wherever your DNS is:
   ```bash
   gcloud beta run domain-mappings create --service tally --domain tally.example.com --project <project> --region <region>
   ```
   Google issues the certificate after the CNAME is in place. That usually takes 15 to 60
   minutes, and the address can refuse HTTPS for a few more minutes after the console shows it
   ready.
6. **Sites:** `npm run add-site` against the production database (see above), and give each
   site's server its key, ideally in a secret.
7. **Timer:**
   ```bash
   gcloud scheduler jobs create http tally-export --project <project> --location <region> --schedule="10 * * * *" --uri=https://tally.example.com/jobs/export --http-method=POST --attempt-deadline=600s --headers="X-Job-Secret=$(gcloud secrets versions access latest --secret=tally-jobs-secret --project <project>)"
   ```

## License

No license yet: all rights reserved until one is added.
