// =====================================================================
// Database suites.
//
//   node --env-file=.env scripts/db-test.mjs            # all of them
//   node --env-file=.env scripts/db-test.mjs rls        # just one
//
// Point DATABASE_URL at a SCRATCH database. These create and delete
// tenants, and the isolation suite expects the schema without the seed.
//
// Every suite raises on the first failure, so reaching the final line is
// the pass condition.
// =====================================================================

import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';

// Run over the DIRECT endpoint, never the pooler.
//
// These suites set session-level configuration to carry fixture ids
// between statements, and a transaction pooler hands one server
// connection to many clients — so `app.is_staff = true`, set by one
// suite, arrived in the next one's connection and quietly disabled every
// policy that consults it. The application itself is unaffected: it sets
// context transaction-locally, which is exactly the setting a pooler
// resets.
const URL = process.env.DIRECT_URL || process.env.DATABASE_URL;

const BACKSLASH = String.fromCharCode(92);
const NL = String.fromCharCode(10);

const only = process.argv[2];
const suites = readdirSync('db/tests')
  .filter((f) => f.endsWith('_test.sql'))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!suites.length) {
  console.error(only ? `no suite matching "${only}"` : 'no suites found');
  process.exit(1);
}

if (!URL) {
  console.error('set DIRECT_URL or DATABASE_URL (use node --env-file=.env)');
  process.exit(1);
}
if (/-pooler\./.test(URL)) {
  console.error('refusing to run against the pooled endpoint — set DIRECT_URL');
  process.exit(1);
}

let total = 0;
let failed = 0;

for (const file of suites) {
  const client = new pg.Client({
    connectionString: URL,
    ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
  });
  const notices = [];
  client.on('notice', (n) => notices.push(n.message));

  console.log(NL + file.replace('_test.sql', ''));
  await client.connect();

  // psql meta-commands mean nothing to the driver.
  const sql = readFileSync(`db/tests/${file}`, 'utf8')
    .split(NL)
    .filter((l) => !l.startsWith(BACKSLASH))
    .join(NL);

  try {
    await client.query(sql);
    const passes = notices.filter((m) => m.startsWith('pass:'));
    passes.forEach((m) => console.log('  ' + m));
    total += passes.length;
  } catch (err) {
    notices.filter((m) => m.startsWith('pass:')).forEach((m) => console.log('  ' + m));
    console.log('  FAIL: ' + err.message);
    failed += 1;
  } finally {
    await client.end();
  }
}

if (failed) {
  console.log(NL + `${failed} suite(s) failed` + NL);
  process.exit(1);
}
console.log(NL + `ALL DATABASE SUITES PASSED (${total} checks)` + NL);
