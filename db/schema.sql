-- Tally's database. src/migrate.js loads this into an empty database, then applies any file in
-- db/migrations not yet listed in schema_migrations. When you add a migration, make the same
-- change here and add its name to the INSERT at the bottom, so new databases match.
CREATE DATABASE IF NOT EXISTS tally CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tally;

-- The sites that report to Tally. id is the short name in the site's script tag (data-site).
-- hostnames: the hosts allowed to report for it, comma-separated (www.example.com,localhost).
-- api_key_hash: SHA-256 of the key the site's own server uses to read its numbers back.
CREATE TABLE IF NOT EXISTS sites (
  id           VARCHAR(30) NOT NULL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  hostnames    VARCHAR(500) NOT NULL,
  api_key_hash CHAR(64) NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per page view or event. No IP address or browser text is kept: the visitor is a hash
-- that changes each month (see salts). visit_id: a visitor's pages with no gap of 30 minutes or
-- more. Browser, os and device use Umami's names, so its history can be copied in and charts
-- carry on. source: 'tally' for rows counted here, 'umami' for rows copied from Umami.
CREATE TABLE IF NOT EXISTS events (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id         VARCHAR(30) NOT NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  visitor_id      CHAR(36) NOT NULL,
  visit_id        CHAR(36) NOT NULL,
  is_page_view    BOOLEAN NOT NULL,
  event_name      VARCHAR(50) NULL DEFAULT NULL,
  event_data      JSON NULL DEFAULT NULL,
  url_path        VARCHAR(500) NOT NULL,
  url_query       VARCHAR(500) NULL DEFAULT NULL,
  page_title      VARCHAR(300) NULL DEFAULT NULL,
  referrer_domain VARCHAR(255) NULL DEFAULT NULL,
  country         CHAR(2) NULL DEFAULT NULL,
  browser         VARCHAR(30) NULL DEFAULT NULL,
  os              VARCHAR(30) NULL DEFAULT NULL,
  device          VARCHAR(20) NULL DEFAULT NULL,
  screen          VARCHAR(11) NULL DEFAULT NULL,
  source          ENUM('tally', 'umami') NOT NULL DEFAULT 'tally',
  INDEX idx_site_time (site_id, created_at),
  INDEX idx_site_visitor_time (site_id, visitor_id, created_at),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- One random secret per month, mixed into each visitor's hash. Old months are deleted, so
-- nobody can tell whether two months' visitors were the same person.
CREATE TABLE IF NOT EXISTS salts (
  month CHAR(7) NOT NULL PRIMARY KEY,
  salt  BINARY(32) NOT NULL
);

-- How far events have been copied to each BigQuery table ("project.dataset.table").
CREATE TABLE IF NOT EXISTS exports (
  destination VARCHAR(200) NOT NULL PRIMARY KEY,
  last_id     BIGINT UNSIGNED NOT NULL DEFAULT 0
);

-- Which files in db/migrations are already part of this database.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
