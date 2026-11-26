// ================================================================ SOW gaps
const { createHash, createCipheriv, randomBytes: rnd } = await import('node:crypto');
const seal = (secret) => {
  const key = createHash('sha256').update('totp-secret:' + (process.env.MFA_KEY || process.env.JWT_SECRET)).digest();
  const iv = rnd(12); const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
};
const { startMock } = await import(pathToFileURL(REPO + 'scripts/servicedesk-mock.mjs').href);
process.env.OUTBOUND_ALLOW_PRIVATE = '1';
const mock = await startMock({});

await page.goto('about:blank');
await settle(1500);
await db.query(`update public.servicedesk_links set enabled = true, auth_mode = 'authtoken', base_url = $2, token_sealed = $3 where tenant_id = $1`,
  [tenant, mock.url, seal(mock.key)]);

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

// ---------------------------------------------------------------- exit clearance, checklist
const sub = await raise('Employee Exit Clearance', 'EMP-2847',
  { 'Reason for leaving': 'Resignation', 'Resignation date': '2026-11-20', 'Last working day': '2026-12-20' });
const fin = (await one(`select id from public.approval_requests where submission_id = $1 and lane_label = 'Finance & Accounts'`, [sub])).id;
const task0 = await one(`select status from public.servicedesk_tasks where submission_id = $1`, [sub]);
ok('the IT track opening queued a ServiceDesk ticket', task0?.status === 'opening', JSON.stringify(task0));

await page.goto(`${BASE}/approvals?as=EMP-0312`);
await settle(3000);
const row = page.locator(`#approval-${fin}`);
await row.getByRole('button', { name: /^Approve$/ }).click();
await settle(2000);
let body = await text();
ok('approving with the checklist open is refused, and says why', /tick the checklist first: 4 items are still open/i.test(body), body.slice(0, 200));
ok('...and the row opens on the checklist', body.includes('Finance & Accounts') && body.includes('Unsettled bills'));
await shot('s9-approvals-checklist');
for (const item of ['Pending IOU or advance', 'Unsettled bills', 'Other payment or recovery', 'Other outstanding issue']) {
  await page.getByRole('button', { name: new RegExp(item) }).first().click();
  await settle(1200);
}
await row.getByRole('button', { name: /^Approve$/ }).click();
await settle(3000);
await page.goto('about:blank');
await settle(1500);
ok('ticked, Finance clears', (await one(`select status from public.approval_requests where id = $1`, [fin])).status === 'approved');
const task1 = await one(`select status, ticket_id from public.servicedesk_tasks where submission_id = $1`, [sub]);
const ticket = task1?.ticket_id ? mock.store.get(task1.ticket_id) : null;
ok('the clearance ticket was raised in ServiceDesk, as the leaver', task1?.status === 'open' && ticket?.subject?.startsWith('IT clearance: Tom Bexley (EMP-2847)')
  && ticket?.requester?.email_id === 'tom.bexley@example.com', JSON.stringify(task1) + ' ' + JSON.stringify(ticket?.subject));

// ---------------------------------------------------------------- the request page
await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
body = await text();
ok('the request page shows the clearance checklist, track by track', /Clearance checklist/i.test(body) && body.includes('Finance & Accounts') && body.includes('Cleared') && body.includes('Product & Technology'));
ok('...and the ticket raised for IT on its history', body.includes('IT clearance ticket raised in ServiceDesk Plus') && body.includes(`ServiceDesk #${task1?.ticket_id}`));
await shot('s9-status-checklist');

// ---------------------------------------------------------------- resolved in ServiceDesk
if (ticket) ticket.status = { name: 'Resolved' };
await page.goto(`${BASE}/admin/integrations?as=EMP-0445`);
await settle(3000);
await page.getByRole('tab', { name: 'ServiceDesk Plus' }).click();
await settle(2500);
await page.locator('button[name="fetch-servicedesk"]').click();
await settle(4000);
body = await text();
ok('the integrations tab lists the clearance ticket, cleared', /IT clearance for leavers/.test(body) && /Cleared/.test(body) && body.includes(`#${task1?.ticket_id}`));
await shot('s9-servicedesk-clearance');
await page.goto('about:blank');
await settle(1500);
const tech = await one(`select status, comment from public.approval_requests where submission_id = $1 and lane_label = 'Product & Technology'`, [sub]);
ok('resolved there, the IT track clears here', tech.status === 'approved' && /IT clearance completed in ServiceDesk/.test(tech.comment ?? ''), JSON.stringify(tech));
const ticks = await one(`select count(*)::int n from public.checklist_ticks k join public.checklist_items i on i.id = k.item_id
                          where k.submission_id = $1 and i.track = 'Product & Technology' and k.note like 'Cleared in ServiceDesk #%'`, [sub]);
