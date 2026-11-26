// ================================================================ changes waiting for a second administrator
// SOW §3.6 2.1, 2.5 (maker-checker): a column change, a role change and
// the like used to wait on their own admin screens, where nobody looked.
// Now whoever may decide finds them in Pending Approvals and is told;
// a rejection carries a reason, and whoever asked is told the outcome.

const asPerson = (emp, sql, params = []) => db.exec(
  `begin;
   select set_config('app.tenant_id', '${tenant}', true), set_config('app.employee_id', '${emp}', true),
          set_config('app.role', 'admin', true), set_config('app.mfa', 'true', true);
   ${sql};
   commit;`.replace(/\$(\d)/g, (_, n) => `'${params[n - 1]}'`));

await page.goto('about:blank'); await settle(1000);
const report = await one(`select id, name, columns from public.report_templates where tenant_id = $1 and name = 'Open approvals'`, [tenant]);
await db.exec(`begin;
  select set_config('app.tenant_id', '${tenant}', true), set_config('app.employee_id', 'EMP-0830', true),
         set_config('app.role', 'admin', true), set_config('app.mfa', 'true', true);
  select public.request_report_change('${report.id}', array[${report.columns.map((c) => `'${c}'`).join(',')}, 'requester'], 'For the monthly pack');
  commit;`);
ok('Lena asks for a column on a standard report', !!(await one(`select 1 x from public.report_templates where id = $1 and pending_columns is not null`, [report.id])));

// ---------------------------------------------------------------- Farhana finds it without going looking
await page.goto(`${BASE}/approvals?as=EMP-0445`); await settle(3500);
let t = await text();
ok('Pending Approvals has a "Needs an administrator" section', /Needs an administrator/.test(t), t.slice(0, 300));
ok('...with the column change, who asked, and their note', t.includes(`Column change: ${report.name}`) && /Asked by Lena/.test(t) && t.includes('For the monthly pack'), t.slice(0, 600));
const side = await page.locator('aside').innerText();
ok('the sidebar counts it on Pending Approvals', /Pending Approvals\s*\d+/.test(side), side.slice(0, 300));
await page.getByRole('button', { name: /^Notifications/ }).click(); await settle(1500);
t = await text();
ok('...and her notifications say it is waiting', t.includes(`Column change waiting: ${report.name}`), t.slice(0, 400));
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- turned down, with a reason
const item = page.locator('[data-admin-item="report"]').first();
await item.getByRole('button', { name: 'Reject' }).click(); await settle(500);
await item.getByRole('button', { name: 'Turn it down' }).click(); await settle(800);
ok('turning it down without a reason is refused', !!(await one(`select 1 x from public.report_templates where id = $1 and pending_columns is not null`, [report.id])));
await item.getByLabel('Reason').fill('Requester is already on the Rejected requests report');
await item.getByRole('button', { name: 'Turn it down' }).click(); await settle(2500);
const after = await one(`select columns, pending_columns from public.report_templates where id = $1`, [report.id]);
ok('with a reason, it is turned down and the columns stay as they were', after.pending_columns === null && after.columns.join() === report.columns.join(), JSON.stringify(after));
t = await text();
ok('...and it leaves the queue', !t.includes(`Column change: ${report.name}`), t.slice(0, 300));

// ---------------------------------------------------------------- Lena hears why, and the bell takes her to the report
await page.goto(`${BASE}/?as=EMP-0830`); await settle(3000);
await page.getByRole('button', { name: /^Notifications/ }).click(); await settle(1500);
t = await text();
ok('Lena is told it was not approved, and why', /was not approved/.test(t) && t.includes('Requester is already on the Rejected requests report'), t.slice(0, 500));
await page.getByText(/Your column change to .* was not approved/).first().click(); await settle(2500);
ok('...and the notification opens the report', page.url().includes(`/reports/${report.id}`), page.url());

// ---------------------------------------------------------------- a role change reaches the security officer
const officer = (await one(`select er.employee_id from public.employee_roles er join public.roles r on r.id = er.role_id
  where r.tenant_id = $1 and r.name = 'Security officer' limit 1`, [tenant])).employee_id;
const role = await one(`select id from public.roles where tenant_id = $1 and name = 'Workflow settings'`, [tenant]);
await asPerson('EMP-0445', `select public.propose_role_change($1, 'Workflow settings', array['forms.settings', 'reports.view', 'audit.view'])`, [role.id]);
await page.goto(`${BASE}/approvals?as=${officer}`); await settle(3500);
t = await text();
ok('the security officer finds the role change in Pending Approvals, with what it adds', t.includes('Change to role: Workflow settings') && t.includes('adds audit.view'), t.slice(0, 500));
await page.locator('[data-admin-item="role"]').first().getByRole('button', { name: 'Approve' }).click(); await settle(2500);
const perms = (await one(`select permissions from public.roles where id = $1`, [role.id])).permissions;
ok('approving it there changes the role', perms.includes('audit.view'), perms.join());
const told = await one(`select count(*)::int n from public.notifications where recipient_id = 'EMP-0445' and kind = 'admin.decided' and entity_id = $1`, [role.id]);
ok('...and Farhana is told', told.n === 1, String(told.n));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
