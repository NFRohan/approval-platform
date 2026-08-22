// =====================================================================
// Is this deployment actually wired up?
//
// A deployment that builds, serves HTML and cannot reach its database
// looks entirely healthy from the outside: every route returns 200,
// because the data is fetched afterwards from the browser. This asks the
// three questions that distinguish the two.
//
// It reports what is true, never what it is: no connection string, no
// secret, no error text from the driver — those name hosts and roles.
// =====================================================================

import pg from 'pg';

const { Pool } = pg;
let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 8_000,
    });
  }
  return pool;
}

export default async function handler(_req, res) {
  const report = {
    ok: false,
    env: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      JWT_SECRET: Boolean(process.env.JWT_SECRET),

    },
    database: false,
    evaluations: 0,
    staffAccount: false,
    region: process.env.VERCEL_REGION ?? null,
  };

  try {
    const client = await getPool().connect();
    try {
      await client.query('select 1');
      report.database = true;

      // Nothing is "the configured tenant" any more — the session names
      // it. What matters is that there is at least one live evaluation
      // with an account somebody could actually sign into.
      const { rows } = await client.query(
        `select count(*)::int as usable
           from public.tenants t
           join public.app_users u on u.tenant_id = t.id
          where app.tenant_status(t.id) = 'active'`);
      report.evaluations = rows[0]?.usable ?? 0;

      // Without one of these nobody can issue an evaluation, which is a
      // different kind of broken from having none to sign into.
      const staff = await client.query(
        'select count(*)::int as n from public.app_users where is_staff = true');
      report.staffAccount = (staff.rows[0]?.n ?? 0) > 0;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[health]', err instanceof Error ? err.message : err);
  }

  report.ok = report.database && report.evaluations > 0 && report.staffAccount;
  res.statusCode = report.ok ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(report, null, 2));
}