ok('...its checklist ticked from the ticket', ticks.n === 1, JSON.stringify(ticks));

// ---------------------------------------------------------------- configuring checklists
await page.goto(`${BASE}/admin/checklists?as=EMP-0201`);
await settle(3000);
body = await text();
ok('the checklists page shows the exit clearance tracks', ['Own division', 'Finance & Accounts', 'Supply Chain', 'Administration', 'Product & Technology', 'Final settlement', 'Payroll settlement'].every((t) => body.includes(t)));
const scm = page.locator('[data-testid="checklist-tracks"] > section').filter({ hasText: 'Supply Chain' }).first();
await scm.getByRole('button', { name: /Add an item/ }).click();
await scm.locator('input').last().fill('Toolkit returned');
await scm.getByRole('button', { name: /^Save$/ }).click();
await settle(2500);
await shot('s9-checklists');
await page.goto('about:blank');
await settle(1500);
ok('an added item is saved, at the end', (await one(`select item from public.checklist_items i join public.form_templates t on t.id = i.form_template_id
  where i.tenant_id = $1 and t.name = 'Employee Exit Clearance' and i.track = 'Supply Chain' and i.active order by position desc limit 1`, [tenant]))?.item === 'Toolkit returned');

// ---------------------------------------------------------------- forwarding within the line
const fraud = await raise('Fraud Incident Fund Transfer', 'EMP-2847', { 'Amount': '5000', 'Incident reference': 'FR-1' });
const fstep = (await one(`select id from public.approval_requests where submission_id = $1 and status = 'pending'`, [fraud])).id;
await page.goto(`${BASE}/approvals?as=EMP-1134`);
await settle(3000);
await page.locator(`#approval-${fstep}`).getByRole('button', { name: /^Forward$/ }).click();
await settle(2000);
const options = await page.locator('[role="dialog"] select option').allInnerTexts();
body = await text();
ok('a fraud transfer forwards only within Sam\'s reporting line', options.some((o) => o.startsWith('Nadia Okonjo')) && !options.some((o) => o.startsWith('Nusrat Jahan'))
  && /forwards only within the reporting line/.test(body), options.join(' | '));
await shot('s9-forward-line');
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- the builder
await page.goto(`${BASE}/builder/approvers?templateId=${await formId('Fraud Incident Fund Transfer')}&as=EMP-0201`);
await settle(3500);
const within = page.getByRole('checkbox', { name: 'Forward only within the reporting line' });
ok('the builder shows the form forwards within the line', (await within.count()) === 1 && await within.isChecked());
ok('...and each stage approver can remind at an interval', (await page.getByLabel('Remind every so many hours').count()) >= 1);
await shot('s9-builder');
// SOW 2.1: "notification will be given after breach SLA or before SLA. It can be configured."
const fraudForm = await formId('Fraud Incident Fund Transfer');
await page.getByRole('button', { name: 'SLA timing' }).first().click();
await settle(400);
await page.getByLabel('Warn this many hours before the deadline').first().fill('6');
await page.getByLabel('Escalate this many working days after the deadline').first().fill('1');
await page.getByLabel('Escalation levels').first().selectOption('2');
await shot('s9-builder-sla');
await page.getByRole('button', { name: /Next/ }).click();
await settle(3000);
const slaRule = await one(`select warn_hours w, escalate_days d, escalate_levels l from public.approval_rules
  where form_template_id = $1 and warn_hours is not null`, [fraudForm]);
ok("a step's SLA timing (warn before, escalate after, how many levels) is set in the builder and saved",
  slaRule?.w === 6 && slaRule?.d === 1 && slaRule?.l === 2, JSON.stringify(slaRule));
