-- Each site's all-time totals up to the start of an hour (see stats.js), so all-time numbers only
-- count what came since. Kept up to date by POST /jobs/totals, every hour.
CREATE TABLE IF NOT EXISTS totals (
  site_id    VARCHAR(30) NOT NULL PRIMARY KEY,
  upto       TIMESTAMP(3) NOT NULL,
  first_at   TIMESTAMP(3) NULL DEFAULT NULL,
  pageviews  BIGINT UNSIGNED NOT NULL,
  visitors   BIGINT UNSIGNED NOT NULL,
  visits     BIGINT UNSIGNED NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);
