// ================================================================ admins per division
const fin = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Travel & Expense Reimbursement'`, [tenant]);
const hr = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Leave Application'`, [tenant]);
await page.goto(`${BASE}/builder?templateId=${hr.id}&as=EMP-0600`); await settle(4000);
let t = await text();
ok('a Finance-limited designer sees an HR form read-only', (await page.getByTestId('builder-access').count()) === 1, t.slice(0, 200));
await page.goto(`${BASE}/builder?templateId=${fin.id}&as=EMP-0600`); await settle(4000);
ok('...and designs a Finance form', (await page.getByTestId('builder-access').count()) === 0, (await text()).slice(0, 200));
await page.goto(`${BASE}/builder/approvers?templateId=${hr.id}&as=EMP-0600`); await settle(3500);
ok('...and the HR form\'s approvers are read-only too', (await page.getByTestId('builder-access').count()) === 1);
await page.goto(`${BASE}/builder?templateId=${hr.id}&as=EMP-0445`); await settle(4000);
ok('a central designer designs the HR form', (await page.getByTestId('builder-access').count()) === 0);
await page.goto(`${BASE}/admin/roles?as=EMP-0445`); await settle(3500);
t = await text();
ok('the Roles page shows the Finance designer as Finance only, and central roles as the whole organisation', /Finance workflow designer[\s\S]{0,200}Finance only/.test(t) && /Whole organisation/.test(t), t.slice(t.indexOf('Finance workflow'), t.indexOf('Finance workflow') + 200));
await page.getByRole('button', { name: /New role/ }).click(); await settle(800);
ok('a new role can be limited to a division', (await page.getByLabel('Limited to division').locator('option').count()) > 2);
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
