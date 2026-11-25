// ================================================================ builder steps opened with no form
for (const p of ['/builder/approvers', '/builder/notifications']) {
  await page.goto(`${BASE}${p}?as=EMP-0445`);
  await settle(3000);
  const t = await text();
  ok(`${p} with no form says to choose one`, /Choose a form first/.test(t) && !/Something went wrong/.test(t), t.slice(0, 200));
  await shot(p.replace(/\//g, '_'));
}
await page.getByRole('link', { name: /Go to the form builder/ }).click();
await settle(2500);
ok('...and its link leads to the builder', new URL(page.url()).pathname === '/builder');
const f = await one(`select id from public.form_templates where tenant_id = $1 and status = 'published' order by name limit 1`, [tenant]);
for (const p of ['/builder/approvers', '/builder/notifications']) {
  await page.goto(`${BASE}${p}?templateId=${f.id}&as=EMP-0445`);
  await settle(3500);
  const t = await text();
  ok(`${p} with a form still opens it`, !/Choose a form first|Something went wrong/.test(t) && /Approver|Notif/i.test(t), t.slice(0, 200));
}
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `${failures} FAILED` : 'ALL BUILDER-STEP CHECKS PASSED');
process.exit(failures ? 1 : 0);
