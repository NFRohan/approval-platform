// ================================================================ requests per screen
// How many calls each common screen makes to the server on load, and how
// long the slowest takes, for a performance pass.
await page.goto('about:blank'); await settle(1000);
const calls = [];
page.on('request', (r) => { if (r.url().startsWith(BASE) && !/\/assets\/|\.(js|css|svg|png|woff2)$/.test(r.url())) calls.push({ url: r.url(), t0: Date.now() }); });
page.on('requestfinished', (r) => { const c = calls.find((x) => x.url === r.url() && !x.ms); if (c) c.ms = Date.now() - c.t0; });
const sub = (await one(`select id from public.form_submissions where tenant_id = $1 and status = 'in_progress' limit 1`, [tenant])).id;
const form = (await one(`select id from public.form_templates where tenant_id = $1 and name = 'Capital Expenditure Request'`, [tenant])).id;
const screens = [['/', 'EMP-0445'], ['/approvals', 'EMP-1134'], ['/submissions', 'EMP-2847'], [`/status/${sub}`, 'EMP-0445'], [`/forms/${form}`, 'EMP-2847'],
  ['/trackers', 'EMP-0445'], ['/analytics', 'EMP-0830'], ['/documents', 'EMP-0445'], ['/admin/users', 'EMP-0445'], ['/reports', 'EMP-0445']];
for (const [path, who] of screens) {
  await page.goto(`${BASE}${path}?as=${who}`); await settle(300);
  calls.length = 0;
  const t0 = Date.now();
  await page.reload(); await page.waitForLoadState('networkidle').catch(() => {}); await settle(1500);
  const kinds = {};
  for (const c of calls) { const k = new URL(c.url).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').replace(/\/_serverFn\/.*/, '/_serverFn'); kinds[k] = (kinds[k] ?? 0) + 1; }
  console.log(`PERF ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ':id').padEnd(16)} ${String(calls.length).padStart(3)} calls  slowest ${Math.max(0, ...calls.map((c) => c.ms ?? 0))}ms  load ${Date.now() - t0}ms  ${JSON.stringify(kinds)}`);
}
ok('measured', true);
await browser.close(); await local.stop(); process.exit(0);
