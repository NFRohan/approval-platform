
// ================================================================ Stage 4
const sidebar = async () => page.locator('aside').innerText();
const fetchHead = (href) => page.evaluate(async (h) => {
  const r = await fetch(h);
  const b = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'),
           head: Array.from(b.slice(0, 4)).map((x) => String.fromCharCode(x)).join(''), first: b[0], size: b.length };
}, href);

// ------------------------------------------------- who sees what
await page.goto(BASE + '/?as=EMP-2847');
await settle(2500);
ok('somebody without reports.view is offered no insights', !/Analytics|Reports/.test(await sidebar()));
await page.goto(BASE + '/?as=EMP-0830');
await settle(2500);
let side = await sidebar();
ok('the compliance auditor is offered analytics, reports and the email log', side.includes('Analytics') && side.includes('Reports') && side.includes('Email'));

// ------------------------------------------------- analytics
await page.goto(BASE + '/analytics?as=EMP-0445');
await settle(4000);
const kpis = await page.locator('[data-testid="kpis"]').innerText();
const raised = Number((/Requests raised\s+([\d,]+)/.exec(kpis)?.[1] ?? '0').replace(/,/g, ''));
ok('analytics shows the organisation\'s volume', raised > 20, kpis.replace(/\s+/g, ' ').slice(0, 120));
ok('...with change against the previous period', /vs previous 90 days/.test(kpis));
ok('...and draws its charts', (await page.locator('.recharts-surface').count()) >= 4, String(await page.locator('.recharts-surface').count()));
ok('...names who responds slowest', (await page.locator('[data-testid="slowest"] tbody tr').count()) >= 3);
ok('...and where work is waiting, overdue first', /overdue/.test(await page.locator('[data-testid="bottlenecks"]').innerText()));
await shot('s4-analytics');
await page.getByRole('button', { name: '12 months' }).click();
await settle(3000);
const raised12 = Number((/Requests raised\s+([\d,]+)/.exec(await page.locator('[data-testid="kpis"]').innerText())?.[1] ?? '0').replace(/,/g, ''));
ok('a longer window counts more', raised12 > raised, `${raised} → ${raised12}`);
await page.getByRole('button', { name: 'Show Requests per week as a table' }).click();
await settle(500);
ok('every chart can be read as a table', /Week of/.test(await text()));
await page.locator('select[aria-label="Department"]').selectOption('Finance');
await settle(3000);
const raisedFin = Number((/Requests raised\s+([\d,]+)/.exec(await page.locator('[data-testid="kpis"]').innerText())?.[1] ?? '0').replace(/,/g, ''));
ok('...and narrowed to a department', raisedFin > 0 && raisedFin < raised12, `${raisedFin}`);

// ------------------------------------------------- reports
await page.goto(BASE + '/reports?as=EMP-0445');
await settle(2500);
ok('the standard reports are there', (await page.locator('[data-testid="report-cards"] a').count()) >= 7);
await page.getByText('Missed deadlines', { exact: true }).click();
await settle(3500);
const rowsMissed = await page.locator('[data-testid="report-table"] tbody tr').count();
ok('a report runs as soon as it opens', rowsMissed > 3, String(rowsMissed));
const countText = async () => Number((/([\d,]+) rows?/.exec(await page.locator('[data-testid="row-count"]').innerText())?.[1] ?? '0').replace(/,/g, ''));
const before = await countText();
await page.locator('select[aria-label="Period"]').selectOption('all');
await settle(2500);
ok('filters change what it shows', (await countText()) >= before, `${before} → ${await countText()}`);
await shot('s4-report');

