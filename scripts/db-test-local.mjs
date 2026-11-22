// =====================================================================
// Database suites, against a throwaway in-process Postgres.
//
//   npm run db:test:local            # all of them
//   npm run db:test:local -- chain   # just one
//
// `db:test` needs a scratch database somewhere, and the one this project
// has is the Neon database the deployed demo runs on. Testing a change
// to the chain engine there means applying it there first — changing the
// live demo to find out whether the change works.
//
// PGlite is Postgres itself compiled to WebAssembly, running inside this
// process: no server, no port, no credentials, and nothing left behind.
// Each suite gets a database of its own with every migration applied,
// because the suites leave session settings behind them (provisioning
// sets app.is_staff) and one suite's leftovers quietly disable the next
// one's policies — the same reason `db:test` refuses a pooler.
//
// It is the real planner and the real PL/pgSQL, so a pass here is a pass
// on the engine. What it cannot show is anything Neon-specific: the
// owner's BYPASSRLS, connection pooling, extensions Neon adds. Run
// `db:test` against a scratch branch before relying on those.
// =====================================================================

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const BACKSLASH = String.fromCharCode(92);
const NL = String.fromCharCode(10);

const only = process.argv[2];
const migrations = readdirSync('db').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const suites = readdirSync('db/tests')
  .filter((f) => f.endsWith('_test.sql'))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!suites.length) {
  console.error(only ? `no suite matching "${only}"` : 'no suites found');
  process.exit(1);
}

async function freshDatabase() {
  const db = new PGlite();
  for (const f of migrations) {
    try {
      await db.exec(readFileSync(`db/${f}`, 'utf8'));
    } catch (err) {
      console.log(`  migration ${f} FAILED: ${err.message}`);
      process.exit(1);
    }
  }
  return db;
}

let total = 0;
let failed = 0;

for (const file of suites) {
  console.log(NL + file.replace('_test.sql', ''));
  const db = await freshDatabase();

  // psql meta-commands mean nothing to the driver.
  const sql = readFileSync(`db/tests/${file}`, 'utf8')
    .split(NL)
    .filter((l) => !l.startsWith(BACKSLASH))
    .join(NL);

  const passes = [];
  try {
    await db.exec(sql, {
      onNotice: (n) => { if (n.message.startsWith('pass:')) passes.push(n.message); },
    });
    passes.forEach((m) => console.log('  ' + m));
    total += passes.length;
  } catch (err) {
    passes.forEach((m) => console.log('  ' + m));
    console.log('  FAIL: ' + err.message);
    failed += 1;
  } finally {
    await db.close();
  }
}

console.log('');
if (failed) {
  console.log(`${failed} SUITE(S) FAILED (${total} checks passed before failing)`);
  process.exit(1);
}
console.log(`ALL DATABASE SUITES PASSED (${total} checks, local)`);
