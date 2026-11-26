// ================================================================ QA: approval chain and notifications (3 of 3)
// Delegation, the exceptional route, priority, parallel lanes, a quorum of
// compliance officers, and the daily round's reminders and escalation.
process.env.CRON_SECRET = 'qa-approvals-cron-secret-0123456789';
const TOM = 'EMP-2847', SAM = 'EMP-1134', NADIA = 'EMP-0201', KOFI = 'EMP-0831', LENA = 'EMP-0830', RAVI = 'EMP-0832',
  RAJ = 'EMP-0312', HANA = 'EMP-0800', MITU = 'EMP-0416', TANVIR = 'EMP-0411', PRIYA = 'EMP-0650';

const blank = async () => { await page.goto('about:blank'); await settle(800); };
const markReadDb = async (who) => {
  await blank();
  await db.query(`update public.notifications set read_at = now() where tenant_id = $1 and recipient_id = $2 and read_at is null`, [tenant, who]);
};
const notes = async (who, sub, kind) => rows(
  `select kind, title, body from public.notifications where tenant_id = $1 and recipient_id = $2 and entity_id = $3 ${kind ? 'and kind = $4' : ''} order by created_at`,
  kind ? [tenant, who, sub, kind] : [tenant, who, sub]);
const mails = async (who, sub, kind) => rows(
  `select kind, to_address, status from public.email_outbox where tenant_id = $1 and recipient_id = $2 and entity_id = $3 and kind = $4`, [tenant, who, sub, kind]);
const chain = async (sub) => rows(
  `select id, approver_user_id a, step_index s, lane l, lane_step ls, status, quorum q, stage_label stage, lane_label lane_label, deadline_at
     from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [sub]);
const statusOf = async (sub) => (await one(`select status from public.form_submissions where id = $1`, [sub])).status;
const refOf = async (sub) => (await one(`select ref_number from public.form_submissions where id = $1`, [sub])).ref_number;
const pendingOf = async (sub) => (await rows(`select approver_user_id a from public.approval_requests where submission_id = $1 and status = 'pending'`, [sub])).map((r) => r.a).sort();

async function bell(who) {
  await page.goto(`${BASE}/account?as=${who}`);
  await settle(3000);
  const btn = page.locator('button[aria-label^="Notifications"]').first();
  const label = (await btn.getAttribute('aria-label')) ?? '';
  const count = Number((label.match(/(\d+) unread/) ?? [])[1] ?? 0);
  await btn.click();
  await settle(900);
  const panel = page.getByRole('button', { name: 'Mark all read' }).locator('xpath=ancestor::div[2]');
  return { count, panelText: (await panel.count()) ? await panel.innerText() : '' };
}
async function raise(form, by, answers, { priority } = {}) {
  await blank();
  await db.query(`select set_config('app.tenant_id', $1, false), set_config('app.employee_id', $2, false)`, [tenant, by]);
  const f = await formId(form);
  const sub = (await one(`insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at, priority)
                          values ($1, $2, $3, 'submitted', now(), $4) returning id`, [tenant, f, by, priority ?? 'normal'])).id;
  for (const [k, v] of Object.entries(answers)) {
    await db.query(`insert into public.submission_values (tenant_id, submission_id, field_name, value) values ($1, $2, $3, $4)`, [tenant, sub, k, v]);
  }
  await db.query(`select public.build_approval_chain('form_submission', $1, $2)`, [sub, f]);
  await db.query(`select set_config('app.tenant_id', '', false), set_config('app.employee_id', '', false)`);
  return sub;
}
async function asPerson(who, sql, params) {
  await blank();
  await db.query(`select set_config('app.tenant_id', $1, false), set_config('app.employee_id', $2, false)`, [tenant, who]);
  let err = null;
  try { await db.query(sql, params); } catch (e) { err = String(e.message ?? e); }
  await db.query(`select set_config('app.tenant_id', '', false), set_config('app.employee_id', '', false)`);
  return err;
}
async function fillStep(answers) {
  for (const [label, v] of Object.entries(answers)) {
    const f = await field(label);
    if (!(await f.count()) || !(await f.isVisible().catch(() => false))) continue;
    const sel = f.locator('select');
    if (await sel.count()) { await sel.first().selectOption(v); continue; }
    const ta = f.locator('textarea');
    if (await ta.count()) { await ta.first().fill(v); continue; }
    await f.locator('input').first().fill(v);
  }
}
async function raiseUI(form, who, answers, { priority } = {}) {
  await page.goto(`${BASE}/forms/${await formId(form)}?as=${who}`);
  await settle(3000);
  for (let i = 0; i < 6; i++) {
    if (await page.getByRole('button', { name: /Confirm & Submit/ }).count()) break;
    await fillStep(answers);
    await page.getByRole('button', { name: /Next|Continue/ }).first().click().catch(() => {});
    await settle(1200);
  }
  if (priority) await page.locator('select[aria-label="Priority"]').selectOption(priority);
  await page.getByRole('button', { name: /Confirm & Submit/ }).click();
  await page.waitForURL(/\/status\//, { timeout: 20000 });
  await settle(2500);
  return page.url().split('/status/')[1].split('?')[0];
}
const leave = (reason) => ({ 'Leave type': 'Annual', From: '2026-12-14', To: '2026-12-16', Reason: reason });
const dhaka = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

await page.goto(`${BASE}/approvals?as=${SAM}`);  // flush the seeded overdue reminders
await settle(3000);

// ---------------------------------------------------------------- delegation
await page.goto(`${BASE}/approvals/delegate?as=${SAM}`);
await settle(3000);
await page.getByRole('button', { name: /New Delegation/ }).click();
await settle(600);
await page.getByPlaceholder('e.g. EMP-1200').fill(KOFI);
await page.getByRole('button', { name: /^Look up$/ }).click();
await settle(1500);
ok('the delegation form looks the delegate up by id', (await text()).includes('Kofi Mensah'));
await page.locator('input[type="date"]').nth(0).fill(dhaka(0));
await page.locator('input[type="date"]').nth(1).fill(dhaka(3));
await page.getByPlaceholder('e.g. Annual leave').fill('QA: away at a conference');
await page.getByRole('button', { name: /Save Delegation/ }).click();
await settle(2500);
let t = await text();
ok('saved, Sam sees his approvals are being handled by Kofi', /Active delegation/.test(t) && /handled by\s+Kofi Mensah/.test(t), t.slice(0, 400));
const del = await one(`select id, delegate_id, form_template_ids from public.delegation_rules where tenant_id = $1 and delegator_id = $2 and reason like 'QA:%'`, [tenant, SAM]);
ok('...and the delegation is stored, for every form', del?.delegate_id === KOFI && del?.form_template_ids == null, JSON.stringify(del));

await markReadDb(KOFI);
const dl = await raise('Leave Application', TOM, leave('QA delegation'));
const dlRef = await refOf(dl);
const dlStep = await stepOf(dl, SAM);
ok('the delegate is told a step is waiting for him', (await rows(`select 1 from public.notifications where tenant_id = $1 and recipient_id = $2 and entity_id = $3`, [tenant, KOFI, dl])).length >= 1,
  'Kofi has no notification for ' + dlRef);
await page.goto(`${BASE}/approvals?as=${KOFI}`);
await settle(3000);
const kRow = page.locator(`#approval-${dlStep}`);
ok('Kofi\'s queue shows Sam\'s step, marked as acting for Sam', (await kRow.count()) === 1 && /Acting for Sam Lindqvist/.test(await kRow.innerText()),
  (await kRow.count()) ? await kRow.innerText() : 'not in the queue');