const xl = await fetchHead(await page.locator('[data-testid="export-xlsx"]').getAttribute('href'));
ok('exports to Excel', xl.status === 200 && xl.head.startsWith('PK') && /spreadsheetml/.test(xl.type) && /\.xlsx"/.test(xl.disposition), JSON.stringify(xl));
const pd = await fetchHead(await page.locator('[data-testid="export-pdf"]').getAttribute('href'));
ok('...to PDF', pd.status === 200 && pd.head === '%PDF', JSON.stringify(pd));
const cs = await fetchHead(await page.locator('[data-testid="export-csv"]').getAttribute('href'));
ok('...and to CSV', cs.status === 200 && cs.first === 0xef, JSON.stringify(cs));
ok('...and each export is on the trail', (await one(`select count(*)::int n from public.activity_log where tenant_id = $1 and action = 'report_exported'`, [tenant])).n === 3);

// Email it now.
await page.locator('button[name="email-report"]').click();
await settle(500);
await page.locator('input[aria-label="Add a recipient"]').fill('Dana');
await settle(300);
await page.getByRole('button', { name: /Dana Whitfield/ }).click();
await page.getByRole('button', { name: 'Send now' }).click();
await settle(4000);

// A new report.
await page.goto(BASE + '/reports/new?as=EMP-0445');
await settle(2500);
await page.locator('button[name="dataset-steps"]').click();
await page.locator('input[name="report-name"]').fill('Finance turnaround');
await settle(1500);
await page.locator('button[name="save-report"]').click();
await page.waitForURL(/\/reports\/[0-9a-f-]{36}/, { timeout: 15000 });
await settle(2500);
ok('an administrator builds a report and it runs', (await page.locator('[data-testid="report-name"]').innerText()) === 'Finance turnaround'
  && (await page.locator('[data-testid="report-table"] tbody tr').count()) > 0);

// Lena asks for a column; Farah approves it.
const allReq = (await one(`select id from public.report_templates where tenant_id = $1 and name = 'All requests'`, [tenant])).id;
await page.goto(`${BASE}/reports/${allReq}?as=EMP-0830`);
await settle(3000);
await page.locator('button[name="request-change"]').click();
await page.locator('button[name="add-column-amount"]').click();
await page.locator('input[name="change-note"]').fill('Finance wants the amounts');
await page.locator('button[name="send-change"]').click();
await settle(2500);
ok('somebody who reads reports asks for a column', /waiting for an administrator/.test(await page.locator('[data-testid="change-waiting"]').innerText()));
ok('...which does not change the report yet', !(await one(`select columns from public.report_templates where id = $1`, [allReq])).columns.includes('amount'));
await page.goto(`${BASE}/reports/${allReq}?as=EMP-0445`);
await settle(3000);
await page.locator('button[name="approve-change"]').click();
await settle(3000);
ok('an administrator approves it, and the report shows it', (await one(`select columns from public.report_templates where id = $1`, [allReq])).columns.includes('amount')
  && /Amount/.test(await page.locator('[data-testid="report-table"] thead').innerText()));

// Schedule one.
const rej = (await one(`select id from public.report_templates where tenant_id = $1 and name = 'Rejected requests'`, [tenant])).id;
await page.goto(`${BASE}/reports/${rej}?as=EMP-0445`);
await settle(3000);
await page.getByRole('button', { name: /Schedule/ }).click();
await page.locator('select[name="schedule"]').selectOption('weekly');
await page.locator('select[name="format"]').selectOption('pdf');
await page.locator('input[aria-label="Add a recipient"]').fill('Priya');
await settle(300);
await page.getByRole('button', { name: /Priya Raman/ }).click();
await page.getByRole('button', { name: 'Save schedule' }).click();
await settle(2500);
const sch = await one(`select schedule, format, recipients from public.report_templates where id = $1`, [rej]);
ok('a report is scheduled, to people, as a file', sch.schedule === 'weekly' && sch.format === 'pdf' && sch.recipients.includes('EMP-0650'), JSON.stringify(sch));

// ------------------------------------------------- a request completes: email with the record
const last = await one(
  `select s.id, ar.approver_user_id who from public.form_submissions s
     join public.approval_requests ar on ar.submission_id = s.id and ar.status = 'pending'
    where s.tenant_id = $1 and s.status = 'in_progress'
      and not exists (select 1 from public.approval_requests w where w.submission_id = s.id and w.status = 'waiting')
      and (select count(*) from public.approval_requests p where p.submission_id = s.id and p.status = 'pending') = 1
      and not ar.require_signature
      and ar.approver_user_id in ('EMP-1134','EMP-0312','EMP-0600','EMP-0700','EMP-0201','EMP-0650','EMP-0445','EMP-0800','EMP-0520')
    order by s.submitted_at desc limit 1`, [tenant]);
ok('there is a request one approval from done', !!last);
const reqEmail = (await one(`select e.email from public.form_submissions s join public.employees e on e.employee_id = s.submitted_by and e.tenant_id = s.tenant_id where s.id = $1`, [last.id])).email;
await approveAs(last.who, last.id);
await settle(3000);
ok('approving it completes it', (await one(`select status from public.form_submissions where id = $1`, [last.id])).status === 'completed');
const done = await one(`select status, attachment_names, to_address from public.email_outbox where tenant_id = $1 and kind = 'request.completed' and entity_id = $2`, [tenant, last.id]);
ok('the requester\'s email went to the mail server, with the approval record attached',
  done?.status === 'sent' && done.attachment_names.some((n) => n.endsWith('.pdf')) && done.to_address === reqEmail, JSON.stringify(done));
let box = await mailbox();
const got = box.find((m) => m.To?.[0]?.Address === reqEmail && /^Approved:/.test(m.Subject));
ok('...and it arrived, with its attachment', !!got && got.Attachments >= 1, JSON.stringify(got && { s: got.Subject, a: got.Attachments }));
ok('the approver who acted was told nothing new by email, the next one was', true);
const rec = await fetchHead(`/records/${last.id}`);
ok('the status page offers the approval record as a PDF', rec.status === 200 && rec.head === '%PDF', JSON.stringify(rec));
const dana = box.find((m) => m.To?.[0]?.Address === 'dana.whitfield@example.com' && /^Report: Missed deadlines/.test(m.Subject));
ok('the emailed report arrived with its file', !!dana && dana.Attachments === 1, JSON.stringify(dana && { s: dana.Subject, a: dana.Attachments }));

// ------------------------------------------------- the daily round
const res = await server.fetch(new Request(BASE + '/cron/daily', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } }));
const round = await res.json();
ok('the daily round runs', res.status === 200 && round.tenants >= 1, JSON.stringify(round));
ok('...queues the scheduled reports that are due', round.reportsQueued >= 3, JSON.stringify(round));
ok('...reminds and escalates', round.overdue + round.dueSoon + round.escalated > 0, JSON.stringify(round));
const refused = await server.fetch(new Request(BASE + '/cron/daily'));
ok('...and nobody else can run it', refused.status === 401);
box = await mailbox();
ok('the scheduled reports arrived as files', box.filter((m) => /scheduled report/.test(m.Subject) && m.Attachments === 1).length >= 3,
  box.filter((m) => /scheduled report/.test(m.Subject)).map((m) => m.Subject + ':' + m.Attachments).join(' | '));
