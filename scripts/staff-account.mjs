// =====================================================================
// Create or reset the account that runs the evaluations console.
//
//   node --env-file=.env scripts/staff-account.mjs
//   node --env-file=.env scripts/staff-account.mjs --user me --password ...
//
// A staff account has no tenant, which is what the schema's tenancy rule
// requires and what keeps it from reading any prospect's data: every
// policy is written against a tenant it does not have.
//
// Prints the password once. It is stored hashed.
// =====================================================================

import pg from 'pg';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// Same format as src/server/auth.ts: scrypt$<salt>$<hash>.
async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return ['scrypt', salt.toString('hex'), derived.toString('hex')].join('$');
}

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const USERNAME = arg('--user', 'staff');
const PASSWORD = arg('--password', 'staff-' + randomBytes(6).toString('hex'));
const FULL_NAME = arg('--name', 'Platform staff');

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) { console.error('set DIRECT_URL or DATABASE_URL'); process.exit(1); }

const c = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
});
await c.connect();

const hash = await hashPassword(PASSWORD);

const { rows } = await c.query(
  `insert into public.app_users (tenant_id, username, password_hash, full_name, role, is_staff)
   values (null, $1, $2, $3, 'admin', true)
   on conflict on constraint app_users_username_key
   do update set password_hash = excluded.password_hash,
                 is_staff = true,
                 status = 'active',
                 must_change_pw = false,
                 password_changed_at = now()
   returning id, (xmax = 0) as created`,
  [USERNAME, hash, FULL_NAME],
).catch(async (err) => {
  // The unique index is on lower(username) and is not a named
  // constraint, so ON CONFLICT cannot target it. Fall back to an update.
  if (!/constraint|conflict/i.test(err.message)) throw err;
  const upd = await c.query(
    `update public.app_users
        set password_hash = $2, is_staff = true, status = 'active',
            must_change_pw = false, password_changed_at = now()
      where lower(username) = lower($1)
      returning id, false as created`,
    [USERNAME, hash]);
  if (upd.rows.length) return upd;
  return c.query(
    `insert into public.app_users (tenant_id, username, password_hash, full_name, role, is_staff)
     values (null, $1, $2, $3, 'admin', true)
     returning id, true as created`,
    [USERNAME, hash, FULL_NAME]);
});

console.log(`\n  ${rows[0].created ? 'created' : 'reset'} staff account\n`);
console.log(`  username  ${USERNAME}`);
console.log(`  password  ${PASSWORD}\n`);
console.log('  Sign in at /login, then open /staff.\n');

await c.end();
