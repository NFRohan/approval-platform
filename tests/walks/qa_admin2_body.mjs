
// ================================================================ QA: administration — roles, people, divisions, checklists
// Roles with maker-checker, given to a person and to a department; the HR
// master file; the directory when none is connected; divisions created,
// renamed and merged with everything that names them; clearance
// checklists. Runs after harness_head.mjs.

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
const sidebar = async () => page.locator('aside').first().innerText().catch(() => '');
const toasts = async () => (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
const audits = async (action, like) => (await one(
  `select count(*)::int n from public.activity_log where tenant_id = $1 and action = $2 and ($3::text is null or detail like $3)`,
  [tenant, action, like ?? null])).n;
const go = async (path, emp, wait = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${emp}`); await settle(wait); };
const role = (name) => one(`select * from public.roles where tenant_id = $1 and name = $2`, [tenant, name]);
const holds = async (emp, name) => (await one(`select count(*)::int n from public.employees e, public.roles r
   where e.tenant_id = $1 and e.employee_id = $2 and r.tenant_id = $1 and r.name = $3 and r.id in (select app.held_roles(e.employee_id, e.tenant_id))`, [tenant, emp, name])).n === 1;
const roleCard = (name) => page.locator('section', { has: page.locator(`[data-role="${name}"]`) });
const dept = (emp) => one(`select department, active, left_on, line_manager_id, designation from public.employees where tenant_id = $1 and employee_id = $2`, [tenant, emp]);
// What a database function says when somebody calls it directly, as that person.
async function asPerson(emp, sql, params = []) {
  await page.goto('about:blank');
  await settle(800);
  try {
    await db.query('begin');
    await db.query(`select set_config('app.tenant_id', $1, true), set_config('app.employee_id', $2, true), set_config('app.role', 'viewer', true)`, [tenant, emp]);
    await db.query(sql, params);
    return null;
  } catch (e) { return String(e.message ?? e); } finally { await db.query('rollback'); }
}

// ------------------------------------------------- a role, maker and checker
await go('/admin/roles', 'EMP-0445');
await page.getByRole('button', { name: /New role/ }).click();
await page.locator('input[name="role-name"]').fill('QA records clerk');
await page.locator('input[name="perm-audit.view"]').check();
await page.getByRole('button', { name: /^Create$/ }).click();
await settle(2500);
let r = await role('QA records clerk');
ok('a new role is created waiting for approval', r?.status === 'pending' && r.created_by === 'EMP-0445' && JSON.stringify(r.permissions) === '["audit.view"]');
ok('...its author is told it needs somebody with roles.approve', /New role\s+QA records clerk/.test(await page.locator('[data-testid="roles-waiting"]').innerText())
  && (await page.locator('[data-testid="roles-waiting"]').innerText()).includes('needs roles.approve')
  && (await page.locator('button[name="approve-role-QA records clerk"]').count()) === 0);
ok('...and it cannot be given to anybody yet', (await page.locator('select[name="give-QA records clerk"]').count()) === 0);
await page.getByRole('button', { name: /New role/ }).click();
await page.locator('input[name="role-name"]').fill('QA unwanted role');
await page.locator('input[name="perm-users.manage"]').check();
await page.getByRole('button', { name: /^Create$/ }).click();
await settle(2500);

await go('/admin/roles', 'EMP-0700');
await page.locator('button[name="approve-role-QA records clerk"]').click();
await settle(2500);
r = await role('QA records clerk');
ok('the Security officer approves it', r.status === 'active' && r.approved_by === 'EMP-0700' && (await audits('role_approved', 'QA records clerk')) === 1);
await page.locator('[data-testid="roles-waiting"] > div', { hasText: 'QA unwanted role' }).getByRole('button', { name: /^Reject$/ }).click();
await settle(2500);
ok('...and rejects the other, which drops out of the list', (await role('QA unwanted role')).status === 'rejected'
  && !(await page.locator('[data-testid="roles"]').innerText()).includes('QA unwanted role'));

// Holding both permissions does not let anybody approve their own role.
await go('/admin/roles', 'EMP-0445');
await page.getByRole('button', { name: /New role/ }).click();
await page.locator('input[name="role-name"]').fill('QA role steward');
await page.locator('input[name="perm-roles.manage"]').check();
await page.locator('input[name="perm-roles.approve"]').check();
await page.getByRole('button', { name: /^Create$/ }).click();
await settle(2500);
await go('/admin/roles', 'EMP-0700');
await page.locator('button[name="approve-role-QA role steward"]').click();
await settle(2500);
await go('/admin/roles', 'EMP-0445');
await page.locator('select[name="give-QA role steward"]').selectOption('EMP-0830');
await page.locator('[data-role="QA role steward"]').getByRole('button', { name: /^Give$/ }).click();
await settle(2500);
await go('/admin/roles', 'EMP-0830');
await page.getByRole('button', { name: /New role/ }).click();
await page.locator('input[name="role-name"]').fill('QA self-made');
await page.locator('input[name="perm-reports.view"]').check();
await page.getByRole('button', { name: /^Create$/ }).click();
await settle(2500);
await page.locator('button[name="approve-role-QA self-made"]').click();
await settle(2000);
ok('somebody holding roles.manage and roles.approve still cannot approve a role they created',
  /somebody other than whoever created it/.test(await toasts()) && (await role('QA self-made')).status === 'pending', await toasts());

// ------------------------------------------------- given to a person, and taken away
await go('/admin/roles', 'EMP-0445');
const giveOpts = await page.locator('select[name="give-QA records clerk"] option').allInnerTexts();
ok('nobody is offered a role to give themselves', !giveOpts.some((o) => o.includes('EMP-0445')) && giveOpts.some((o) => o.includes('EMP-0416')));
await page.locator('select[name="give-QA records clerk"]').selectOption('EMP-0416');
await page.locator('[data-role="QA records clerk"]').getByRole('button', { name: /^Give$/ }).click();
await settle(2500);
ok('a role is given to a person', (await page.locator('[data-role="QA records clerk"]').innerText()).includes('Mitu Rahman') && await holds('EMP-0416', 'QA records clerk')
  && (await audits('role_assigned', 'QA records clerk given to EMP-0416')) === 1);
await go('/', 'EMP-0416', 2500);
let side = await sidebar();
ok('...who now finds the Audit Centre in the menu', side.includes('Audit Centre'), side.replace(/\s+/g, ' '));
await go('/admin/audit', 'EMP-0416');
ok('...and can open it', !(await text()).includes('This needs the') && (await page.locator('[data-testid="audit-trail"]').count()) === 1);
await go('/admin/roles', 'EMP-0445');
await page.locator('[data-role="QA records clerk"]').getByTitle('Take this role away').click();
await settle(2500);
ok('the role is taken away again', !(await holds('EMP-0416', 'QA records clerk')) && (await audits('role_removed', 'QA records clerk taken from EMP-0416')) === 1);
await go('/admin/audit', 'EMP-0416');
ok('...and with it the Audit Centre', !(await sidebar()).includes('Audit Centre') && (await text()).includes('This needs the'));

// A change to an approved role waits, and the role works as it was meanwhile.
await go('/admin/roles', 'EMP-0445');
await roleCard('QA records clerk').getByRole('button', { name: /^Change$/ }).click();
await settle(400);
await page.locator('input[name="perm-records.manage"]').check();
await page.getByRole('button', { name: /Propose change/ }).click();
await settle(2500);
r = await role('QA records clerk');
ok('a change to a role is proposed, not made', JSON.stringify(r.permissions) === '["audit.view"]' && (r.pending_permissions ?? []).includes('records.manage')
  && /Change to\s+QA records clerk/.test(await page.locator('[data-testid="roles-waiting"]').innerText()));
await go('/admin/roles', 'EMP-0700');
await page.locator('button[name="approve-role-QA records clerk"]').click();
await settle(2500);
r = await role('QA records clerk');
ok('...and takes effect once somebody else approves it', r.permissions.includes('records.manage') && !r.pending_permissions);

// ------------------------------------------------- given to a department
await go('/admin/roles', 'EMP-0445');
const groupSel = page.locator('select[name="give-group-QA records clerk"]');
const groupOpts = await groupSel.locator('option').allInnerTexts();
ok('nobody is offered their own department', !groupOpts.includes('Admin') && groupOpts.includes('Commercial'), groupOpts.join(','));
await groupSel.selectOption('Commercial');
await page.locator('[data-role-groups="QA records clerk"]').getByRole('button', { name: /^Give$/ }).click();
await settle(2500);
ok('a role is given to everyone in a department', (await page.locator('[data-role-groups="QA records clerk"]').innerText()).includes('Commercial')
  && !!(await one(`select 1 x from public.role_groups g join public.roles r on r.id = g.role_id where g.tenant_id = $1 and r.name = 'QA records clerk' and g.department = 'Commercial'`, [tenant])));
ok('...so its people hold it, and nobody outside it does', await holds('EMP-0415', 'QA records clerk') && await holds('EMP-0416', 'QA records clerk') && !(await holds('EMP-2847', 'QA records clerk')));
await go('/', 'EMP-0415', 2500);
ok('...and Shahriar, in Commercial, is offered the Audit Centre', (await sidebar()).includes('Audit Centre'));
const ownDept = await asPerson('EMP-0445', `select public.assign_role_group('Admin', $1, true)`, [r.id]);
ok('...while the database refuses an administrator giving one to their own department', /own department/.test(ownDept ?? ''), ownDept ?? 'it was given');

// ------------------------------------------------- the directory, when none is connected
await go('/admin/people', 'EMP-0650');
let t = await text();
ok('People & Directory says no directory is connected, and offers no sync', t.includes('not connected') && t.includes('No directory is connected to this organisation')
  && (await page.getByRole('button', { name: /Sync now/ }).count()) === 0);
ok('...and the sync history starts empty', t.includes('Nothing has been imported yet.'));
const cron = await server.fetch(new Request(BASE + '/cron/directory-sync'));
ok('...the nightly directory sync is not for anybody to call', cron.status === 401 || cron.status === 403, String(cron.status));

// ------------------------------------------------- the HR master file
// Loose headers and a semicolon; a report listed before their new manager;
// a row with no name; a manager nobody knows; a change to somebody known.
const hr1 = [
  'Staff No;Full Name;Dept;Job Title;Reports To;Work Email',
  'EMP-7102;Nila Das;Retail Banking;Retail Analyst;EMP-7103;nila.das@example.com',
  'EMP-7103;Arif Khan;Retail Banking;Head of Retail;EMP-0700;arif.khan@example.com',
  'EMP-0412;Farzana Akter;Business Finance;Senior Business Finance Analyst;EMP-0410;farzana.akter@example.com',
  'EMP-7104;;Retail Banking;Teller;EMP-7103;',
  'EMP-7105;Rumana Ali;Retail Banking;Teller;EMP-9999;rumana@example.com',
].join('\r\n');
await page.getByText('Choose a CSV').click({ trial: true });
await page.locator('input[name="hr-file"]').setInputFiles({ name: 'hr-master.csv', mimeType: 'text/csv', buffer: Buffer.from(hr1) });
await settle(1000);
t = await text();
ok('choosing a file names it and says which columns it found', t.includes('hr-master.csv') && /5\s+people in hr-master\.csv/.test(t) && t.includes('Staff No → employee_id') && t.includes('Reports To → line_manager_id'), t.slice(t.indexOf('HR master'), t.indexOf('HR master') + 400).replace(/\s+/g, ' '));
ok('...and Apply waits for a preview', await page.getByRole('button', { name: /^Apply$/ }).isDisabled());
await page.getByRole('button', { name: /^Preview$/ }).first().click();
await settle(2500);
let pv = await page.locator('[data-testid="import-preview"]').innerText();
ok('the preview says what it would do', /3 added/.test(pv) && /1 updated/.test(pv) && /2 line managers set/.test(pv) && /2 skipped/.test(pv) && /1 new division/.test(pv), pv.replace(/\s+/g, ' '));
ok('...naming what it skips and why', /EMP-7104/.test(pv) && /EMP-7105 \(manager EMP-9999 unknown\)/.test(pv), pv.replace(/\s+/g, ' '));
ok('...without doing any of it', !(await dept('EMP-7102')) && (await dept('EMP-0412')).designation === 'Business Finance Analyst');
await page.getByRole('button', { name: /^Apply$/ }).click();
await settle(3000);
const nila = await dept('EMP-7102');
ok('applying adds the new people', nila?.department === 'Retail Banking' && (await dept('EMP-7103'))?.line_manager_id === 'EMP-0700' && !!(await dept('EMP-7105')));
ok('...sets a manager listed after the person reporting to them', nila?.line_manager_id === 'EMP-7103');
ok('...updates who changed', (await dept('EMP-0412')).designation === 'Senior Business Finance Analyst');
ok('...adds a division the file names for the first time', !!(await one(`select 1 x from public.departments where tenant_id = $1 and name = 'Retail Banking'`, [tenant])));
ok('...and leaves out a row with no name, and a manager nobody knows', !(await dept('EMP-7104')) && (await dept('EMP-7105')).line_manager_id === null);
let hist = await page.locator('[data-testid="sync-history"]').innerText();
ok('the import is in the sync history', hist.includes('HR file') && /3 added, 1 updated, 0 left, 2 skipped/.test(hist), hist.replace(/\s+/g, ' '));

// A leaver with an account. Ravi gets one, approved, before the next file.
await go('/admin/users', 'EMP-0445');
await page.getByRole('button', { name: /Register an account/ }).click();
await page.locator('select[name="employee"]').selectOption('EMP-0832');
await page.getByRole('button', { name: /^Register$/ }).click();
await settle(2500);
const RAVI_TEMP = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
await go('/admin/users', 'EMP-0650');
await page.locator('button[name="approve-ravi.shah"]').click();
await settle(2500);

// Everybody, except Ravi, with only an id and a name: marked leavers.
await page.goto('about:blank');
await settle(800);
const everyone = await rows(`select employee_id, name from public.employees where tenant_id = $1 and active and employee_id <> 'EMP-0832' order by employee_id`, [tenant]);
const hr2 = ['Employee ID,Name', ...everyone.map((e) => `${e.employee_id},"${e.name}"`)].join('\n');
await go('/admin/people', 'EMP-0650');
await page.locator('input[name="hr-file"]').setInputFiles({ name: 'everybody.csv', mimeType: 'text/csv', buffer: Buffer.from(hr2) });
await settle(1000);
await page.getByRole('button', { name: /^Preview$/ }).first().click();
await settle(2500);
pv = await page.locator('[data-testid="import-preview"]').innerText();
ok('without being asked, a file missing somebody marks nobody as left', /0 marked as left/.test(pv) && /0 added/.test(pv) && /0 updated/.test(pv), pv.replace(/\s+/g, ' '));
await page.locator('input[name="mark-left"]').check();
await settle(300);
ok('...ticking "this is everybody" asks for a fresh preview', await page.getByRole('button', { name: /^Apply$/ }).isDisabled());
await page.getByRole('button', { name: /^Preview$/ }).first().click();
await settle(2500);
pv = await page.locator('[data-testid="import-preview"]').innerText();
ok('...which marks the one person missing as left', /1 marked as left/.test(pv), pv.replace(/\s+/g, ' '));
await page.getByRole('button', { name: /^Apply$/ }).click();
await settle(3000);
const ravi = await dept('EMP-0832');
ok('applying it marks Ravi as having left, today', ravi.active === false && !!ravi.left_on);
ok('...and leaves alone the columns the file does not carry', (await dept('EMP-7102')).department === 'Retail Banking' && (await dept('EMP-0412')).designation === 'Senior Business Finance Analyst');
hist = await page.locator('[data-testid="sync-history"]').innerText();
ok('the sync history lists both imports, newest first', (hist.match(/HR file/g) ?? []).length === 2 && /0 added, 0 updated, 1 left/.test(hist.split('\n').slice(0, 4).join(' ')), hist.replace(/\s+/g, ' '));
await signOut();
await signInAs('ravi.shah', RAVI_TEMP);
t = await text();
ok('a leaver\'s account can no longer be used to sign in', !/Choose a password/.test(t) && page.url().includes('/login'), t.slice(0, 200).replace(/\s+/g, ' '));
await signOut();
await signInAs(USER, PASS);

// ------------------------------------------------- divisions
// Something kept for Commercial, besides its people and its forms.
await page.goto('about:blank');
await settle(800);
await db.query(`insert into public.trackers (tenant_id, name, owner_id, shared_with, department, filters)
                values ($1, 'QA partner follow-up', 'EMP-0415', 'department', 'Commercial', '{"departments": ["Commercial", "Finance"]}')`, [tenant]);
const commercialPeople = (await one(`select count(*)::int n from public.employees where tenant_id = $1 and department = 'Commercial'`, [tenant])).n;

await go('/', 'EMP-0416', 2500);
ok('before any change, Mitu in Commercial is offered Campaigns', (await sidebar()).includes('Campaigns'));

await go('/admin/people', 'EMP-0650');
await page.getByRole('button', { name: /New division/ }).click();
await settle(400);
await page.getByLabel('Name', { exact: true }).fill('Treasury');
await page.locator('select').filter({ has: page.locator('option', { hasText: 'Nobody' }) }).first().selectOption('EMP-0600');
await page.getByRole('button', { name: /^Add$/ }).click();
await settle(2500);
ok('a division is created, with its head', (await one(`select head_employee_id h from public.departments where tenant_id = $1 and name = 'Treasury'`, [tenant]))?.h === 'EMP-0600'
  && (await page.locator('[data-division="Treasury"]').innerText()).includes('Dana Whitfield'));

await page.locator('[data-division="Commercial"]').getByRole('button', { name: /Change/ }).click();
await settle(400);
await page.locator('input[name="division-name"]').fill('Finance');
await page.locator('[data-division="Commercial"]').getByRole('button', { name: /^Save$/ }).click();
await settle(2000);
ok('renaming a division to one that exists is refused, pointing at a merge', /merge them instead/.test(await toasts())
  && !!(await one(`select 1 x from public.departments where tenant_id = $1 and name = 'Commercial'`, [tenant])), await toasts());
await page.locator('input[name="division-name"]').fill('Commercial & Partnerships');
await page.locator('[data-division="Commercial"]').getByRole('button', { name: /^Save$/ }).click();
await settle(3000);
ok('a division is renamed', !!(await one(`select 1 x from public.departments where tenant_id = $1 and name = 'Commercial & Partnerships'`, [tenant]))
  && !(await one(`select 1 x from public.departments where tenant_id = $1 and name = 'Commercial'`, [tenant])) && (await audits('division_renamed', 'Commercial → Commercial & Partnerships')) === 1);
ok('...its people follow', (await one(`select count(*)::int n from public.employees where tenant_id = $1 and department = 'Commercial & Partnerships'`, [tenant])).n === commercialPeople && commercialPeople > 0);
const aud = (await one(`select audience_departments a from public.form_templates where tenant_id = $1 and name = 'MNO Campaign Request'`, [tenant])).a;
ok('...the forms offered to it follow', JSON.stringify(aud) === '["Commercial & Partnerships"]', JSON.stringify(aud));
ok('...the role given to it follows', !!(await one(`select 1 x from public.role_groups g join public.roles r on r.id = g.role_id where g.tenant_id = $1 and r.name = 'QA records clerk' and g.department = 'Commercial & Partnerships'`, [tenant]))
  && await holds('EMP-0415', 'QA records clerk'));
const trk = await one(`select department, filters from public.trackers where tenant_id = $1 and name = 'QA partner follow-up'`, [tenant]);
ok('...and so does the tracker kept for it, and its filter', trk.department === 'Commercial & Partnerships' && trk.filters.departments.includes('Commercial & Partnerships') && !trk.filters.departments.includes('Commercial'), JSON.stringify(trk));
await go('/forms', 'EMP-0415');
await page.locator('input[aria-label="Find a form"]').fill('MNO Campaign');
await settle(800);
ok('Shahriar is still offered his division\'s forms', (await text()).includes('MNO Campaign Request'));
await go('/', 'EMP-0416', 2500);
side = await sidebar();
ok('...and Mitu is still offered Campaigns after the rename', side.includes('Campaigns'), side.replace(/\s+/g, ' '));

// A merge: Retail Banking, with a role of its own, into Commercial & Partnerships, which already holds it.
await go('/admin/roles', 'EMP-0445');
await page.locator('select[name="give-group-QA records clerk"]').selectOption('Retail Banking');
await page.locator('[data-role-groups="QA records clerk"]').getByRole('button', { name: /^Give$/ }).click();
await settle(2500);
await page.goto('about:blank');
await settle(800);
await db.query(`insert into public.trackers (tenant_id, name, owner_id, shared_with, department, filters)
                values ($1, 'QA retail queue', 'EMP-7103', 'department', 'Retail Banking', '{}')`, [tenant]);
await go('/admin/people', 'EMP-0650');
ok('the division the file made lists its people', /Retail Banking\s+3 people/.test(await page.locator('[data-division="Retail Banking"]').innerText()));
await page.locator('[data-division="Retail Banking"]').getByRole('button', { name: /Merge/ }).click();
await settle(400);
await page.locator('select[name="merge-into"]').selectOption('Commercial & Partnerships');
ok('merging says the surviving division keeps its own head', (await text()).includes('Commercial & Partnerships keeps its own head, HRBP and CXO.'));
await page.locator('button[name="confirm-merge"]').click();
await settle(3000);
ok('a division is merged into another, and is gone', !(await one(`select 1 x from public.departments where tenant_id = $1 and name = 'Retail Banking'`, [tenant]))
  && (await page.locator('[data-division="Retail Banking"]').count()) === 0);
ok('...its people move', (await dept('EMP-7102')).department === 'Commercial & Partnerships' && (await dept('EMP-7103')).department === 'Commercial & Partnerships');
const groups = await rows(`select g.department from public.role_groups g join public.roles r on r.id = g.role_id where g.tenant_id = $1 and r.name = 'QA records clerk'`, [tenant]);
ok('...a role both held is held once, by the survivor', JSON.stringify(groups.map((g) => g.department)) === '["Commercial & Partnerships"]', JSON.stringify(groups));
ok('...and its trackers move', (await one(`select department from public.trackers where tenant_id = $1 and name = 'QA retail queue'`, [tenant])).department === 'Commercial & Partnerships');
ok('...the survivor keeps its own head', (await one(`select head_employee_id h from public.departments where tenant_id = $1 and name = 'Commercial & Partnerships'`, [tenant])).h === 'EMP-0800');
ok('...and the merge is on the trail', (await audits('division_merged', 'Retail Banking merged into Commercial & Partnerships%')) === 1);

// ------------------------------------------------- clearance checklists
await go('/admin/checklists', 'EMP-0830');
ok('the auditor cannot change checklists', (await text()).includes('forms.settings or org.manage') && (await page.getByRole('button', { name: /Add an item/ }).count()) === 0);
const refused = await asPerson('EMP-2847', `select public.save_checklist(id, 'Finance & Accounts', array['Anything']) from public.form_templates where tenant_id = $1 and name = 'Employee Exit Clearance'`, [tenant]);
ok('...nor, calling the database directly, can Tom', /needs the workflow settings or organisation permission/.test(refused ?? ''), refused ?? 'it was saved');

await go('/admin/checklists', 'EMP-0650');
const fa = page.locator('[data-testid="checklist-tracks"] > section').filter({ hasText: 'Finance & Accounts' }).first();
const faItems = async () => fa.locator('input[aria-label^="Finance & Accounts item"]').evaluateAll((els) => els.map((e) => e.value));
const before = await faItems();
ok('the HR administrator sees the exit clearance checklist for Finance & Accounts', JSON.stringify(before) === JSON.stringify(['Pending IOU or advance', 'Unsettled bills', 'Other payment or recovery', 'Other outstanding issue']), JSON.stringify(before));
ok('...with nothing to save until something changes', await fa.getByRole('button', { name: /^Save$/ }).isDisabled());
await fa.locator('input[aria-label="Finance & Accounts item 2"]').fill('Unsettled bills and claims');
await fa.locator('input[aria-label="Finance & Accounts item 4"]').locator('xpath=..').getByRole('button', { name: 'Move up' }).click();
await fa.locator('input[aria-label="Finance & Accounts item 1"]').locator('xpath=..').getByRole('button', { name: 'Remove' }).click();
await fa.getByRole('button', { name: /Add an item/ }).click();
await fa.locator('input[aria-label^="Finance & Accounts item"]').last().fill('Company credit card cancelled');
const want = ['Unsettled bills and claims', 'Other outstanding issue', 'Other payment or recovery', 'Company credit card cancelled'];
ok('items are edited, moved, removed and added on screen', JSON.stringify(await faItems()) === JSON.stringify(want), JSON.stringify(await faItems()));
await fa.getByRole('button', { name: /^Save$/ }).click();
await settle(2500);
ok('...and saved, saying how many', /Finance & Accounts: 4 items saved/.test(await toasts()), await toasts());
const saved = await rows(`select i.item, i.position, i.active from public.checklist_items i join public.form_templates f on f.id = i.form_template_id
  where i.tenant_id = $1 and f.name = 'Employee Exit Clearance' and i.track = 'Finance & Accounts' order by i.active desc, i.position`, [tenant]);
ok('the database keeps the new order', JSON.stringify(saved.filter((s) => s.active).map((s) => s.item)) === JSON.stringify(want), JSON.stringify(saved));
ok('...and keeps the removed and reworded items, switched off rather than deleted',
  ['Pending IOU or advance', 'Unsettled bills'].every((x) => saved.some((s) => s.item === x && s.active === false)));
ok('...and the save is on the trail', (await audits('checklist_saved', 'Employee Exit Clearance — Finance & Accounts: 4 item(s)')) === 1);
await go('/admin/checklists', 'EMP-0650');
ok('opening the page again shows the saved list', JSON.stringify(await faItems()) === JSON.stringify(want));
await fa.locator('input[aria-label="Finance & Accounts item 4"]').locator('xpath=..').getByRole('button', { name: 'Remove' }).click();
await fa.locator('input[aria-label="Finance & Accounts item 3"]').locator('xpath=..').getByRole('button', { name: 'Remove' }).click();
await fa.locator('input[aria-label="Finance & Accounts item 2"]').locator('xpath=..').getByRole('button', { name: 'Remove' }).click();
await fa.locator('input[aria-label="Finance & Accounts item 1"]').locator('xpath=..').getByRole('button', { name: 'Remove' }).click();
await fa.getByRole('button', { name: /^Save$/ }).click();
await settle(2500);
ok('a track can be left with no checklist at all', /no checklist now/.test(await toasts()) && (await fa.innerText()).includes('this track clears on approval alone')
  && (await one(`select count(*)::int n from public.checklist_items i join public.form_templates f on f.id = i.form_template_id
     where i.tenant_id = $1 and f.name = 'Employee Exit Clearance' and i.track = 'Finance & Accounts' and i.active`, [tenant])).n === 0);
await page.locator('select[aria-label="Form"]').selectOption({ label: 'Gate Pass' });
await settle(2500);
ok('a form with no named tracks says how to give it one', /no named tracks or stages/.test(await text()));

// ------------------------------------------------- the working calendar, briefly
await go('/admin/calendar', 'EMP-0650');
ok('the working calendar opens for whoever keeps the org chart', (await page.locator('[data-testid="calendar-year"]').count()) === 1 && (await page.locator('[data-testid="holiday-list"]').innerText()).length > 20);
await go('/admin/calendar', 'EMP-0830');
ok('...and for the auditor to read, without the government list button', (await page.locator('[data-testid="calendar-year"]').count()) === 1 && (await page.locator('button[name="load-gov"]').count()) === 0);

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA ADMIN (ROLES, PEOPLE) CHECKS PASSED');
process.exit(failures ? 1 : 0);
