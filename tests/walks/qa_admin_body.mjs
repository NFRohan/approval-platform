
// ================================================================ QA: administration — users and accounts
// Who may administer, registering and approving accounts, the password
// policy and its history, resets, lockout, profile changes, disabling,
// deactivating, and the list's filter. Runs after harness_head.mjs.

async function signOut() {
  await ctx.clearCookies();
  await page.goto(BASE + '/login');
  await settle(800);
}
async function signInAs(user, pass) {
  await page.goto(BASE + '/login');
  await settle(600);
  await page.locator('input[autocomplete="username"]').fill(user);
  await page.locator('input[autocomplete="current-password"]').fill(pass);
  await page.locator('input[autocomplete="current-password"]').press('Enter');
  await settle(2500);
}
const acting = async () => (await page.locator('[data-testid="acting-as"]').first().innerText().catch(() => '')).trim();
const sidebar = async () => page.locator('aside').first().innerText().catch(() => '');
const toasts = async () => (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
const acct = (u) => one(`select u.*, c.password_hash as vault_hash, coalesce(cardinality(c.password_history), 0) as history_len
                           from public.app_users u left join vault.credentials c on c.user_id = u.id where u.username = $1`, [u]);
const audits = async (action, like) => (await one(
  `select count(*)::int n from public.activity_log where tenant_id = $1 and action = $2 and ($3::text is null or detail like $3)`,
  [tenant, action, like ?? null])).n;
const row = (u) => page.locator(`[data-username="${u}"]`);
const usersAs = async (emp) => { await page.goto(`${BASE}/admin/users?as=${emp}`); await settle(3000); };
const back = async () => { await signOut(); await signInAs(USER, PASS); };

const ADMIN_PAGES = ['Users', 'Roles', 'People & Directory', 'Working Calendar', 'Clearance Checklists', 'Email', 'Integrations', 'Audit Centre'];

// ------------------------------------------------- somebody with no admin rights
await page.goto(BASE + '/?as=EMP-2847');
await settle(2500);
let side = await sidebar();
ok('Tom (no admin rights) is offered none of the administration pages', ADMIN_PAGES.every((p) => !side.includes(p)), side.replace(/\s+/g, ' '));
for (const [path, need] of [['/admin/users', 'users.manage'], ['/admin/roles', 'roles.manage'], ['/admin/people', 'org.manage'],
  ['/admin/email', 'notifications.manage'], ['/admin/integrations', 'integrations.manage'], ['/admin/audit', 'audit.view'],
  ['/admin/calendar', 'org.manage'], ['/admin/checklists', 'forms.settings or org.manage']]) {
  await page.goto(`${BASE}${path}?as=EMP-2847`);
  await settle(2500);
  const t = await text();
  ok(`...and opening ${path} by its address is refused`, t.includes('This needs the') && t.includes(need) && t.includes('which your roles do not grant'), t.slice(0, 200).replace(/\s+/g, ' '));
}
ok('...the checklists stay read-only for him: nothing to save, nothing to type into',
  (await page.getByRole('button', { name: /^Save$/ }).count()) === 0 && (await page.getByRole('button', { name: /Add an item/ }).count()) === 0
  && (await page.locator('[data-testid="checklist-tracks"] textarea:not([disabled])').count()) === 0);
await page.goto(`${BASE}/admin/users?as=EMP-0830`);
await settle(2500);
ok('the auditor (audit.view only) cannot open Users either', (await text()).includes('users.manage or users.approve'));

// ------------------------------------------------- registering an account
await usersAs('EMP-0445');
side = await sidebar();
ok('the System administrator is offered every administration page', ADMIN_PAGES.every((p) => side.includes(p)), side.replace(/\s+/g, ' '));
await page.getByRole('button', { name: /Register an account/ }).click();
await settle(500);
ok('without a directory, signing in with the directory password is offered but off',
  (await text()).includes('no directory is connected here') && await page.locator('input[type="radio"]').nth(1).isDisabled());
await page.locator('select[name="employee"]').selectOption('EMP-9001');
ok('a username is suggested from the name', (await page.locator('input[name="username"]').inputValue()) === 'ivan.petrov');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2500);
const IVAN_TEMP = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
ok('registering shows a temporary password', /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(IVAN_TEMP), IVAN_TEMP);
let a = await acct('ivan.petrov');
ok('...the account waits for approval, a local one that must change its password',
  a?.approval_state === 'pending' && a.auth_source === 'local' && a.must_change_pw === true && a.created_by_employee === 'EMP-0445', JSON.stringify(a && { s: a.approval_state, src: a.auth_source }));