await kRow.getByRole('button', { name: /^Approve$/ }).click();
await settle(2500);
ok('Kofi approves Sam\'s step', (await one(`select status from public.approval_requests where id = $1`, [dlStep])).status === 'approved');
ok('...the trail records Kofi as the one who acted', !!(await one(`select 1 x from public.approval_events where subject_id = $1 and action = 'approved' and actor_id = $2`, [dl, KOFI])));
ok('...and it moves on to HR', (await live(dl)) === NADIA);
await page.goto(`${BASE}/status/${dl}?as=${TOM}`);
await settle(3000);
t = await text();
ok('the history shows Kofi approved', /Kofi Mensah[\s\S]{0,80}approved/.test(t));
ok('...and says he acted for Sam', /Kofi Mensah[^\n]*(for|on behalf of|delegate of)[^\n]*Sam Lindqvist|Sam Lindqvist[^\n]*(delegated|by delegate|via)[^\n]*Kofi/i.test(t),
  (t.match(/[^\n]*Kofi Mensah[^\n]*/g) ?? []).join(' / ').slice(0, 300));

// Removed, it no longer carries Sam's steps.
await page.goto(`${BASE}/approvals/delegate?as=${SAM}`);
await settle(3000);
const delRow = page.locator('div', { hasText: 'Kofi Mensah' }).filter({ has: page.getByRole('button') }).last();
await delRow.getByRole('button').last().click();
await settle(2500);
ok('Sam removes the delegation', !(await one(`select 1 x from public.delegation_rules where id = $1`, [del.id])));
const dl2 = await raise('Leave Application', TOM, leave('QA after delegation'));
const kErr = await asPerson(KOFI, `select public.act_on_approval($1, 'approve', null, $2)`, [await stepOf(dl2, SAM), KOFI]);
ok('...after which Kofi cannot act on Sam\'s steps', /cannot act on this step/.test(kErr ?? ''), kErr);
await page.goto(`${BASE}/approvals?as=${KOFI}`);
await settle(3000);
ok('...nor sees them in his queue', (await page.locator(`#approval-${await stepOf(dl2, SAM)}`).count()) === 0);

