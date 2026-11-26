// ================================================================ QA ops C: reports and analytics, checked against the database
const TOM = 'EMP-2847', FARAH = 'EMP-0445', LENA = 'EMP-0830', KOFI = 'EMP-0831';
const go = async (path, as, ms = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${as}`); await settle(ms); };
const quiet = async () => { await page.goto('about:blank'); await settle(800); };
const sidebar = async () => page.locator('aside').innerText();
let body;

// ---------------------------------------------------------------- who may
await go('/', KOFI, 2500);
ok('reports: a compliance officer without reports.view is offered neither Reports nor Analytics', !/Analytics|Reports/.test(await sidebar()));
await go('/reports', KOFI);
ok('reports: ...and opening /reports directly is refused', /needs the reports\.view permission/.test(await text()));
await go('/analytics', KOFI);
ok('analytics: ...as is /analytics', /needs the reports\.view permission/.test(await text()));
await go('/reports', LENA);
ok('reports: the auditor sees the seven standard reports', (await page.locator('[data-testid="report-cards"] a').count()) >= 7 && /Standard reports/i.test(await text()));
ok('reports: ...but may not build one (no New report)', (await page.getByRole('button', { name: /New report/i }).count()) === 0);
await go('/reports/new', LENA);
ok('reports: ...and /reports/new refuses her', /needs the reports\.manage permission/.test(await text()));

// ---------------------------------------------------------------- the standard reports, counted against the tables
const rowCount = async () => Number((/([\d,]+) rows?/.exec(await page.locator('[data-testid="row-count"]').innerText())?.[1] ?? '-1').replace(/,/g, ''));
const reportId = async (name) => (await one(`select id from public.report_templates where tenant_id = $1 and name = $2`, [tenant, name])).id;
const SUBS = `from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
              left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by where s.tenant_id = $1 and s.status <> 'draft'`;
const STEPS = `from public.approval_requests r where r.tenant_id = $1`;
const STANDARD = [
  ['All requests', `select count(*)::int n ${SUBS} and s.submitted_at >= now() - interval '90 days'`],
  ['Open approvals', `select count(*)::int n ${STEPS} and r.status in ('pending', 'clarification')`],
  ['Missed deadlines', `select count(*)::int n ${STEPS} and r.opened_at >= now() - interval '90 days'
                          and ((r.acted_at is not null and r.deadline_at is not null and r.acted_at > r.deadline_at)
                               or (r.acted_at is null and r.status = 'pending' and r.deadline_at < now()))`],
  ['Upcoming approvals', `select count(*)::int n ${STEPS} and r.status = 'waiting'`],
  ['Rejected requests', `select count(*)::int n ${SUBS} and s.status = 'rejected' and s.submitted_at >= now() - interval '90 days'`],
  ['Approver performance', `select count(distinct r.approver_user_id)::int n ${STEPS} and r.opened_at >= now() - interval '90 days'
                              and r.approver_user_id is not null and r.status not in ('waiting', 'skipped')`],
  ['Finance requests by amount', `select count(*)::int n ${SUBS} and t.category = 'Finance' and s.submitted_at >= now() - interval '90 days'`],
];
for (const [name, sql] of STANDARD) {
  await quiet();
  const want = (await one(sql, [tenant])).n;
  const id = await reportId(name);
  await go(`/reports/${id}`, LENA, 3500);
  const got = await rowCount();
  ok(`reports: "${name}" opens and counts what the database holds (${want})`, got === want, `${got} shown, ${want} expected`);
}

// Filters on All requests.
const allId = await reportId('All requests');
await quiet();
const allTime = (await one(`select count(*)::int n ${SUBS}`, [tenant])).n;
const allCompleted = (await rows(`select s.ref_number ${SUBS} and s.status = 'completed'`, [tenant])).map((r) => r.ref_number);
const allFinanceCompleted = (await one(`select count(*)::int n ${SUBS} and s.status = 'completed' and e.department = 'Finance'`, [tenant])).n;
const bexley = (await one(`select count(*)::int n ${SUBS} and (s.ref_number ilike '%bexley%' or t.name ilike '%bexley%' or e.name ilike '%bexley%')`, [tenant])).n;
await go(`/reports/${allId}`, LENA, 3500);
await page.locator('select[aria-label="Period"]').selectOption('all');
await settle(2500);
ok(`reports: Period "All time" counts every request (${allTime})`, (await rowCount()) === allTime, String(await rowCount()));
await page.getByRole('button', { name: 'Filter by status' }).click();
await settle(400);
await page.getByRole('button', { name: 'Completed', exact: true }).click();
await page.keyboard.press('Escape');
await settle(2500);
ok(`reports: ...the status filter narrows to completed (${allCompleted.length})`, (await rowCount()) === allCompleted.length, String(await rowCount()));
// The CSV export carries the filters on screen and exactly those rows.
const csvHref = await page.locator('[data-testid="export-csv"]').getAttribute('href');
const csv = await page.evaluate(async (h) => { const r = await fetch(h); return { status: r.status, body: await r.text() }; }, csvHref);
const csvRefs = allCompleted.filter((ref) => ref && csv.body.includes(ref));
ok('reports: the CSV export holds the same completed requests', csv.status === 200 && csvRefs.length === allCompleted.filter(Boolean).length,
  `${csvRefs.length} of ${allCompleted.filter(Boolean).length} references in the file`);
ok('reports: ...and no request of another status', !/\bRejected\b|\bIn progress\b/i.test(csv.body.split('\n').slice(1).join('\n').replace(/Status: Completed/g, '')), csv.body.slice(0, 300));
await page.getByRole('button', { name: 'Filter by department' }).click();
await settle(400);
await page.getByRole('button', { name: 'Finance', exact: true }).click();
await page.keyboard.press('Escape');
await settle(2500);
ok(`reports: ...and with Finance as well (${allFinanceCompleted})`, (await rowCount()) === allFinanceCompleted, String(await rowCount()));
await page.getByRole('button', { name: /Clear filters/ }).click();
await settle(2500);
await page.locator('input[aria-label="Search the report"]').fill('Bexley');
await page.locator('input[aria-label="Search the report"]').press('Enter');
await settle(2500);
ok(`reports: search by a person finds their requests (${bexley})`, (await rowCount()) === bexley, String(await rowCount()));

// An administrator builds a report, and schedules it.
await go('/reports/new', FARAH, 3000);
await page.locator('button[name="dataset-requests"]').click();
await settle(800);
await page.locator('select[aria-label="Period"]').selectOption('all');
await page.getByRole('button', { name: 'Filter by status' }).click();
await settle(300);
await page.getByRole('button', { name: 'Rejected', exact: true }).click();
await page.keyboard.press('Escape');
await page.locator('input[name="report-name"]').fill('QA every rejection');
await settle(1500);
await page.locator('button[name="save-report"]').click();
await page.waitForURL(/\/reports\/[0-9a-f-]{36}/, { timeout: 15000 });
await settle(3000);
await quiet();
const allRejected = (await one(`select count(*)::int n ${SUBS} and s.status = 'rejected'`, [tenant])).n;
const qa = await one(`select id, dataset, filters, created_by, standard from public.report_templates where tenant_id = $1 and name = 'QA every rejection'`, [tenant]);
ok('reports: the new report is saved with its dataset and filters', qa?.dataset === 'requests' && qa?.filters?.status?.[0] === 'rejected' && qa?.filters?.period === 'all' && qa?.created_by === FARAH && !qa?.standard, JSON.stringify(qa));
await go(`/reports/${qa.id}`, FARAH, 3500);
ok(`reports: ...and runs with them (${allRejected} rejected requests, all time)`, (await rowCount()) === allRejected && (await page.locator('[data-testid="report-name"]').innerText()) === 'QA every rejection', String(await rowCount()));
await page.getByRole('button', { name: /Schedule/ }).click();
await page.locator('select[name="schedule"]').selectOption('monthly');
await page.locator('select[name="format"]').selectOption('csv');
await page.locator('input[aria-label="Add a recipient"]').fill('Lena');
await settle(400);
await page.getByRole('button', { name: /Lena Ortiz/ }).click();
await page.getByRole('button', { name: 'Save schedule' }).click();
await settle(2500);
await quiet();
const sch = await one(`select schedule, format, recipients from public.report_templates where id = $1`, [qa.id]);
ok('reports: it is scheduled monthly, as CSV, to the auditor', sch.schedule === 'monthly' && sch.format === 'csv' && JSON.stringify(sch.recipients) === JSON.stringify([LENA]), JSON.stringify(sch));
await go('/reports', LENA, 3000);
const qaCard = page.locator('[data-testid="report-cards"] a', { hasText: 'QA every rejection' });
ok('reports: the auditor sees it among the organisation\'s reports, marked monthly to one person', (await qaCard.count()) === 1 && /monthly on the 1st to 1 person/i.test(await qaCard.innerText()));
// The daily round queues a scheduled report that is due.
await quiet();
await rows(`update public.report_templates set last_sent_at = now() - interval '40 days' where id = $1`, [qa.id]);
const queued = (await one(`select app.queue_due_reports() n`)).n;
const mail = await one(`select status, recipient_id, context from public.email_outbox where tenant_id = $1 and report_id = $2 and kind = 'report.scheduled' order by created_at desc limit 1`, [tenant, qa.id]);
ok('reports: a scheduled report that is due is queued to its recipient, in its format', queued >= 1 && mail?.recipient_id === LENA && mail?.status === 'queued' && mail?.context?.format === 'csv', JSON.stringify({ queued, mail }));

// ---------------------------------------------------------------- analytics against the tables
const kpi = async (label) => Number((new RegExp(label + '\\s+([\\d,]+)').exec(await page.locator('[data-testid="kpis"]').innerText())?.[1] ?? '-1').replace(/,/g, ''));
const expect = async (days, dept = null, form = null) => one(
  `select count(*)::int raised, count(*) filter (where s.status = 'completed')::int completed,
          count(*) filter (where s.status in ('submitted','in_progress','on_hold'))::int open
     ${SUBS} and s.submitted_at >= now() - ($2 || ' days')::interval and ($3::text is null or e.department = $3) and ($4::text is null or t.name = $4)`,
  [tenant, String(days), dept, form]);
const overdueNow = async (dept = null, form = null) => (await one(
  `select count(*)::int n from public.approval_requests r
     left join public.form_submissions s on s.id = r.submission_id left join public.form_templates t on t.id = s.form_template_id
     left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
    where r.tenant_id = $1 and r.status = 'pending' and r.deadline_at < now() and ($2::text is null or e.department = $2) and ($3::text is null or t.name = $3)`,
  [tenant, dept, form])).n;
await quiet();
let want = await expect(90);
let wantOver = await overdueNow();
await go('/analytics', LENA, 4500);
ok(`analytics 90 days: Requests raised = ${want.raised}`, (await kpi('Requests raised')) === want.raised, String(await kpi('Requests raised')));
ok(`analytics 90 days: Completed = ${want.completed}`, (await kpi('Completed')) === want.completed, String(await kpi('Completed')));
ok(`analytics 90 days: Raised and still open = ${want.open}`, (await kpi('Raised and still open')) === want.open, String(await kpi('Raised and still open')));
ok(`analytics: Overdue now = ${wantOver} steps past their deadline`, (await kpi('Overdue now')) === wantOver, String(await kpi('Overdue now')));
ok('analytics: the charts are drawn', (await page.locator('.recharts-surface').count()) >= 4, String(await page.locator('.recharts-surface').count()));
// Charts as tables.
await page.getByRole('button', { name: 'Show Outcomes as a table' }).click();
await settle(500);
const outcomes = await page.getByRole('button', { name: 'Show Outcomes as a chart' }).locator('xpath=ancestor::section[1]').locator('tbody tr').allInnerTexts();
const outcomeSum = outcomes.reduce((a, r) => a + Number(r.split('\t').pop()), 0);
ok('analytics: Outcomes as a table adds up to the requests raised', outcomeSum === want.raised, `${outcomes.join(' / ')} = ${outcomeSum}`);
await page.getByRole('button', { name: 'Show By department as a table' }).click();
await settle(500);
const deptRows = await page.getByRole('button', { name: 'Show By department as a chart' }).locator('xpath=ancestor::section[1]').locator('tbody tr').allInnerTexts();
await quiet();
const deptWant = Object.fromEntries((await rows(`select coalesce(e.department, 'Unassigned') d, count(*)::int n ${SUBS} and s.submitted_at >= now() - interval '90 days' group by 1`, [tenant])).map((r) => [r.d, r.n]));
const deptGot = Object.fromEntries(deptRows.map((r) => r.split('\t')).map(([d, n]) => [d, Number(n)]));
ok('analytics: By department as a table matches the database, department by department', JSON.stringify(Object.keys(deptWant).sort().map((k) => [k, deptWant[k]])) === JSON.stringify(Object.keys(deptGot).sort().map((k) => [k, deptGot[k]])),
  `${JSON.stringify(deptGot)} vs ${JSON.stringify(deptWant)}`);

for (const [btn, days] of [['30 days', 30], ['12 months', 365]]) {
  await quiet();
  want = await expect(days);
  await go('/analytics', LENA, 4000);
  await page.getByRole('button', { name: btn, exact: true }).click();
  await settle(3500);
  ok(`analytics ${btn}: raised ${want.raised}, completed ${want.completed}, open ${want.open}`,
    (await kpi('Requests raised')) === want.raised && (await kpi('Completed')) === want.completed && (await kpi('Raised and still open')) === want.open,
    `${await kpi('Requests raised')}/${await kpi('Completed')}/${await kpi('Raised and still open')}`);
}
await quiet();
want = await expect(90, 'Finance');
wantOver = await overdueNow('Finance');
await go('/analytics', LENA, 4000);
await page.locator('select[aria-label="Department"]').selectOption('Finance');
await settle(3500);
ok(`analytics Finance, 90 days: raised ${want.raised}, completed ${want.completed}, open ${want.open}`,
  (await kpi('Requests raised')) === want.raised && (await kpi('Completed')) === want.completed && (await kpi('Raised and still open')) === want.open,
  `${await kpi('Requests raised')}/${await kpi('Completed')}/${await kpi('Raised and still open')}`);
ok(`analytics Finance: overdue steps on Finance's requests = ${wantOver}`, (await kpi('Overdue now')) === wantOver, String(await kpi('Overdue now')));
await quiet();
want = await expect(90, null, 'Travel & Expense Reimbursement');
await go('/analytics', LENA, 4000);
await page.locator('select[aria-label="Form"]').selectOption('Travel & Expense Reimbursement');
await settle(3500);
ok(`analytics one form (Travel & Expense), 90 days: raised ${want.raised}, completed ${want.completed}`,
  (await kpi('Requests raised')) === want.raised && (await kpi('Completed')) === want.completed, `${await kpi('Requests raised')}/${await kpi('Completed')}`);
await page.getByRole('button', { name: 'Show Requests by form as a table' }).click();
await settle(500);
body = await page.getByRole('button', { name: 'Show Requests by form as a chart' }).locator('xpath=ancestor::section[1]').innerText();
ok('analytics: ...and By form lists that form alone', body.includes('Travel & Expense Reimbursement') && !body.includes('Leave Application'), body.slice(0, 200));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA OPS C CHECKS PASSED');
process.exit(failures ? 1 : 0);