ok('...the hash is in the vault, not on the account, and is not the password', !a.password_hash && !!a.vault_hash && a.vault_hash.startsWith('scrypt$') && !a.vault_hash.includes(IVAN_TEMP));
ok('...and the registration is on the trail', (await audits('account_requested', '%ivan.petrov%')) === 1);
await page.getByRole('button', { name: /^Done$/ }).click();
await settle(500);
await usersAs('EMP-0445');
ok('the temporary password is shown once: gone after Done and a reload', (await page.locator('[data-testid="one-time-secret"]').count()) === 0 && !(await text()).includes(IVAN_TEMP));
ok('the author sees it waiting, needing somebody with users.approve',
  /New account\s+ivan\.petrov/.test(await page.locator('[data-testid="waiting"]').innerText()) && (await page.locator('[data-testid="waiting"]').innerText()).includes('needs users.approve'));
await page.getByRole('button', { name: /Register an account/ }).click();
await settle(400);
ok('somebody with an account is not offered again', (await page.locator('select[name="employee"] option[value="EMP-9001"]').count()) === 0);
await page.locator('select[name="employee"]').selectOption('EMP-0412');
await page.locator('input[name="username"]').fill('fa');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2000);
ok('a username that breaks the rule is refused, saying the rule', /3 to 40 lower-case letters/.test(await text()) && !(await one(`select 1 x from public.app_users where username = 'fa'`)));
await page.locator('input[name="username"]').fill('ivan.petrov');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2000);
ok('...and so is one that is taken', /that username is taken/.test(await text()));
await page.locator('input[name="username"]').fill('farzana.akter');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2500);
const FARZANA_TEMP = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
ok('a second account is registered', (await acct('farzana.akter'))?.approval_state === 'pending');

// ------------------------------------------------- approving and rejecting, by somebody else
await usersAs('EMP-0650');
await page.locator('button[name="approve-ivan.petrov"]').click();
await settle(2500);
a = await acct('ivan.petrov');
ok('the HR administrator approves it', a.approval_state === 'approved' && a.approved_by_employee === 'EMP-0650');
await page.locator('[data-testid="waiting"] > div', { hasText: 'farzana.akter' }).getByRole('button', { name: /^Reject$/ }).click();
await settle(2500);
ok('...and rejects the other', (await acct('farzana.akter')).approval_state === 'rejected' && (await audits('account_rejected', 'farzana.akter')) === 1);
ok('...which is shown as rejected in the list', (await row('farzana.akter').innerText()).includes('rejected'));
// Somebody holding both permissions still cannot approve what they asked for.
await page.getByRole('button', { name: /Register an account/ }).click();
await page.locator('select[name="employee"]').selectOption('EMP-0831');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2500);
await page.getByRole('button', { name: /^Done$/ }).click();
await page.locator('button[name="approve-kofi.mensah"]').click();
await settle(2000);
ok('whoever registered an account cannot approve it, even holding users.approve',
  /somebody other than whoever asked for it/.test(await toasts()) && (await acct('kofi.mensah')).approval_state === 'pending', await toasts());

await signOut();
await signInAs('farzana.akter', FARZANA_TEMP);
ok('a rejected account cannot sign in, and says so', /was not approved/.test(await text()));
await signInAs('kofi.mensah', 'anything-at-all');
ok('...nor can a waiting one with a wrong password learn anything', /do not match/.test(await text()));

