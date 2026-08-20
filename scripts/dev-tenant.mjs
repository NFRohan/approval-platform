// =====================================================================
// Mint (or find) an evaluation for local development.
//
//   node --env-file=.env scripts/dev-tenant.mjs
//
// The template tenant deliberately has no account — accounts belong to
// evaluations, which are clones of it. Since every policy requires a
// signed-in member, local development needs a real evaluation rather
// than the template, which is also how production will work.
//
// Prints the slug to put in DEMO_TENANT_SLUG.
// =====================================================================

import pg from 'pg';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) { console.error('set DIRECT_URL or DATABASE_URL'); process.exit(1); }

const NAME = 'Local Development';
const USERNAME = 'dev.local';

const c = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
});
await c.connect();

const existing = await c.query(
  `select t.slug from public.tenants t
     join public.app_users u on u.tenant_id = t.id
    where u.username = $1 limit 1`, [USERNAME]);

if (existing.rows.length) {
  console.log(`\n  already exists\n\n  DEMO_TENANT_SLUG=${existing.rows[0].slug}\n`);
  await c.end();
  process.exit(0);
}

await c.query(`select set_config('app.is_staff', 'true', false)`);
const { rows } = await c.query(
  `select * from app.provision_demo($1, $2, $3, interval '365 days')`,
  [NAME, USERNAME, 'not-a-real-hash-until-sign-in-lands'],
);

console.log(`\n  minted "${NAME}"\n\n  DEMO_TENANT_SLUG=${rows[0].slug}\n`);
console.log('  Put that in .env. It is a full clone of the template, so every');
console.log('  screen has data.\n');
await c.end();
