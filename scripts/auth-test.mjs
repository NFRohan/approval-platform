// =====================================================================
// Sign-in, sessions, and whether withdrawing an evaluation does anything.
//
//   npm run test:auth
//
// This suite exists because the other four could not have caught what
// went wrong. The SQL suites test policies, the call-site test checks
// shapes, the render test mounts components — none of them walks a path
// through the layers, which is where all three auth bugs lived:
//
//   * a staff session was signed and then rejected on the next request,
//     so the console could never be opened at all;
//   * a withdrawn evaluation kept full read and write for the life of
//     its token, making revoke advisory;
//   * the sign-in path's timing equalisation returned early and did
//     nothing, which is the leak it was written to prevent.
//
// Runs against a real database over DIRECT_URL, and cleans up after
// itself.
// =====================================================================

import { createServer } from 'vite';
import pg from 'pg';

const NL = String.fromCharCode(10);
let passed = 0;
const failures = [];

function check(label, got, want) {
  if (got === want) { passed += 1; console.log(`  pass: ${label}`); return; }
  failures.push(`${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(`  FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) { console.error('set DIRECT_URL'); process.exit(1); }
if (/-pooler\./.test(url)) {
  console.error(NL + 'refusing a pooled endpoint: this suite sets session state' + NL);
  process.exit(1);
}
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-to-pass';

const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom',
  logLevel: 'error', optimizeDeps: { noDiscovery: true },
});
const {
  hashPassword, verifyPassword, generatePassword, signSession, verifySession,
} = await vite.ssrLoadModule('/src/server/auth.ts');
const { withContext } = await vite.ssrLoadModule('/src/server/db.ts');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log(NL + 'auth' + NL);

// ---------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------
const stored = await hashPassword('correct horse battery staple');
check('the right password verifies', await verifyPassword('correct horse battery staple', stored), true);
check('the wrong password does not', await verifyPassword('correct horse battery stapler', stored), false);
check('a malformed stored hash does not', await verifyPassword('anything', 'not-a-hash'), false);
check('an empty stored hash does not', await verifyPassword('anything', ''), false);

check('generated passwords are not guessable from each other',
  generatePassword() === generatePassword(), false);
check('generated passwords are long enough', generatePassword().length >= 20, true);

// The reason the fake hash exists at all: a username that does not exist
// must cost what a wrong password costs. Measured, because the first
// implementation returned before doing any work and read as correct.
const time = async (fn) => {
  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    await fn();
    runs.push(performance.now() - t0);
  }
  return runs.sort((a, b) => a - b)[2]; // median
};
const wrongPassword = await time(() => verifyPassword('nope', stored));
const missingUser = await time(() => verifyPassword('nope', 'scrypt$00$00'));
const ratio = missingUser / wrongPassword;
check('a missing username costs about what a wrong password costs', ratio > 0.5, true);
if (ratio <= 0.5) {
  console.log(`        missing-user ${missingUser.toFixed(1)}ms vs wrong-password ${wrongPassword.toFixed(1)}ms`);
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------
const prospect = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantSlug: 'x', userId: 'u-1',
  username: 'p', role: 'admin', isStaff: false, mustChangePassword: false, tenantExpiresAt: null,
};
const staff = { ...prospect, tenantId: null, isStaff: true, username: 's' };

check('a prospect session verifies', !!(await verifySession(await signSession(prospect))), true);

// The blocker: staff hold no tenant by schema rule, and requiring one
// meant the console could be signed into but never opened.
check('a staff session verifies despite having no tenant',
  !!(await verifySession(await signSession(staff))), true);
check('...and still says it is staff',
  (await verifySession(await signSession(staff)))?.isStaff, true);
check('...and carries a null tenant rather than a string',
  (await verifySession(await signSession(staff)))?.tenantId, null);

check('a session with no tenant and no staff flag is refused',
  await verifySession(await signSession({ ...prospect, tenantId: null })), null);

