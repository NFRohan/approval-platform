// =====================================================================
// Mint (or find) an evaluation for local development.
//
//   node --env-file=.env scripts/dev-tenant.mjs
//   node --env-file=.env scripts/dev-tenant.mjs --fresh   # start over
//
// --fresh discards the evaluation and clones a new one from the
// template. Walking a demo changes it — approvals get approved,
// requests get raised — and the next walkthrough should start where the
// last one did.
//
// The template tenant deliberately has no account — accounts belong to
// evaluations, which are clones of it. Since every policy requires a
// signed-in member, local development needs a real evaluation rather
// than the template, which is also how production will work.
//
// Prints the credentials once. Sign-in reads them from the database, so
// there is nothing to put in .env any more.
// =====================================================================

import pg from 'pg';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// The same format src/server/auth.ts reads: scrypt$<salt>$<hash>.
// Duplicated here rather than imported because this is a plain script
// and that is TypeScript inside the app's module graph — if the format
// ever changes, both move together.
async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return ['scrypt', salt.toString('hex'), derived.toString('hex')].join('$');
}

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) { console.error('set DIRECT_URL or DATABASE_URL'); process.exit(1); }

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const NAME = arg('--name', 'Local Development');
const USERNAME = arg('--user', 'dev.local');
const DAYS = Number(arg('--days', '365'));
// Readable, and long enough that it is not the weak part. Printed once.
const PASSWORD = arg('--password', 'demo-' + randomBytes(6).toString('hex'));

const c = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
});
await c.connect();

const existing = await c.query(
  `select t.slug from public.tenants t
     join public.app_users u on u.tenant_id = t.id
    where u.username = $1 limit 1`, [USERNAME]);

const fresh = process.argv.includes('--fresh');

if (existing.rows.length && !fresh) {
  console.log(`\n  ${USERNAME} already exists (slug ${existing.rows[0].slug}).`);
  console.log('  Use --fresh to discard it and issue a new one with a new password.\n');
  await c.end();
  process.exit(0);
}

if (existing.rows.length && fresh) {
  // Cascades through every table the clone owns.
  await c.query('delete from public.tenants where slug = $1', [existing.rows[0].slug]);
  console.log(`\n  discarded ${existing.rows[0].slug}`);
}

await c.query(`select set_config('app.is_staff', 'true', false)`);
const { rows } = await c.query(
  'select * from app.provision_demo($1, $2, $3, $4::interval)',
  [NAME, USERNAME, await hashPassword(PASSWORD), `${DAYS} days`],
);

console.log(`\n  minted "${NAME}", expires in ${DAYS} days\n`);
console.log(`  username  ${USERNAME}`);
console.log(`  password  ${PASSWORD}`);
console.log(`  slug      ${rows[0].slug}\n`);
console.log('  The password is shown once and is not recoverable — it is stored');
console.log('  hashed. Sign in at /login. The evaluation is a full clone of the');
console.log('  template, so every screen has data.\n');
await c.end();