await page.goto(`${BASE}/builder/approvers?templateId=${fraudForm}&as=EMP-0201`);
await settle(3500);
ok('...and shows again when the form is reopened',
  (await page.getByLabel('Warn this many hours before the deadline').first().inputValue()) === '6');

// ---------------------------------------------------------------- the SOW's forms, and Excel
await page.goto(`${BASE}/forms?as=EMP-2847`);
await settle(2500);
await page.getByPlaceholder(/Find a form/).fill('sim');
await settle(1200);
body = await text();
ok('the SIM forms are found by keyword', body.includes('New SIM Requisition') && body.includes('SIM Transfer'));
await page.goto(`${BASE}/submissions?as=EMP-2847`);
await settle(3000);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: /Export Excel/ }).click()]);
const { readFile: rf } = await import('node:fs/promises');
const bytes = await rf(await dl.path());
ok('My Submissions downloads as an Excel workbook', dl.suggestedFilename().endsWith('.xlsx') && bytes.subarray(0, 2).toString() === 'PK', dl.suggestedFilename());

// ---------------------------------------------------------------- the Open API: audit feed, draft edits
await page.goto('about:blank');
await settle(1200);
const { createHash: sha } = await import('node:crypto');
const kPrefix = 'e2e15sie', kSecret = 'Q'.repeat(40);
await db.query(`insert into public.api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by) values ($1, 'SIEM test', $2, $3, $4, 'EMP-0445')`,
  [tenant, kPrefix, sha('sha256').update(kSecret).digest('hex'), ['audit:read', 'requests:read', 'requests:write']]);
const KEY = `ams_${kPrefix}_${kSecret}`;
const api = async (method, path, payload) => {
  const r = await server.fetch(new Request(`${BASE}/api/v1/${path}`, {
    method, headers: { authorization: `Bearer ${KEY}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined }));
  return { status: r.status, text: await r.text(), next: r.headers.get('x-next-since') };
};
let ar = await api('GET', 'audit?limit=5');
let aj = {}; try { aj = JSON.parse(ar.text); } catch {}
ok('the audit feed gives a SIEM the trail, a page at a time', ar.status === 200 && aj.data?.length === 5 && !!aj.next?.since && !!aj.data[0].category, ar.text.slice(0, 200));
ar = await api('GET', 'audit?format=ndjson&limit=3');
ok('...or as one JSON object a line', ar.status === 200 && ar.text.trim().split('\n').length === 3 && !!ar.next, ar.text.slice(0, 120));
ar = await api('POST', 'requests', { form: 'Leave Application', on_behalf_of: 'EMP-2847', submit: false, answers: { 'Leave type': 'Annual' } });
const draftId = JSON.parse(ar.text).data?.id;
ar = await api('PATCH', `requests/${draftId}`, { on_behalf_of: 'EMP-2847', answers: { From: '2026-12-14', To: '2026-12-16', Reason: 'Family visit' }, priority: 'high' });
const edited = JSON.parse(ar.text).data;
ok('a draft is edited over the API, its answers and priority', ar.status === 200 && edited?.answers?.From === '2026-12-14' && edited?.answers?.['Leave type'] === 'Annual' && edited?.priority === 'high', ar.text.slice(0, 300));
ar = await api('PATCH', `requests/${draftId}`, { on_behalf_of: 'EMP-1134', answers: { Reason: 'x' } });
ok('...only by whoever raised it', ar.status === 403, ar.text.slice(0, 160));
ar = await api('PATCH', `requests/${draftId}`, { on_behalf_of: 'EMP-2847', submit: true });
ok('...and submitted when asked', ar.status === 200 && JSON.parse(ar.text).data?.status !== 'draft', ar.text.slice(0, 160));
ar = await api('PATCH', `requests/${draftId}`, { on_behalf_of: 'EMP-2847', answers: { Reason: 'late' } });
ok('...and not once it is submitted', ar.status === 409, ar.text.slice(0, 160));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await mock.close();
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL SOW-GAP WALK CHECKS PASSED');
process.exit(failures ? 1 : 0);
