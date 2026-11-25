// ================================================================ the persona switcher by department
const fin = (await rows(`select name from public.employees where tenant_id = $1 and department = 'Finance' and active order by name`, [tenant])).map((r) => r.name);
const cfo = await one(`select name from public.employees where tenant_id = $1 and designation = 'Chief Financial Officer'`, [tenant]);
await page.goto(`${BASE}/?as=EMP-2847`); await settle(3000);
await page.getByRole('button', { name: 'Switch persona' }).click(); await settle(800);
let t = await page.locator('[role=menu]').innerText();
ok('with every department, the list is grouped under department headings', /FINANCE/i.test(t) && /OPERATIONS/i.test(t), t.slice(0, 200));
await page.getByLabel('Department').selectOption('Finance'); await settle(600);
const names = await page.locator('[role=menu] [role=menuitem]').allTextContents();
const listed = names.filter((n) => !/Account and two-step/.test(n)).map((n) => n.split('\n')[0].trim());
ok('choosing Finance lists Finance and nobody else', listed.length === fin.length && fin.every((n) => listed.some((l) => l.includes(n))), `${JSON.stringify(listed)} vs ${JSON.stringify(fin)}`);
await page.locator('[role=menu] [role=menuitem]', { hasText: cfo.name }).first().click(); await settle(3500);
const acting = await page.getByTestId('acting-as').innerText().catch(() => '?');
ok('picking the CFO acts as the CFO', acting.includes(cfo.name), `${acting} | ${page.url()}`);
await page.getByRole('button', { name: 'Switch persona' }).click(); await settle(800);
// The department is remembered between opens; go back to all of them to search everyone.
await page.getByLabel('Department').selectOption(''); await settle(400);
await page.getByLabel('Find somebody').fill('payroll'); await settle(500);
t = await page.locator('[role=menu]').innerText();
ok('the search still finds by designation across departments', /Zara Ahmed/.test(t), t.slice(0, 200));
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