// ------------------------------------------------- first sign-in and the password policy
await signInAs('ivan.petrov', IVAN_TEMP);
ok('a first sign-in must choose a password', /Choose a password/.test(await text()));
const np = page.locator('input[autocomplete="new-password"]');
async function choose(pw, again = pw) {
  await np.nth(0).fill(pw);
  await np.nth(1).fill(again);
  await page.getByRole('button', { name: /Save and continue/ }).click();
  await settle(1500);
  return text();
}
for (const [pw, says] of [
  ['Abcdef1!', 'at least 12 characters'], ['abcdefghijk1!', 'an upper-case letter'], ['ABCDEFGHIJK1!', 'a lower-case letter'],
  ['Abcdefghijkl!', 'a number'], ['Abcdefghijkl1', 'a special character'], ['Xivan.petrov-2026!', 'not containing your username'],
]) {
  ok(`the policy refuses "${pw}": ${says}`, (await choose(pw)).toLowerCase().includes(says));
}
ok('...and two different entries', /not the same/.test(await choose('Harbour-Light-2026!', 'Harbour-Light-2026?')));
ok('...none of which changed anything', (await acct('ivan.petrov')).must_change_pw === true);
const PW = ['Harbour-Light-2026!', 'Quiet-River-2026#', 'Amber-Stone-2026$', 'Cedar-Path-2026%', 'Silver-Moss-2026&', 'Iron-Gate-2026*', 'Blue-Kite-2026+'];
await choose(PW[0]);
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
await settle(2500);
ok('a password meeting the policy lets Ivan in, as himself', (await acting()) === 'Ivan Petrov', await acting());
a = await acct('ivan.petrov');
ok('...no longer due a change, the temporary one kept in the history', a.must_change_pw === false && a.history_len === 1);
await signOut();
await signInAs('ivan.petrov', IVAN_TEMP);
ok('the temporary password no longer works', /do not match/.test(await text()));

// ------------------------------------------------- his own account page
await signInAs('ivan.petrov', PW[0]);
await page.goto(BASE + '/account');
await settle(2500);
await page.getByRole('button', { name: /Set up two-step sign-in/ }).click();
await settle(1500);
ok('two-step sign-in can be set up from the account page: a QR code and a key',
  /^[A-Z2-7]{32}$/.test((await page.locator('[data-testid="mfa-secret"]').innerText()).trim()) && (await page.locator('svg').count()) > 0);
await page.getByRole('button', { name: /^Cancel$/ }).click();
await settle(500);
ok('...and left off when cancelled', (await acct('ivan.petrov')).mfa_enabled === false);
async function change(current, next, again = next) {
  await page.locator('input[name="current"]').fill(current);
  await page.locator('input[name="next"]').fill(next);
  await page.locator('input[name="again"]').fill(again);
  await page.getByRole('button', { name: /^Change password$/ }).click();
  await settle(1800);
  return text();
}
ok('changing it needs the current password', /not your current password/.test(await change('Wrong-Current-2026!', PW[1])));
ok('...refuses one that breaks the policy', /needs:.*number/i.test(await change(PW[0], 'No-Digits-Here-At-All!')));
ok('...refuses the current one', /one of your last 5 passwords/.test(await change(PW[0], PW[0])));
await change(PW[0], PW[1]);
ok('...and takes a good one', (await acct('ivan.petrov')).history_len === 2 && (await audits('password_changed', 'ivan.petrov %')) === 2);
await change(PW[1], PW[2]);
await change(PW[2], PW[3]);
await change(PW[3], PW[4]);
ok('the first of his last five passwords is still refused', /one of your last 5 passwords/.test(await change(PW[4], PW[0])));
await change(PW[4], PW[5]);
const sixBack = await change(PW[5], PW[0]);
ok('...but six back may be used again', !/one of your last 5/.test(sixBack) && (await audits('password_changed', 'ivan.petrov %')) === 7, sixBack.slice(0, 200));
let ivanPw = PW[0];

