// ================================================================ dates are entered dd/MM/yyyy
const leave = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Leave Application'`, [tenant]);
const forms = await rows(`select id, name from public.form_templates where tenant_id = $1 and status = 'published'`, [tenant]);
let native = 0;
for (const f of forms) {
  await page.goto(`${BASE}/forms/${f.id}?as=EMP-2847`); await settle(2000);
  for (let i = 0; i < 2; i++) { native += await page.locator('input[type="date"]').count(); await page.getByRole('button', { name: /^Next/ }).first().click().catch(() => {}); await settle(700); }
}
ok('no form uses the browser\'s own date picker', native === 0, String(native));
await page.goto(`${BASE}/forms/${leave.id}?as=EMP-2847`); await settle(3000);
for (let i = 0; i < 3 && (await page.locator('input[data-date]').count()) === 0; i++) { await page.getByRole('button', { name: /^Next/ }).first().click(); await settle(1000); }
const d = page.locator('input[data-date]').first();
ok('a date field shows the format it wants', (await d.getAttribute('placeholder')) === 'dd/mm/yyyy');
await d.click(); await d.pressSequentially('02112026'); await page.keyboard.press('Tab'); await settle(300);
ok('typing 02112026 reads as 02/11/2026', (await d.inputValue()) === '02/11/2026', await d.inputValue());
await d.fill(''); await d.pressSequentially('31/02/2026'); await page.keyboard.press('Tab'); await settle(300);
ok('31/02/2026 is not a date, and says so', (await d.getAttribute('aria-invalid')) === 'true');
await d.fill('2026-12-14'); await page.keyboard.press('Tab'); await settle(300);
ok('a pasted ISO date is understood, and shown dd/MM/yyyy', (await d.inputValue()) === '14/12/2026', await d.inputValue());
await page.getByRole('button', { name: 'Pick from a calendar' }).first().click(); await settle(600);
ok('the calendar opens', (await page.locator('[role=grid], table').count()) > 0);
await page.keyboard.press('Escape');
// The trackers' date filters and delegation dates use it too.
await page.goto(`${BASE}/trackers?as=EMP-0830`); await settle(3500);
ok('trackers filter by dd/MM/yyyy dates', (await page.locator('input[data-date]').count()) >= 2 && (await page.locator('input[type="date"]').count()) === 0);
await page.goto(`${BASE}/approvals/delegate?as=EMP-1134`); await settle(3000);
ok('delegation dates are dd/MM/yyyy', (await page.locator('input[type="date"]').count()) === 0);
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
