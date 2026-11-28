
// ================================================================ Stage 3
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function code(secret, step = Math.floor(Date.now() / 30000)) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', b32decode(secret)).update(c).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
async function signOut() {
  await ctx.clearCookies();
  await page.goto(BASE + '/login');
  await settle(800);
}
async function signInAs(user, pass) {
  await page.goto(BASE + '/login');
  await page.locator('input[autocomplete="username"]').fill(user);
  await page.locator('input[autocomplete="current-password"]').fill(pass);
  await page.locator('input[autocomplete="current-password"]').press('Enter');
  await settle(2200);
}
const acting = async () => (await page.locator('[data-testid="acting-as"]').first().innerText()).trim();
const sidebar = async () => page.locator('aside').innerText();
const audit = async (action) => (await one(`select count(*)::int n from public.activity_log where tenant_id = $1 and action = $2`, [tenant, action])).n;

// ------------------------------------------------- personas and permissions
await page.goto(BASE + '/');
await settle(2500);
ok('an evaluation starts as its default persona', (await acting()) === 'Tom Bexley', await acting());
let side = await sidebar();
ok('...who administers nothing, so is offered nothing to administer', !/Administration|Form Builder|Users/.test(side));

await page.goto(BASE + '/?as=EMP-0445');
await settle(2500);
ok('?as= switches persona, on the server', (await acting()) === 'Farah Haddad', await acting());
side = await sidebar();
ok('...and the System administrator is offered users, roles and people', side.includes('Users') && side.includes('Roles') && side.includes('People & Directory'));
ok('...and the switch is on the trail', (await audit('persona_switched')) >= 1);

// ------------------------------------------------- the builder, by permission
const leave = await formId('Leave Application');
await page.goto(`${BASE}/builder/approvers?templateId=${leave}&as=EMP-2847`);
await settle(2500);
ok('somebody who cannot design sees the workflow read-only', /viewing this workflow/i.test(await page.locator('[data-testid="builder-access"]').innerText()));

await page.goto(`${BASE}/builder/approvers?templateId=${leave}&as=EMP-0312`);
await settle(2500);
ok('Workflow settings may change task settings only', /task settings/i.test(await page.locator('[data-testid="builder-access"]').innerText()));
const rulesBefore = await rows(`select id, approver_user_id, label from public.approval_rules where form_template_id = $1 order by id`, [leave]);
await page.locator('input[aria-label="Working days to respond"]').first().fill('9');
await page.locator('input[aria-label="Signature required"]').first().check();
await page.getByRole('button', { name: /Save task settings/ }).click();
await settle(2000);
const rulesAfter = await rows(`select id, approver_user_id, label, deadline_days, require_signature from public.approval_rules where form_template_id = $1 order by id`, [leave]);
ok('...which are saved', rulesAfter.some((r) => r.deadline_days === 9 && r.require_signature === true));
ok('...without touching who approves', JSON.stringify(rulesBefore.map((r) => [r.id, r.approver_user_id, r.label])) === JSON.stringify(rulesAfter.map((r) => [r.id, r.approver_user_id, r.label])));
ok('...and the change is on the trail', (await audit('task_settings_changed')) >= 1);

// ------------------------------------------------- who a form is for
await page.goto(`${BASE}/builder?templateId=${leave}&as=EMP-0201`);
await settle(3500);
await page.locator('[data-testid="form-settings"] input[name="audience-HR"]').check();
await settle(1500);
ok('a designer sets who a form is for', JSON.stringify((await one(`select audience_departments a from public.form_templates where id = $1`, [leave])).a) === '["HR"]');
await page.goto(`${BASE}/forms?as=EMP-2847`);
await settle(2500);
ok('...and it is not offered outside it', !(await text()).includes('Leave Application'));
await page.goto(`${BASE}/forms?as=EMP-0650`);
await settle(2500);
ok('...but is inside it', (await text()).includes('Leave Application'));
await rows(`update public.form_templates set audience_departments = null where id = $1`, [leave]);

