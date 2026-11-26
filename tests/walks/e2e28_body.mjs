// ================================================================ five gaps closed (26 Nov)
// 1.4 Compliance oversees ABC declarations; 2.12 analytics to Excel;
// 2.6 Business Finance tells the requester; 2.1 Payroll tells the HRBP;
// 2.16 the "Processed approvals" standard report.
const { unzipSync, strFromU8 } = req('fflate');
async function raise(form, by, answers) {
  await db.query(`select set_config('app.tenant_id', $1, false), set_config('app.employee_id', $2, false)`, [tenant, by]);
  const f = await formId(form);
  const sub = (await one(`insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
                          values ($1, $2, $3, 'submitted', now()) returning id`, [tenant, f, by])).id;
  for (const [k, v] of Object.entries(answers)) {
    await db.query(`insert into public.submission_values (tenant_id, submission_id, field_name, value) values ($1, $2, $3, $4)`, [tenant, sub, k, v]);
  }
  await db.query(`select public.build_approval_chain('form_submission', $1, $2)`, [sub, f]);
  await db.query(`select set_config('app.tenant_id', '', false), set_config('app.employee_id', '', false)`);
  return sub;
}
const xlsxText = async (dl) => {
  const bytes = await (await import('node:fs/promises')).readFile(await dl.path());
  const files = unzipSync(new Uint8Array(bytes));
  return { ok: bytes[0] === 0x50 && bytes[1] === 0x4b, xml: Object.entries(files).filter(([n]) => /sharedStrings|sheet1/.test(n)).map(([, v]) => strFromU8(v)).join(' ') };
};

// ---------------------------------------------------------------- 1.4: the role page shows the grant
await page.goto(`${BASE}/admin/roles?as=EMP-0445`); await settle(3500);
const grant = page.locator('[data-role-oversees="ABC declarations oversight"]');
ok('Roles: "ABC declarations oversight" sees every Gift & Hospitality Declaration',
  (await grant.count()) === 1 && /Gift & Hospitality Declaration/.test(await grant.innerText()));
const groupsOf = page.locator('[data-role-groups="ABC declarations oversight"]');
ok('...and is held by everyone in Compliance', /Compliance/.test(await groupsOf.innerText()));

// Somebody new in Compliance, on no declaration's route, opens one.
await db.query(`insert into public.employees (tenant_id, employee_id, name, designation, department, line_manager_id)
  values ($1, 'EMP-0899', 'Noor Islam', 'Compliance Analyst', 'Compliance', 'EMP-0700') on conflict do nothing`, [tenant]);
const decl = await one(`select s.id, s.ref_number from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
  where s.tenant_id = $1 and t.name = 'Gift & Hospitality Declaration' and s.status <> 'draft'
  order by s.submitted_at desc limit 1`, [tenant]);
await page.goto(`${BASE}/status/${decl.id}?as=EMP-0899`); await settle(3500);
const declPage = await text();
ok('a Compliance analyst on no route opens an ABC declaration through the role',
  declPage.includes('Gift & Hospitality Declaration') && !/not found|no such request|can't find|cannot find/i.test(declPage), declPage.slice(0, 300));

// ---------------------------------------------------------------- 2.12: analytics to Excel
await page.goto(`${BASE}/analytics?as=EMP-0445`); await settle(4500);
const [dlA] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /^Excel$/ }).click()]);
const a = await xlsxText(dlA);
const missingA = ['Headline', 'Approval time by department', 'Approval time by form', 'SLA by week', 'Average days'].filter((w) => !a.xml.includes(w));
ok('Analytics exports to Excel: headline, approval time by department and by form, the SLA trend',
  a.ok && /^analytics-.*\.xlsx$/.test(dlA.suggestedFilename()) && missingA.length === 0, 'missing: ' + missingA.join(', '));

// ---------------------------------------------------------------- 2.16: Processed approvals
await page.goto(`${BASE}/reports?as=EMP-0830`); await settle(3500);
const card = page.locator('[data-testid="report-cards"] a', { hasText: 'Processed approvals' });
ok('Reports: "Processed approvals" is a standard report', (await card.count()) === 1);
await card.click(); await settle(4500);
const body = await text();
ok('...and lists decided steps', /Processed approvals/.test(body) && /Approved|Rejected|approved|rejected/.test(body), body.slice(0, 300));

// ---------------------------------------------------------------- 2.6: Business Finance tells the requester
const campaignForm = await formId('Campaign Request');
const campId = await raise('Campaign Request', 'EMP-0416', { 'Campaign name': 'Walk BF notice', 'Audience': 'Customer',
  'Approval route': 'Regular', 'Budget': '150000', 'Business case': 'Testing', 'Business finance reviewer': 'EMP-0411' });
const camp = await one(`select s.id from public.form_submissions s join public.approval_requests r on r.submission_id = s.id
  where s.id = $1 and r.stage_label = 'Business finance review' and r.status = 'pending' limit 1`, [campId]);
if (camp) {
  const step = await one(`select id, approver_user_id from public.approval_requests where submission_id = $1 and stage_label = 'Business finance review' and status = 'pending'`, [camp.id]);
  const requester = (await one(`select submitted_by from public.form_submissions where id = $1`, [camp.id])).submitted_by;
  await page.goto(`${BASE}/approvals?as=${step.approver_user_id}`); await settle(3500);
  const row = page.locator(`#approval-${step.id}`);
  await row.getByRole('button', { name: /^Approve$/ }).click(); await settle(900);
  const dlg = page.locator('[role="dialog"]');
  if (await dlg.count()) {
    const ta = dlg.locator('textarea'); if (await ta.count()) await ta.first().fill('Within the plan');
    await dlg.getByRole('button', { name: /Approve/ }).last().click(); await settle(2500);
  }
  const n = await one(`select title from public.notifications where entity_id = $1 and recipient_id = $2 and kind = 'step.business_finance'`, [camp.id, requester]);
  ok('Business Finance approving tells the requester', !!n, JSON.stringify(n));
} else {
  ok('a campaign request waits on Business Finance to test with', false);
}

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