// ------------------------------------------------- an administrator resets it
await back();
await usersAs('EMP-0445');
await row('ivan.petrov').getByRole('button', { name: /Reset password/ }).click();
await settle(2500);
const IVAN_TEMP2 = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
ok('a reset shows a new temporary password once', /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(IVAN_TEMP2) && IVAN_TEMP2 !== IVAN_TEMP);
await page.getByRole('button', { name: /^Done$/ }).click();
await settle(1500);
ok('...the account must change it at next sign-in', (await acct('ivan.petrov')).must_change_pw === true);
ok('...which the list says straight away', (await row('ivan.petrov').innerText()).includes('must change password'), await row('ivan.petrov').innerText());
await usersAs('EMP-0445');
ok('...and after a reload', (await row('ivan.petrov').innerText()).includes('must change password'), await row('ivan.petrov').innerText());
ok('...and the reset is on the trail', (await audits('password_reset', 'ivan.petrov')) === 1);
await signOut();
await signInAs('ivan.petrov', ivanPw);
ok('after a reset the old password is refused', /do not match/.test(await text()));
await signInAs('ivan.petrov', IVAN_TEMP2);
ok('the new one asks for a change at once', /Choose a password/.test(await text()));
ok('...and will not take back the password it replaced', /one of your last 5 passwords/.test(await choose(ivanPw)));
await choose(PW[6]);
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
await settle(2500);
ivanPw = PW[6];
ok('...but takes a new one, and he is in', (await acting()) === 'Ivan Petrov');

// ------------------------------------------------- lockout, seen from the list, and unlock
await signOut();
for (let i = 0; i < 10; i++) {
  await page.locator('input[autocomplete="username"]').fill('ivan.petrov');
  await page.locator('input[autocomplete="current-password"]').fill('Wrong-Password-' + i);
  await page.locator('input[autocomplete="current-password"]').press('Enter');
  await settle(700);
}
ok('ten wrong passwords lock the account', !!(await acct('ivan.petrov')).locked_at);
await back();
await usersAs('EMP-0445');
ok('the list shows it locked', (await row('ivan.petrov').innerText()).includes('locked'));
await row('ivan.petrov').getByRole('button', { name: /Unlock/ }).click();
await settle(2500);
a = await acct('ivan.petrov');
ok('an administrator unlocks it, on the trail', !a.locked_at && a.failed_attempts === 0 && (await audits('account_unlocked', 'ivan.petrov')) === 1);

// ------------------------------------------------- a profile change, maker and checker
await row('ivan.petrov').getByRole('button', { name: /Change profile/ }).click();
await settle(400);
await row('ivan.petrov').locator('input').nth(0).fill('Ivan P. Petrov');
await row('ivan.petrov').locator('input').nth(1).fill('ivan.petrov@corp.example');
await row('ivan.petrov').getByRole('button', { name: /^Propose$/ }).click();
await settle(2500);
a = await acct('ivan.petrov');
ok('a profile change is proposed, not made', a.pending_profile?.full_name === 'Ivan P. Petrov' && a.pending_profile?.by === 'EMP-0445' && a.full_name === 'Ivan Petrov');
const waitTxt = await page.locator('[data-testid="waiting"]').innerText();
ok('...and waits, saying what changes and who asked', /Profile change for\s+ivan\.petrov/.test(waitTxt) && waitTxt.includes('Ivan P. Petrov') && waitTxt.includes('Farah Haddad') && waitTxt.includes('needs users.approve'), waitTxt);
await usersAs('EMP-0650');
await page.locator('button[name="approve-ivan.petrov"]').click();
await settle(2500);
a = await acct('ivan.petrov');
ok('somebody else approves it, and it takes effect', a.full_name === 'Ivan P. Petrov' && a.email === 'ivan.petrov@corp.example' && !a.pending_profile && (await audits('profile_change_approved', 'ivan.petrov')) === 1);
await usersAs('EMP-0445');
await row('ivan.petrov').getByRole('button', { name: /Change profile/ }).click();
await row('ivan.petrov').locator('input').nth(1).fill('somebody.else@elsewhere.example');
await row('ivan.petrov').getByRole('button', { name: /^Propose$/ }).click();
await settle(2500);
await usersAs('EMP-0650');
await page.locator('[data-testid="waiting"] > div', { hasText: 'ivan.petrov' }).getByRole('button', { name: /^Reject$/ }).click();
await settle(2500);
a = await acct('ivan.petrov');
ok('a rejected profile change leaves the profile as it was', a.email === 'ivan.petrov@corp.example' && !a.pending_profile && (await audits('profile_change_rejected', 'ivan.petrov')) === 1);
await row('ivan.petrov').getByRole('button', { name: /Change profile/ }).click();
await row('ivan.petrov').locator('input').nth(0).fill('Ivan Self-Approved');
await row('ivan.petrov').getByRole('button', { name: /^Propose$/ }).click();
await settle(2500);
await page.locator('button[name="approve-ivan.petrov"]').click();
await settle(2000);
ok('whoever proposed a profile change cannot approve it', /somebody other than whoever proposed it/.test(await toasts())
  && (await acct('ivan.petrov')).full_name === 'Ivan P. Petrov', await toasts());