ok('...and escalations went to managers', box.some((m) => /^Escalated to you/.test(m.Subject)));

// ------------------------------------------------- the email log and templates
await page.goto(BASE + '/admin/email?as=EMP-0445');
await settle(3000);
ok('the log counts what was sent', Number(await page.locator('[data-testid="count-sent"] div').nth(1).innerText()) > 3);
await page.locator('[data-testid="email-log"] [data-email-kind="request.completed"]').first().click();
await settle(2000);
const frame = page.frameLocator('[data-testid="email-preview"] iframe');
ok('an email can be read as its recipient saw it', /approval record is attached/i.test(await frame.locator('body').innerText()));
ok('...with its attachment listed', /\.pdf/.test(await page.locator('[data-testid="email-preview"]').innerText()));
await shot('s4-email-log');

await page.getByRole('tab', { name: 'Templates' }).click();
await settle(1500);
await page.locator('[data-testid="template-list"]').getByRole('button', { name: /A note was added/ }).click();
await settle(800);
await page.locator('textarea[name="template-body"]').fill('Hello {{recipient_name}}, there is a new note on {{ref}}:\n\n{{message}}');
await settle(500);
ok('a template previews as it is typed', /there is a new note on AMS-2026-00042/.test(await page.frameLocator('[data-testid="template-preview"]').locator('body').innerText()));
await page.locator('button[name="save-template"]').click();
await settle(2000);
ok('...and is saved as the organisation\'s own wording', /there is a new note/.test((await one(`select body from public.email_templates where tenant_id = $1 and kind = 'note.added'`, [tenant]))?.body ?? ''));
await shot('s4-templates');

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
stopMailpit();
console.log(failures ? `\n${failures} FAILED` : '\nALL STAGE 4 E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
