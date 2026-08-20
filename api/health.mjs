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
      DEMO_TENANT_SLUG: Boolean(process.env.DEMO_TENANT_SLUG),
    },
    database: false,
    tenant: false,
    account: false,
    region: process.env.VERCEL_REGION ?? null,
  };

  try {
    const client = await getPool().connect();
    try {
      await client.query('select 1');
      report.database = true;

      // The tenant the server acts as must exist and must have an
      // account: every policy requires a signed-in member, so a tenant
      // without one reads nothing and every screen comes back empty.
      const { rows } = await client.query(
        `select count(u.id)::int as accounts
           from public.tenants t
           left join public.app_users u on u.tenant_id = t.id
          where t.slug = $1
          group by t.id`,
        [process.env.DEMO_TENANT_SLUG ?? ''],
      );
      report.tenant = rows.length > 0;
      report.account = (rows[0]?.accounts ?? 0) > 0;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[health]', err instanceof Error ? err.message : err);
  }

  report.ok = report.database && report.tenant && report.account;
  res.statusCode = report.ok ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(report, null, 2));
}