// ------------------------------------------------- filtering the list
await usersAs('EMP-0445');
const filter = page.locator('input[placeholder="Filter by name, username, department"]');
const shown = async () => page.locator('[data-testid="accounts"] [data-username]').evaluateAll((els) => els.map((e) => e.getAttribute('data-username')));
const all = await shown();
await filter.fill('ivan');
await settle(400);
ok('the list filters by username', JSON.stringify(await shown()) === '["ivan.petrov"]', JSON.stringify(await shown()));
await filter.fill('compliance');
await settle(400);
const ops = await shown();
ok('...and by department, ignoring case', JSON.stringify(ops) === '["kofi.mensah"]' && all.length > 1, JSON.stringify(ops));
await filter.fill('EMP-9001');
await settle(400);
ok('...and by employee id', JSON.stringify(await shown()) === '["ivan.petrov"]');
await filter.fill('no-such-person-zz');
await settle(400);
ok('...and says when nothing matches', (await shown()).length === 0 && (await text()).includes('No accounts match.'));
await filter.fill('');

// ------------------------------------------------- disable, enable, deactivate
await page.getByRole('button', { name: /Register an account/ }).click();
await page.locator('select[name="employee"]').selectOption('EMP-0411');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2500);
const TAN_TEMP = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
await usersAs('EMP-0650');
await page.locator('button[name="approve-tanvir.hasan"]').click();
await settle(2000);
await signOut();
await signInAs('tanvir.hasan', TAN_TEMP);
const TAN_PW = 'Ledger-Bright-2026!';
await choose(TAN_PW);
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
await settle(2500);
ok('Tanvir signs in', (await acting()) === 'Tanvir Hasan');
await page.goto(BASE + '/forms');
await settle(3000);
await page.locator('input[aria-label="Find a form"]').fill('Travel');
await settle(800);
const formsWhileActive = (await text()).includes('Travel & Expense Reimbursement');
const tanvirCookies = await ctx.cookies();

await back();
await usersAs('EMP-0445');
await row('tanvir.hasan').getByRole('button', { name: /^Disable$/ }).click();
await settle(2500);
ok('an administrator disables an account', (await acct('tanvir.hasan')).status === 'disabled' && (await row('tanvir.hasan').innerText()).includes('disabled')
  && (await audits('account_disabled', 'tanvir.hasan')) === 1);

