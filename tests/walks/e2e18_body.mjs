// ================================================================ the certificate is for clearances only
await page.goto('about:blank'); await settle(1000);
const done = await one(`select s.id, s.submitted_by from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
  where s.tenant_id = $1 and s.status = 'completed' and t.name <> 'Employee Exit Clearance' order by s.submitted_at desc limit 1`, [tenant]);
await page.goto(`${BASE}/status/${done.id}?as=${done.submitted_by}`);
await settle(3000);
let body = await text();
ok('a completed request that is not a clearance ends in its approval record', /All approvals complete/.test(body) && /Approval record \(PDF\) →/.test(body) && !/View certificate/i.test(body), body.slice(0, 200));
await page.goto(`${BASE}/certificate/${done.id}?as=${done.submitted_by}`);
await settle(2500);
body = await text();
ok('...and has no clearance certificate', /No clearance certificate for this request/.test(body));
// A clearance, completed: the certificate, in the organisation's name.
await page.goto('about:blank'); await settle(1200);
const exit = await one(`select s.id, s.submitted_by from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
  where s.tenant_id = $1 and t.name = 'Employee Exit Clearance' order by s.submitted_at limit 1`, [tenant]);
await db.query(`update public.form_submissions set status = 'completed' where id = $1`, [exit.id]);
await page.goto(`${BASE}/status/${exit.id}?as=${exit.submitted_by}`);
await settle(3000);
body = await text();
ok('a completed clearance offers its certificate', /Clearance complete/.test(body) && /View certificate/.test(body), body.slice(body.indexOf('Home'), body.indexOf('Home') + 700).replace(/\s+/g, ' '));
await page.goto(`${BASE}/certificate/${exit.id}?as=${exit.submitted_by}`);
await settle(3000);
body = await text();
ok('...in the organisation\'s name, not a placeholder', /Company Clearance Certificate/.test(body) && /Local QA|Admin Services Portal/.test(body) && !/the organisation/.test(body), body.slice(0, 300));
await shot('s12-certificate');
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL CERTIFICATE CHECKS PASSED');
process.exit(failures ? 1 : 0);
