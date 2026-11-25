// ================================================================ batch 2: trackers, roles by group, notification rules
// ---------------------------------------------------------------- trackers
await page.goto(`${BASE}/trackers?as=EMP-0830`);
await settle(3500);
let body = await text();
ok('the trackers page lists the main tracker and the shared ones', ['Main tracker', 'ABC declarations', 'Exit clearances in progress', 'Overdue approvals'].every((t) => body.includes(t)), body.slice(body.indexOf('Trackers'), body.indexOf('Trackers') + 600) + ' ERR ' + pageErrors.join(' / ').slice(0, 600));
await page.locator('[data-testid="tracker-list"] button', { hasText: 'ABC declarations' }).click();
await settle(2500);
const forms = await page.locator('[data-testid="tracker-rows"] tbody tr td:nth-child(2)').allInnerTexts();
ok('a tracker shows only its own requests', forms.length > 0 && forms.every((f) => f === 'Gift & Hospitality Declaration'), forms.slice(0, 4).join(' | '));
await page.locator('[data-testid="tracker-rows"] tbody tr').first().getByRole('button', { name: /Remind me/ }).click();
await page.getByLabel('Reminder note').fill('Ask Kofi');
await page.getByRole('button', { name: /^Set$/ }).click();
await settle(2000);
body = await text();
ok('a reminder is set on a row, and shown there', /1 with your reminder/.test(body), body.slice(0, 200));
await shot('s10-trackers');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: /Excel/ }).click()]);
ok('the tracker exports to Excel', dl.suggestedFilename().endsWith('.xlsx'), dl.suggestedFilename());
await page.locator('select[aria-label="Priority"]').selectOption('urgent');
await settle(800);
await page.getByRole('button', { name: /New tracker from this view/ }).click();
await page.getByLabel('Tracker name').fill('Urgent ABC');
await page.getByLabel('Shared with').selectOption('department');
await page.getByRole('button', { name: /^Save$/ }).click();
await settle(2500);
await page.goto('about:blank');
await settle(1200);
const t = await one(`select shared_with, department, filters from public.trackers where tenant_id = $1 and name = 'Urgent ABC'`, [tenant]);
ok('a view is kept as a tracker for the department, with its filters', t?.shared_with === 'department' && t?.department === 'Compliance' && t?.filters?.priority === 'urgent', JSON.stringify(t));

// ---------------------------------------------------------------- roles by group
await page.goto(`${BASE}/admin/roles?as=EMP-0445`);
await settle(3500);
const card = page.locator('[data-role-groups="Compliance auditor"]');
await card.locator('select').selectOption('Operations');
await card.getByRole('button', { name: /^Give$/ }).click();
await settle(2500);
ok('a role is given to a department from the Roles page', (await card.innerText()).includes('Operations'));
await shot('s10-roles-group');
await page.goto(`${BASE}/admin/audit?as=EMP-2847`);
await settle(3000);
body = await text();
ok('...and Tom, in Operations, now reads the audit trail', /Audit centre/i.test(body) && !/needs the/.test(body), body.slice(0, 200));
await page.goto(`${BASE}/admin/roles?as=EMP-0445`);
await settle(3000);
await page.locator('[data-role-groups="Compliance auditor"]').getByTitle('Take this role from the department').click();
await settle(2000);

// ---------------------------------------------------------------- notification rules in the builder
await page.goto(`${BASE}/builder/notifications?templateId=${await formId('Capital Expenditure Request')}&as=EMP-0201`);
await settle(3500);
const w = page.locator('[data-watcher="EMP-0700"]');
ok('the builder shows when the CFO is told: approved, above an amount',
  (await w.count()) === 1 && await w.getByLabel(/: Approved$/).isChecked() && !(await w.getByLabel(/: Raised$/).isChecked())
  && (await w.getByLabel(/condition value/).inputValue()) === '1000000');
await w.getByLabel(/: Rejected$/).check();
await page.getByRole('button', { name: /Publish Form/ }).click();
await settle(3000);
await page.goto('about:blank');
await settle(1200);
const nr = await one(`select events, condition from public.notification_rules where tenant_id = $1 and notifyee_user_id = 'EMP-0700' and not is_auto_added
                        and form_template_id = $2`, [tenant, await formId('Capital Expenditure Request')]);
ok('...and publishing keeps the rule, with the event added', JSON.stringify(nr?.events) === JSON.stringify(['approved', 'rejected']) && nr?.condition?.value === '1000000', JSON.stringify(nr));
await page.goto(`${BASE}/builder/notifications?templateId=${await formId('Capital Expenditure Request')}&as=EMP-0201`);
await settle(3000);
await shot('s10-notify-when');

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL BATCH-2 WALK CHECKS PASSED');
process.exit(failures ? 1 : 0);