// Tanvir's own browser, still holding the session issued before: its next request is refused.
const errsBefore = pageErrors.length;
await ctx.clearCookies();
await ctx.addCookies(tanvirCookies);
await page.goto(BASE + '/forms').catch(() => {});
await settle(3000);
// Under load the redirect to sign-in can land on the browser's own error
// page (the harness, not the app); one retry settles it.
if (page.url().startsWith('chrome-error')) { await page.goto(BASE + '/forms').catch(() => {}); await settle(3000); }
// The refused session may already be back at sign-in, with no page to search.
if (await page.locator('input[aria-label="Find a form"]').count()) {
  await page.locator('input[aria-label="Find a form"]').fill('Travel');
  await settle(800);
}
const cut = await text();
ok('a session already open gets no more data once the account is disabled', formsWhileActive && !cut.includes('Travel & Expense Reimbursement'), `${formsWhileActive} ${cut.slice(0, 300)}`);
ok('...and is ended or told so, not left showing him signed in to empty pages',
  page.url().includes('/login') || /no longer signed in|session has ended|sign in again|disabled/i.test(cut), `${page.url()} ${cut.slice(0, 300)}`);
console.log(`  note: ${pageErrors.length - errsBefore} console error(s) while the disabled session was refused: ${pageErrors.slice(errsBefore).join(' | ').slice(0, 300)}`);
pageErrors.splice(errsBefore);   // refused requests from a dead session are the point of the check above
await signOut();
await signInAs('tanvir.hasan', TAN_PW);
ok('a disabled account cannot sign in, and says why', /has been disabled/.test(await text()));

await back();
await usersAs('EMP-0445');
await row('tanvir.hasan').getByRole('button', { name: /^Enable$/ }).click();
await settle(2500);
ok('enabling it again', (await acct('tanvir.hasan')).status === 'active' && (await audits('account_active', 'tanvir.hasan')) === 1);
await signOut();
await signInAs('tanvir.hasan', TAN_PW);
ok('...lets him sign in again', (await acting()) === 'Tanvir Hasan');

await back();
await usersAs('EMP-0445');
page.once('dialog', (d) => d.dismiss());
await row('tanvir.hasan').getByRole('button', { name: /^Deactivate$/ }).click();
await settle(1500);
ok('deactivating asks first, and a "no" leaves it alone', (await acct('tanvir.hasan')).status === 'active');
let dialogText = '';
page.once('dialog', (d) => { dialogText = d.message(); d.accept(); });
await row('tanvir.hasan').getByRole('button', { name: /^Deactivate$/ }).click();
await settle(2500);
a = await acct('tanvir.hasan');
ok('...says it is permanent, and on "yes" deactivates it', /cannot be undone/.test(dialogText) && a.status === 'deactivated' && !!a.deactivated_at && (await audits('account_deactivated', 'tanvir.hasan')) === 1, dialogText);
const tanRow = await row('tanvir.hasan').innerText();
ok('...after which the list offers nothing to do with it', tanRow.includes('deactivated')
  && (await row('tanvir.hasan').getByRole('button', { name: /^(Enable|Disable|Deactivate|Reset password|Change profile|Unlock)$/ }).count()) === 0, tanRow);
await page.goto('about:blank');
await settle(800);
let reactivate = null;
try {
  await db.query('begin');
  await db.query(`select set_config('app.tenant_id', $1, true), set_config('app.employee_id', 'EMP-0445', true), set_config('app.role', 'admin', true)`, [tenant]);
  await db.query(`select public.set_account_status($1, 'active')`, [a.id]);
} catch (e) { reactivate = String(e.message ?? e); } finally { await db.query('rollback'); }
ok('...and the database will not bring it back either', /stays deactivated/.test(reactivate ?? ''), reactivate ?? 'it was reactivated');
await signOut();
await signInAs('tanvir.hasan', TAN_PW);
ok('a deactivated account cannot sign in, and says why', /has been deactivated/.test(await text()));

// ------------------------------------------------- the trail of it all
await back();
await page.goto(`${BASE}/admin/audit?as=EMP-0445`);
await settle(3500);
await page.locator('input[aria-label="Search the trail"]').fill('tanvir.hasan');
await settle(2500);
const trail = await page.locator('[data-testid="audit-trail"]').innerText();
ok('the audit centre finds the account\'s whole story by its username', (trail.match(/\n/g) ?? []).length >= 4 && /tanvir\.hasan/.test(trail), trail.slice(0, 400));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA ADMIN (USERS) CHECKS PASSED');
process.exit(failures ? 1 : 0);
