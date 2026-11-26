// ================================================================ what the print buttons produce
// Prints Analytics and a clearance certificate to PDF, as the browser's
// Print / Save PDF would, for a person to look at.
const OUT = process.env.PRINT_OUT || REPO + 'dist-mock/';
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/analytics?as=EMP-0830`); await settle(4500);
await page.emulateMedia({ media: 'print' });
await page.pdf({ path: OUT + 'print-analytics.pdf', preferCSSPageSize: true, printBackground: true });
await page.emulateMedia({ media: 'screen' });
const done = (await one(`select s.id from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
  where s.tenant_id = $1 and t.name = 'Employee Exit Clearance' and s.status = 'completed' order by s.submitted_at desc limit 1`, [tenant]));
const by = (await one(`select submitted_by from public.form_submissions where id = $1`, [done.id])).submitted_by;
await page.goto(`${BASE}/certificate/${done.id}?as=${by}`); await settle(4000);
await page.emulateMedia({ media: 'print' });
await page.pdf({ path: OUT + 'print-certificate.pdf', preferCSSPageSize: true, printBackground: true });
ok('printed both', true);
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