// ------------------------------------------------- accounts, maker-checker
await page.goto(`${BASE}/admin/users?as=EMP-0445`);
await settle(2500);
await page.getByRole('button', { name: /Register an account/ }).click();
await page.locator('select[name="employee"]').selectOption('EMP-3120');
ok('a username is suggested from the name', (await page.locator('input[name="username"]').inputValue()) === 'mei.sun');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2500);
const temp = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
ok('registering shows a temporary password once', /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(temp), temp);
// The hash is kept in the vault, apart from the account (db/009_sow_gaps.sql).
let acct = await one(`select u.approval_state, u.created_by_employee, u.password_hash as row_hash, c.password_hash from public.app_users u left join vault.credentials c on c.user_id = u.id where u.username = 'mei.sun'`);
ok('...stores only its hash, in the vault, and the account waits', acct.approval_state === 'pending' && acct.created_by_employee === 'EMP-0445' && acct.password_hash?.startsWith('scrypt$') && !acct.password_hash.includes(temp) && acct.row_hash === null, JSON.stringify({ ...acct, password_hash: acct.password_hash?.slice(0, 8) }));
ok('the person who registered it cannot approve it', (await page.locator('[data-testid="waiting"]').innerText()).includes('needs users.approve'));

await signOut();
await signInAs('mei.sun', temp);
ok('an account waiting for approval cannot sign in', /waiting for approval/i.test(await text()));

await signInAs(USER, PASS);
await page.goto(`${BASE}/admin/users?as=EMP-0650`);
await settle(2500);
await page.locator('button[name="approve-mei.sun"]').click();
await settle(2000);
acct = await one(`select approval_state, approved_by_employee from public.app_users where username = 'mei.sun'`);
ok('somebody else approves it', acct.approval_state === 'approved' && acct.approved_by_employee === 'EMP-0650');