// ---------------------------------------------------------------- the exceptional route, only when chosen
const camp = { 'Campaign name': 'QA Winter', Audience: 'Customer', Budget: '900000', 'Business case': 'QA', 'Business finance reviewer': TANVIR };
const regular = await raise('Campaign Request', MITU, { ...camp, 'Approval route': 'Regular' });
const exceptional = await raise('Campaign Request', MITU, { ...camp, 'Campaign name': 'QA Winter X', 'Approval route': 'Exceptional' });
const rc = await chain(regular), ec = await chain(exceptional);
ok('a regular campaign has no exceptional CXO step', !rc.some((r) => r.stage === 'Exceptional approval') && rc[0].a === TANVIR && rc[0].status === 'pending',
  JSON.stringify(rc.map((r) => [r.a, r.stage, r.status])));
ok('an exceptional one goes to the CXO first', ec[0].stage === 'Exceptional approval' && ec[0].a === HANA && ec[0].status === 'pending'
  && ec.some((r) => r.a === TANVIR && r.status === 'waiting'), JSON.stringify(ec.map((r) => [r.a, r.stage, r.status])));
ok('...is flagged Exceptional, and the regular one is not',
  (await one(`select flag from public.form_submissions where id = $1`, [exceptional])).flag === 'Exceptional'
  && (await one(`select flag from public.form_submissions where id = $1`, [regular])).flag == null);
ok('the CXO is told, and the notice says it is exceptional', (await notes(HANA, exceptional, 'approval.turn')).some((n) => n.body.includes('[Exceptional]'))
  && (await notes(HANA, regular, 'approval.turn')).length === 0);
await page.goto(`${BASE}/approvals?as=${HANA}`);
await settle(3000);
ok('...and her queue marks it Exceptional', /Exceptional/.test(await page.locator(`#approval-${await stepOf(exceptional, HANA)}`).innerText()));
await approveAs(HANA, exceptional);
ok('approved by the CXO, it carries on to the business finance reviewer', (await live(exceptional)) === TANVIR, await live(exceptional));

// ---------------------------------------------------------------- priority
const normal = await raise('Leave Application', TOM, leave('QA normal priority'));
const urgent = await raiseUI('Leave Application', TOM, leave('QA urgent priority'), { priority: 'urgent' });
const [nd, ud] = [(await chain(normal))[0], (await chain(urgent))[0]];
ok('an urgent request raised from the form is stored urgent', (await one(`select priority from public.form_submissions where id = $1`, [urgent])).priority === 'urgent');
ok('...and its first step is due sooner than a normal one\'s', new Date(ud.deadline_at) < new Date(nd.deadline_at),
  `urgent ${ud.deadline_at?.toISOString?.()} normal ${nd.deadline_at?.toISOString?.()}`);
await page.goto(`${BASE}/approvals?as=${SAM}`);
await settle(3000);
const uRow = await page.locator(`#approval-${ud.id}`).innerText();
ok('Sam\'s queue badges it Urgent', /Urgent/.test(uRow));
const ids = await page.locator('[id^="approval-"]').evaluateAll((els) => els.map((e) => e.id));
ok('...and lists it before the normal one', ids.indexOf(`approval-${ud.id}`) > -1 && ids.indexOf(`approval-${ud.id}`) < ids.indexOf(`approval-${nd.id}`), ids.join(' '));

// ---------------------------------------------------------------- parallel lanes: exit clearance
await markReadDb(RAJ);
const exit = await raise('Employee Exit Clearance', TOM, { 'Reason for leaving': 'Resignation', 'Resignation date': '2026-11-20', 'Last working day': '2026-12-20' });
const lanes = (await chain(exit)).filter((r) => r.s === 0);
const firstOfLane = await pendingOf(exit);
ok('an exit clearance opens every department\'s lane at once', firstOfLane.length === new Set(lanes.map((r) => r.l)).size && firstOfLane.length >= 5,
  JSON.stringify(firstOfLane));
ok('...each of them told', (await Promise.all(firstOfLane.map(async (p) => (await notes(p, exit, 'approval.turn')).length))).every((n) => n === 1));
ok('...while HR\'s final settlement waits', (await chain(exit)).find((r) => r.a === PRIYA && r.s === 1)?.status === 'waiting');
await approveAs(RAJ, exit);
ok('Finance clears its lane; the other lanes hear of it',
  (await notes('EMP-0445', exit, 'phase.lane_cleared')).some((n) => /Finance & Accounts/.test(n.title)), JSON.stringify(await notes('EMP-0445', exit)));
