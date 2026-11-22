// =====================================================================
// The identity pieces that need no database.
//
//   npm run test:identity
//
// Two-step codes against the RFC's own test vectors, sealing their
// secrets, the password policy and the generator that must always meet
// it, sessions (the idle timeout and the absolute limit), and reading the
// HR master file. Each is a place where being nearly right is wrong.
// =====================================================================

import { createServer } from 'vite';

const NL = String.fromCharCode(10);
process.env.JWT_SECRET ||= 'identity-test-secret-that-is-long-enough';

let passed = 0;
const failures = [];
function check(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { passed += 1; console.log(`  pass: ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true },
});
const totp = await vite.ssrLoadModule('/src/server/totp.ts');
const auth = await vite.ssrLoadModule('/src/server/auth.ts');
const policy = await vite.ssrLoadModule('/src/lib/password-policy.ts');
const hr = await vite.ssrLoadModule('/src/lib/hr-file.ts');
const identity = await vite.ssrLoadModule('/src/server/identity.ts');

console.log(NL + 'identity' + NL);

// ---------------------------------------------------------------------
// Two-step codes — RFC 6238 appendix B, SHA-1, last six digits.
// ---------------------------------------------------------------------
const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890'));
check('base32 of the RFC secret', rfcSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
check('base32 round-trips', totp.base32Decode(rfcSecret).toString(), '12345678901234567890');
const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
check('codes match the RFC 6238 vectors',
  vectors.map(([t]) => totp.totpAt(rfcSecret, Math.floor(t / 30))), vectors.map(([, c]) => c));

const now = 1_700_000_000_000;
const step = totp.currentStep(now);
const code = totp.totpAt(rfcSecret, step);
check('the current code is accepted, and says which step it was', totp.verifyTotp(rfcSecret, code, null, now), step);
check('...as is the one before, for a slow clock', totp.verifyTotp(rfcSecret, totp.totpAt(rfcSecret, step - 1), null, now), step - 1);
check('...but not one from two steps ago', totp.verifyTotp(rfcSecret, totp.totpAt(rfcSecret, step - 2), null, now), null);
check('a code already used is refused', totp.verifyTotp(rfcSecret, code, step, now), null);
check('spaces in a typed code are ignored', totp.verifyTotp(rfcSecret, code.slice(0, 3) + ' ' + code.slice(3), null, now), step);
check('anything but six digits is refused', [totp.verifyTotp(rfcSecret, '12345', null, now), totp.verifyTotp(rfcSecret, 'abcdef', null, now)], [null, null]);

const secret = totp.newTotpSecret();
const sealed = totp.sealSecret(secret);
check('a secret is stored sealed, not as itself', sealed.includes(secret), false);
check('...and opens back to itself', totp.openSecret(sealed), secret);
const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
check('a tampered seal opens to nothing', totp.openSecret(tampered), null);
check('the enrolment link carries the secret and the standard parameters',
  /^otpauth:\/\/totp\/.+\?secret=[A-Z2-7]+&issuer=.+&algorithm=SHA1&digits=6&period=30$/.test(totp.otpauthUrl(secret, 'farah.haddad')), true);

// ---------------------------------------------------------------------
// The password policy, and the generator that must meet it.
// ---------------------------------------------------------------------
check('a strong password passes', policy.passwordProblem('Correct-Horse-9', 'farah'), null);
check('too short', /12 characters/.test(policy.passwordProblem('Sh0rt!pw', 'x') ?? ''), true);
check('no upper case', /upper-case/.test(policy.passwordProblem('correct-horse-9', 'x') ?? ''), true);
check('no number', /a number/.test(policy.passwordProblem('Correct-Horse-x', 'x') ?? ''), true);
check('no special character', /special/.test(policy.passwordProblem('CorrectHorse99', 'x') ?? ''), true);
check('containing the username', /username/.test(policy.passwordProblem('Farah.Haddad-2026', 'farah.haddad') ?? ''), true);
let compliant = 0;
for (let i = 0; i < 2000; i++) if (policy.passwordProblem(auth.generatePassword(), 'someone') === null) compliant++;
check('every generated password meets the policy (2000 tries)', compliant, 2000);
check('generated passwords differ', auth.generatePassword() === auth.generatePassword(), false);

// ---------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------
const nowS = Math.floor(Date.now() / 1000);
const session = {
  tenantId: '00000000-0000-4000-8000-000000000001', tenantSlug: 't', userId: '00000000-0000-4000-8000-000000000002',
  username: 'u', role: 'admin', isStaff: false, mustChangePassword: false, tenantExpiresAt: null,
  employeeId: 'EMP-0445', personaName: 'Farah Haddad', personaTitle: 'Admin Officer', canSwitch: true,
  permissions: ['users.manage'], mfa: true, requireAdminMfa: true, seen: nowS,
};
const back = await auth.verifySession(await auth.signSession(session));
check('a session keeps who is acting, their permissions and the two-step flag',
  [back.employeeId, back.permissions, back.mfa, back.canSwitch, back.requireAdminMfa],
  ['EMP-0445', ['users.manage'], true, true, true]);
check('five minutes without a request is idle', auth.isIdle({ ...session, seen: nowS - 301 }, nowS), true);
check('...four is not', auth.isIdle({ ...session, seen: nowS - 240 }, nowS), false);
check('a token from before the idle timeout counts as idle', auth.isIdle({ ...session, seen: 0 }, nowS), true);
const old = await auth.verifySession(await auth.signSession({ ...session, born: nowS - 13 * 3600 }));
check('reissuing a session does not extend it past 12 hours from sign-in', old, null);
check('without two-step sign-in, administrative permissions are held back',
  identity.effectivePermissions({ ...session, mfa: false, permissions: ['users.manage', 'forms.build'] }), ['forms.build']);
check('...and holds them all with it', identity.effectivePermissions({ ...session, permissions: ['users.manage', 'forms.build'] }), ['users.manage', 'forms.build']);
const pending = await auth.signMfaPending(session.userId);
check('half-way through sign-in names the account', await auth.verifyMfaPending(pending), session.userId);
check('...and a full session token is not one', await auth.verifyMfaPending(await auth.signSession(session)), null);

// ---------------------------------------------------------------------
// The HR master file.
// ---------------------------------------------------------------------
const file = [
  '﻿Staff No;Full Name;Dept;Job Title;Reports To;Work Email',
  'BK-1;"Uddin, Rahim";Finance;Head of Finance;;rahim@example.com',
  'BK-2;Karim Ahmed;Finance;"Officer; Payables";BK-1;',
  '',
].join('\r\n');
const parsed = hr.readHrFile(file);
check('headers are recognised by meaning, semicolons and a BOM included',
  parsed.columns, { employee_id: 'Staff No', name: 'Full Name', department: 'Dept', designation: 'Job Title', line_manager_id: 'Reports To', email: 'Work Email' });
check('quoted fields keep their commas and semicolons', [parsed.rows[0].name, parsed.rows[1].designation], ['Uddin, Rahim', 'Officer; Payables']);
check('an empty cell is empty, and blank lines are skipped', [parsed.rows[1].email, parsed.rows.length], [null, 2]);
const partial = hr.readHrFile('id,name\nBK-9,Somebody');
check('a column the file lacks is absent from every row, so the import leaves it alone',
  Object.keys(partial.rows[0]), ['employee_id', 'name']);
check('a file without names is refused with what is missing', hr.readHrFile('id,dept\n1,x').missing, ['name']);

await vite.close();
if (failures.length) {
  console.log(`${NL}${failures.length} IDENTITY CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`${NL}ALL IDENTITY CHECKS PASSED (${passed})`);