// ------------------------------------------------- a person's own account
await signOut();
await signInAs('mei.sun', temp);
ok('a first sign-in must choose a password', /Choose a password/.test(await text()));
const np = page.locator('input[autocomplete="new-password"]');
await np.nth(0).fill('meisun-password');
await np.nth(1).fill('meisun-password');
await page.getByRole('button', { name: /Save and continue/ }).click();
await settle(1200);
ok('...that meets the policy', /needs:.*upper-case.*number/i.test(await text()));
const MEI_PW = 'Procure-Ment-2026!';
await np.nth(0).fill(MEI_PW);
await np.nth(1).fill(MEI_PW);
await page.getByRole('button', { name: /Save and continue/ }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
await settle(2500);
ok('then she is in, as herself', (await acting()) === 'Mei Sun');
ok('...with no persona switcher', (await page.getByRole('button', { name: 'Switch persona' }).count()) === 0);
await page.goto(BASE + '/?as=EMP-0445');
await settle(2500);
ok('...and ?as= does not make her anybody else', (await acting()) === 'Mei Sun');
ok('...nor does the menu offer administration', !/Administration/.test(await sidebar()));

// ------------------------------------------------- lockout
await signOut();
for (let i = 0; i < 10; i++) {
  await page.locator('input[autocomplete="username"]').fill('mei.sun');
  await page.locator('input[autocomplete="current-password"]').fill('wrong-' + i);
  await page.locator('input[autocomplete="current-password"]').press('Enter');
  await settle(700);
}
ok('ten wrong passwords lock the account', !!(await one(`select locked_at from public.app_users where username = 'mei.sun'`)).locked_at);
await signInAs('mei.sun', MEI_PW);
ok('...so even the right one is refused, and says why', /locked/i.test(await text()));
ok('...and the lock is on the trail', (await one(`select count(*)::int n from public.activity_log where tenant_id = $1 and action = 'account_locked' and detail like 'mei.sun %'`, [tenant])).n === 1);

await signInAs(USER, PASS);
await page.goto(`${BASE}/admin/users?as=EMP-0445`);
await settle(2500);
await page.locator('[data-username="mei.sun"]').getByRole('button', { name: /Unlock/ }).click();
await settle(2000);
await signOut();
await signInAs('mei.sun', MEI_PW);
ok('an administrator unlocks it', (await acting()) === 'Mei Sun');

// ------------------------------------------------- two-step sign-in
await page.goto(BASE + '/account');
await settle(2500);
await page.getByRole('button', { name: /Set up two-step sign-in/ }).click();
await settle(1500);
const secret = (await page.locator('[data-testid="mfa-secret"]').innerText()).trim();
ok('setting up two-step shows a QR code and the key', (await page.locator('svg').count()) > 0 && /^[A-Z2-7]{32}$/.test(secret));
await page.locator('input[name="code"]').fill(code(secret));
await page.getByRole('button', { name: /Turn on/ }).click();
await settle(2000);
const enrolStep = Math.floor(Date.now() / 30000);
const stored = await one(`select mfa_enabled, mfa_secret from public.app_users where username = 'mei.sun'`);
ok('a code from the app turns it on', stored.mfa_enabled === true);
ok('...and the secret is stored sealed', !stored.mfa_secret.includes(secret));

await signOut();
await signInAs('mei.sun', MEI_PW);
ok('signing in then asks for a code', /Two-step verification/.test(await text()));
await page.locator('input[name="code"]').fill('000000');
await page.getByRole('button', { name: /Verify/ }).click();
await settle(1200);
ok('...refuses a wrong one', /not right/i.test(await text()));
// A code is good once: wait for the next step after the one used to enrol.
while (Math.floor(Date.now() / 30000) <= enrolStep) await page.waitForTimeout(1000);
await page.locator('input[name="code"]').fill(code(secret));
await page.getByRole('button', { name: /Verify/ }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
await settle(2000);
ok('...and takes the right one', (await acting()) === 'Mei Sun');

// ------------------------------------------------- roles, maker-checker
await signOut();
await signInAs(USER, PASS);
await page.goto(`${BASE}/admin/roles?as=EMP-0445`);
await settle(2500);
await page.getByRole('button', { name: /New role/ }).click();
await page.locator('input[name="role-name"]').fill('Report reader');
await page.locator('input[name="perm-reports.view"]').check();
await page.getByRole('button', { name: /^Create$/ }).click();
await settle(2000);
ok('a new role waits for approval', (await one(`select status from public.roles where tenant_id = $1 and name = 'Report reader'`, [tenant])).status === 'pending');
ok('...which its author cannot give', (await page.locator('[data-testid="roles-waiting"]').innerText()).includes('needs roles.approve'));
await page.goto(`${BASE}/admin/roles?as=EMP-0520`);
await settle(2500);
await page.locator('button[name="approve-role-Report reader"]').click();
await settle(2000);
ok('the Security officer approves it', (await one(`select status, approved_by from public.roles where tenant_id = $1 and name = 'Report reader'`, [tenant])).approved_by === 'EMP-0520');
await page.goto(`${BASE}/admin/roles?as=EMP-0445`);
await settle(2500);
await page.locator('select[name="give-Report reader"]').selectOption('EMP-3120');
await page.locator('[data-role="Report reader"]').getByRole('button', { name: /^Give$/ }).click();
await settle(2000);
ok('...and then it can be given to somebody',
  (await one(`select count(*)::int n from public.employee_roles er join public.roles r on r.id = er.role_id
               where er.tenant_id = $1 and r.name = 'Report reader' and er.employee_id = 'EMP-3120'`, [tenant])).n === 1);

// ------------------------------------------------- the HR master file
await page.goto(`${BASE}/admin/people?as=EMP-0650`);
await settle(2500);
await page.locator('input[name="hr-file"]').setInputFiles({
  name: 'hr-master.csv', mimeType: 'text/csv',
  buffer: Buffer.from('Employee ID,Name,Department,Designation,Line Manager ID,Email\r\nEMP-7001,Ayesha Siddiqua,Finance,Accounts Officer,EMP-0312,ayesha@example.com\r\nEMP-2847,Tom Bexley,Operations,Senior Operations Analyst,EMP-1134,\r\n'),
});
await settle(800);
await page.getByRole('button', { name: /^Preview$/ }).first().click();
await settle(2000);
const pv = await page.locator('[data-testid="import-preview"]').innerText();
ok('the HR file previews what it would do', pv.includes('1 added') && pv.includes('1 updated'), pv.replace(/\s+/g, ' '));
ok('...without doing it', !(await one(`select 1 x from public.employees where tenant_id = $1 and employee_id = 'EMP-7001'`, [tenant])));
await page.getByRole('button', { name: /^Apply$/ }).click();
await settle(2500);
const ayesha = await one(`select name, department, line_manager_id from public.employees where tenant_id = $1 and employee_id = 'EMP-7001'`, [tenant]);
ok('...and applying it adds and updates people', ayesha?.line_manager_id === 'EMP-0312'
  && (await one(`select designation from public.employees where tenant_id = $1 and employee_id = 'EMP-2847'`, [tenant])).designation === 'Senior Operations Analyst');
ok('...and the import is in the sync history', (await page.locator('[data-testid="sync-history"]').innerText()).includes('HR file'));

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL STAGE 3 E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
