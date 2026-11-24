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

if (!suites.length && !(only && 'reapply'.includes(only))) {
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

// ---------------------------------------------------------------------
// Re-applying over a database that is in use.
//
// `db:apply` runs every file again against the deployed database, which
// has evaluations in it — clones of the template, carrying the same
// employee ids and reference numbers. The seed runs as the owner, which
// bypasses the policies, so anything it looks up by such a key reaches
// into every clone at once. A fresh database has no clones and cannot
// show that; this does. It is the failure that stopped a Stage 2 deploy.
// ---------------------------------------------------------------------
if (!only || 'reapply'.includes(only)) {
  console.log(NL + 'reapply');
  const db = await freshDatabase();
  try {
    await db.exec(`select set_config('app.is_staff', 'true', false)`);
    await db.query(`select * from app.provision_demo('Reapply A', 'reapply.a', 'x', interval '1 day')`);
    await db.query(`select * from app.provision_demo('Reapply B', 'reapply.b', 'x', interval '1 day')`);
    await db.exec(`select set_config('app.is_staff', 'false', false)`);
    for (const f of migrations) await db.exec(readFileSync(`db/${f}`, 'utf8'));
    const { rows } = await db.query(
      `select count(*)::int as n from public.tenants where kind = 'demo'`);
    if (rows[0].n !== 2) throw new Error(`re-applying left ${rows[0].n} evaluations, not 2`);
    console.log('  pass: every migration re-applies over a database with evaluations in it');
    total += 1;
    // The template is rebuilt with evaluations beside it: its notices,
    // stationery and maintenance must be built from its own rules only,
    // once — not once for every organisation there is.
    const { rows: dup } = await db.query(
      `select count(*)::int as n from (
         -- A copy sat in a parallel track of its own, so the lane is not
         -- what tells copies apart: these chains have no parallel tracks.
         select subject_id, step_index, approver_user_id
           from public.approval_requests
          where subject_type in ('notice', 'stationery_request', 'maintenance_request')
          group by 1, 2, 3, tenant_id having count(*) > 1) d`);
    if (dup[0].n !== 0) throw new Error(`${dup[0].n} approval steps are there more than once`);
    console.log('  pass: rebuilt beside evaluations, the template builds each chain from its own rules, once');
    total += 1;
  } catch (err) {
    console.log('  FAIL: re-applying over evaluations: ' + err.message);
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