ok('...and the request is still in progress, HR not yet asked', (await statusOf(exit)) === 'in_progress' && !(await pendingOf(exit)).includes(PRIYA));
for (let i = 0; i < 12; i++) {
  const p = (await pendingOf(exit)).filter((x) => x !== PRIYA);
  if (!p.length) break;
  await approveAs(p[0], exit);
}
ok('only when every lane has cleared is HR asked', (await live(exit)) === PRIYA && (await notes(PRIYA, exit, 'approval.turn')).length === 1, await live(exit));

// ---------------------------------------------------------------- any two of three compliance officers
const gift = await raise('Gift & Hospitality Declaration', TOM, { 'Declaration type': 'Gift received', Counterparty: 'QA Vendor', 'Event date': '2026-11-20', Value: '10000' });
await approveAs(SAM, gift);
ok('after the line manager, all three compliance officers are asked', (await pendingOf(gift)).join(',') === [LENA, KOFI, RAVI].sort().join(','), JSON.stringify(await pendingOf(gift)));
await approveAs(LENA, gift);
ok('one officer is not enough', (await pendingOf(gift)).join(',') === [KOFI, RAVI].sort().join(','));
await approveAs(KOFI, gift);
const g = await chain(gift);
ok('two officers clear it; the third is no longer asked', g.find((r) => r.a === RAVI)?.status === 'skipped', JSON.stringify(g.map((r) => [r.a, r.status])));
ok('...and it moves on to Finance', (await live(gift)) === RAJ, await live(gift));

// ---------------------------------------------------------------- the daily round: due soon, overdue, escalation
const overdue = await raise('Leave Application', TOM, leave('QA overdue'));
const dueSoon = await raise('Leave Application', TOM, leave('QA due soon'));
const odRef = await refOf(overdue);
await blank();
await db.query(`update public.approval_requests set deadline_at = now() - interval '6 days' where id = $1`, [await stepOf(overdue, SAM)]);
await db.query(`update public.approval_requests set deadline_at = now() + interval '10 hours' where id = $1`, [await stepOf(dueSoon, SAM)]);
for (const p of [SAM, NADIA]) await markReadDb(p);
const refused = await server.fetch(new Request(BASE + '/cron/daily'));
ok('the daily round refuses a caller without the secret', refused.status === 401, String(refused.status));
let res = await server.fetch(new Request(BASE + '/cron/daily', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } }));
let round = {}; try { round = await res.json(); } catch {}
ok('the daily round runs', res.status === 200 && round.overdue >= 1 && round.dueSoon >= 1 && round.escalated >= 1, JSON.stringify(round));
ok('the approver holding an overdue step is reminded', (await notes(SAM, overdue, 'approval.overdue')).length === 1);
ok('...and reminded of one due within a day', (await notes(SAM, dueSoon, 'approval.due_soon')).length === 1);
ok('...the overdue one is escalated to his manager', (await notes(NADIA, overdue, 'approval.escalated')).some((n) => n.body.includes('Sam Lindqvist')));
ok('...and the escalation is on the trail', !!(await one(`select 1 x from public.approval_events where subject_id = $1 and action = 'escalated' and target_id = $2`, [overdue, NADIA])));
ok('...each with its email', (await mails(SAM, overdue, 'approval.overdue')).length === 1 && (await mails(NADIA, overdue, 'approval.escalated')).length === 1
  && (await mails(SAM, dueSoon, 'approval.due_soon')).length === 1);
ok('a step due next week is not reminded', (await notes(SAM, normal, 'approval.due_soon')).length === 0 && (await notes(SAM, normal, 'approval.overdue')).length === 0);
res = await server.fetch(new Request(BASE + '/cron/daily', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } }));
ok('run again the same day, nobody is told twice', res.status === 200 && (await notes(SAM, overdue, 'approval.overdue')).length === 1
  && (await notes(NADIA, overdue, 'approval.escalated')).length === 1 && (await notes(SAM, dueSoon, 'approval.due_soon')).length === 1);
let b = await bell(SAM);
ok('Sam\'s bell shows the overdue reminder', /Overdue:/.test(b.panelText) && b.panelText.includes(odRef), b.panelText.slice(0, 300));
b = await bell(NADIA);
ok('Nadia\'s bell shows the escalation', /Escalated:/.test(b.panelText) && b.panelText.includes(odRef), b.panelText.slice(0, 300));
await page.goto(`${BASE}/approvals?as=${SAM}`);
await settle(3000);
ok('Sam\'s queue marks the step Overdue', /Overdue/.test(await page.locator(`#approval-${await stepOf(overdue, SAM)}`).innerText()));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA APPROVALS (3) CHECKS PASSED');
process.exit(failures ? 1 : 0);
