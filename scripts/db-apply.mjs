// =====================================================================
// Apply db/*.sql in order.
//
//   node --env-file=.env scripts/db-apply.mjs
//
// Use the DIRECT Neon endpoint (no `-pooler`): these are schema changes,
// not concurrent traffic. Every file is re-runnable, so applying the set
// twice is a no-op rather than an error.
// =====================================================================

import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('set DIRECT_URL or DATABASE_URL');
  process.exit(1);
}

const files = readdirSync('db').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const client = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
});
await client.connect();

for (const f of files) {
  try {
    await client.query(readFileSync(`db/${f}`, 'utf8'));
    console.log('  applied', f);
  } catch (err) {
    console.log('  FAILED ', f, '::', err.message);
    await client.end();
    process.exit(1);
  }
}
await client.end();
console.log(`\n${files.length} files applied\n`);