const good = await signSession(prospect);
check('a tampered token is refused', await verifySession(`${good.slice(0, -3)}aaa`), null);
check('a token signed with another secret is refused',
  await verifySession(`${good.split('.').slice(0, 2).join('.')}.aaaa`), null);
check('no token at all is refused', await verifySession(undefined), null);

// ---------------------------------------------------------------------
// Withdrawal and expiry take effect on the next request
// ---------------------------------------------------------------------
await c.query(`delete from public.tenants where slug like 'authtest%'`);
await c.query(`select set_config('app.is_staff','true',false)`);

const mint = async (name, user, ttl) => (await c.query(
  'select * from app.provision_demo($1,$2,$3,$4::interval)',
  [name, user, await hashPassword('x'), ttl])).rows[0];

const live = await mint('Authtest Live', 'authtest.live', '30 days');
const doomed = await mint('Authtest Doomed', 'authtest.doomed', '30 days');
const userOf = async (u) => (await c.query('select id from public.app_users where username=$1', [u])).rows[0].id;

const canRead = async (tenantId, userId) => {
  try {
    return await withContext({ tenantId, userId, role: 'admin', isStaff: false },
      async (client) => (await client.query('select count(*)::int n from public.form_templates')).rows[0].n >= 0);
  } catch (err) {
    return err.code === '28000' ? 'refused' : `error:${err.code ?? err.message}`;
  }
};

check('an active evaluation can read its own data',
  await canRead(live.tenant_id, await userOf('authtest.live')), true);

await c.query('select app.revoke_demo($1)', [doomed.tenant_id]);
check('a withdrawn evaluation is refused on the very next request',
  await canRead(doomed.tenant_id, await userOf('authtest.doomed')), 'refused');

// Expiry is the same door, reached a different way.
await c.query(`update public.tenants set revoked_at = null, expires_at = now() - interval '1 day'
                where id = $1`, [doomed.tenant_id]);
check('an expired evaluation is refused too',
  await canRead(doomed.tenant_id, await userOf('authtest.doomed')), 'refused');

check('the live evaluation is still fine afterwards',
  await canRead(live.tenant_id, await userOf('authtest.live')), true);

// Staff hold no tenant, so there is nothing to expire and the check
// must not refuse them.
const staffId = (await c.query('select id from public.app_users where is_staff = true limit 1')).rows[0]?.id;
if (staffId) {
  let ok = false;
  try {
    ok = await withContext({ tenantId: null, userId: staffId, role: 'admin', isStaff: true },
      async (client) => (await client.query(`select count(*)::int n from public.tenants where kind='demo'`)).rows[0].n > 0);
  } catch { ok = false; }
  check('a staff request passes the liveness check', ok, true);
}

// ---------------------------------------------------------------------
// Search escaping — % and _ are wildcards, and were not escaped
// ---------------------------------------------------------------------
const esc = (q) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const matches = async (raw) => withContext(
  { tenantId: live.tenant_id, userId: await userOf('authtest.live'), role: 'admin', isStaff: false },
  async (client) => (await client.query(
    'select count(*)::int n from public.employees where name ilike $1', [esc(raw)])).rows[0].n);

const everyone = await withContext(
  { tenantId: live.tenant_id, userId: await userOf('authtest.live'), role: 'admin', isStaff: false },
  async (client) => (await client.query('select count(*)::int n from public.employees')).rows[0].n);

check('there are employees to search', everyone > 0, true);
check('a bare percent sign matches nothing rather than everything', await matches('%'), 0);
check('an underscore is a literal, not a wildcard', await matches('a_ex'), 0);
check('an ordinary name still matches', (await matches('Alex')) > 0, true);

// ---------------------------------------------------------------------
await c.query(`delete from public.tenants where slug like 'authtest%'`);
await c.end();
await vite.close();

if (failures.length) {
  console.log(NL + `${failures.length} AUTH CHECK(S) FAILED` + NL);
  process.exit(1);
}
console.log(NL + `ALL AUTH CHECKS PASSED (${passed} checks)` + NL);
