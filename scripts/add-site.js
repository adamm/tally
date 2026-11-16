// Adds a site to Tally, or gives an existing one new hostnames and a new key, and prints the key
// once (it isn't stored). Uses the database settings in .env (or the environment).
//   npm run add-site -- <id> <hostname>[,<hostname>...] ["Site name"]
//   npm run add-site -- bsh www.buysellhorth.com,localhost "BuySellHorth"
// The key goes in the site's own server settings, for reading its numbers back (stats.js).
import { saveSite } from '../src/sites.js';
import { pool } from '../src/db.js';

const [id, hostnames, name] = process.argv.slice(2);
if (!id || !hostnames) {
  console.error('Usage: npm run add-site -- <id> <hostname>[,<hostname>...] ["Site name"]');
  process.exit(1);
}
try {
  const key = await saveSite({ id, name, hostnames: hostnames.split(',') });
  console.log(`Saved site "${id}" for ${hostnames}.`);
  console.log(`Its key (shown only now): ${key}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
