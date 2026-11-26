// ================================================================ QA: approval chain and notifications (1 of 3)
// Money slabs, the board's any-two-of-three, parallel board lanes, the
// conditional CFO notification, CC, the bell, Mark all read, the email log.
const TOM = 'EMP-2847', SAM = 'EMP-1134', RAJ = 'EMP-0312', DANA = 'EMP-0600', ALEX = 'EMP-0700',
  HANA = 'EMP-0800', PRIYA = 'EMP-0650', MEI = 'EMP-3120', FARAH = 'EMP-0445';

const blank = async () => { await page.goto('about:blank'); await settle(800); };
const markReadDb = async (who) => {
  await blank();
  await db.query(`update public.notifications set read_at = now() where tenant_id = $1 and recipient_id = $2 and read_at is null`, [tenant, who]);
};
const unreadDb = async (who) => Number((await one(
  `select count(*)::int n from public.notifications where tenant_id = $1 and recipient_id = $2 and read_at is null`, [tenant, who])).n);
const notes = async (who, sub, kind) => rows(
  `select kind, title, body, read_at from public.notifications where tenant_id = $1 and recipient_id = $2 and entity_id = $3 ${kind ? 'and kind = $4' : ''} order by created_at`,
  kind ? [tenant, who, sub, kind] : [tenant, who, sub]);
const mails = async (who, sub, kind) => rows(
  `select kind, to_address, status from public.email_outbox where tenant_id = $1 and recipient_id = $2 and entity_id = $3 and kind = $4`, [tenant, who, sub, kind]);
const chain = async (sub) => rows(
  `select approver_user_id a, step_index s, lane l, lane_step ls, status, quorum q, stage_label stage
     from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [sub]);
const statusOf = async (sub) => (await one(`select status from public.form_submissions where id = $1`, [sub])).status;
const refOf = async (sub) => (await one(`select ref_number from public.form_submissions where id = $1`, [sub])).ref_number;

// The bell, as somebody sees it on an ordinary page: its count and the panel's text.
async function bell(who) {
  await page.goto(`${BASE}/account?as=${who}`);
  await settle(3000);
  const btn = page.locator('button[aria-label^="Notifications"]').first();
  const label = (await btn.getAttribute('aria-label')) ?? '';
  const count = Number((label.match(/(\d+) unread/) ?? [])[1] ?? 0);
  await btn.click();
  await settle(900);
  const panel = page.getByRole('button', { name: 'Mark all read' }).locator('xpath=ancestor::div[2]');
  const panelText = (await panel.count()) ? await panel.innerText() : '';
  return { count, panelText };
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
// Raise a request through the form, as somebody; returns the new submission's id.
async function raiseUI(form, who, answers, { priority, cc } = {}) {
  await page.goto(`${BASE}/forms/${await formId(form)}?as=${who}`);
  await settle(3000);
  for (let i = 0; i < 6; i++) {
    if (await page.getByRole('button', { name: /Confirm & Submit/ }).count()) break;
    await fillStep(answers);
    await page.getByRole('button', { name: /Next|Continue/ }).first().click().catch(() => {});
    await settle(1200);
  }
  if (priority) await page.locator('select[aria-label="Priority"]').selectOption(priority);
  for (const c of cc ?? []) { await page.locator('select[aria-label="Copy somebody"]').selectOption(c); await settle(200); }
  await page.getByRole('button', { name: /Confirm & Submit/ }).click();
  await page.waitForURL(/\/status\//, { timeout: 20000 });
  await settle(2500);
  return page.url().split('/status/')[1].split('?')[0];
}

// Visiting a queue sends any overdue reminders the seeded history is owed;
// get that out of the way so later counts are about what this walk does.
await page.goto(`${BASE}/approvals?as=${SAM}`);
await settle(3000);

// ---------------------------------------------------------------- a small capital expenditure, through the form
for (const p of [SAM, RAJ, TOM, MEI, ALEX]) await markReadDb(p);
const small = await raiseUI('Capital Expenditure Request', TOM,
  { Project: 'QA small capex: meeting room screens', Classification: 'Budgetary', Amount: '400000', Justification: 'Replace the two failed displays.' },
  { cc: [MEI] });
const smallRef = await refOf(small);
let c = await chain(small);
ok('a 400,000 capex routes to the line manager then the Finance Controller only',
  c.map((r) => r.a).join(',') === `${SAM},${RAJ}` && c[0].status === 'pending' && c[1].status === 'waiting', JSON.stringify(c));
ok('...and is in progress, with Mei copied', (await statusOf(small)) === 'in_progress'
  && !!(await one(`select 1 x from public.submission_cc where submission_id = $1 and employee_id = $2`, [small, MEI])));
let t = await text();
ok('the status page shows the new request in progress', t.includes(smallRef) && /In Progress/i.test(t), t.slice(0, 200));

let b = await bell(SAM);
ok('Sam\'s bell counts the new approval', b.count >= 1 && b.count === Math.min(10, await unreadDb(SAM)), `badge ${b.count}, db ${await unreadDb(SAM)}`);
ok('...and its panel names the request and asks for his approval', b.panelText.includes(smallRef) && /Your approval is needed/.test(b.panelText), b.panelText.slice(0, 300));
ok('Raj (second in line) is not told yet', (await notes(RAJ, small)).length === 0);
ok('an email is queued for Sam\'s turn', (await mails(SAM, small, 'approval.turn')).some((m) => m.to_address === 'sam.lindqvist@example.com'),
  JSON.stringify(await mails(SAM, small, 'approval.turn')));
ok('Mei, copied, is told it was raised', (await notes(MEI, small, 'cc.raised')).length === 1);
ok('...and emailed', (await mails(MEI, small, 'cc.raised')).length === 1);
b = await bell(MEI);
ok('...her bell shows it', b.count >= 1 && b.panelText.includes(smallRef) && /copied/i.test(b.panelText), b.panelText.slice(0, 300));

// The queue: the line manager approves.
await page.goto(`${BASE}/approvals?as=${SAM}`);
await settle(3000);
const samRow = page.locator(`#approval-${await stepOf(small, SAM)}`);
ok('Sam\'s queue lists it with its reference and requester', (await samRow.count()) === 1
  && (await samRow.innerText()).includes(smallRef) && (await samRow.innerText()).includes('Tom Bexley'));
await markReadDb(RAJ);
await approveAs(SAM, small);
c = await chain(small);
ok('approved, Sam\'s step is done and Raj\'s opens', c[0].status === 'approved' && c[1].status === 'pending', JSON.stringify(c));
ok('...the trail records who approved', !!(await one(`select 1 x from public.approval_events where subject_id = $1 and action = 'approved' and actor_id = $2`, [small, SAM])));
await page.goto(`${BASE}/approvals?as=${SAM}`);
await settle(3000);
ok('...and it has left Sam\'s queue', (await page.locator(`#approval-${await stepOf(small, SAM)}`).count()) === 0);
b = await bell(RAJ);
ok('Raj\'s bell now shows it is his turn', b.count >= 1 && b.panelText.includes(smallRef) && /Your approval is needed/.test(b.panelText), b.panelText.slice(0, 300));
ok('...and an email is queued for Raj', (await mails(RAJ, small, 'approval.turn')).some((m) => m.to_address === 'raj.patel@example.com'));

await markReadDb(TOM);
await approveAs(RAJ, small);
ok('Raj approves: the request is complete', (await statusOf(small)) === 'completed');
ok('the requester is told it is fully approved', (await notes(TOM, small, 'request.completed')).length === 1);
ok('...by email too', (await mails(TOM, small, 'request.completed')).some((m) => m.to_address === 'tom.bexley@example.com'));
b = await bell(TOM);
ok('Tom\'s bell says so, naming the request', b.count >= 1 && /Fully approved/.test(b.panelText) && b.panelText.includes(smallRef), b.panelText.slice(0, 300));
ok('Mei, copied, is told it was approved', (await notes(MEI, small, 'cc.completed')).length === 1 && (await mails(MEI, small, 'cc.completed')).length === 1);
ok('below 1,000,000 the CFO is not told of the approval', (await notes(ALEX, small)).length === 0, JSON.stringify(await notes(ALEX, small)));
await page.goto(`${BASE}/status/${small}?as=${TOM}`);
await settle(3000);
t = await text();
ok('the status page shows it complete', /All approvals complete/.test(t) && /Completed/i.test(t));
ok('...and the history names both approvers', /Sam Lindqvist[\s\S]*approved/.test(t) && /Raj Patel[\s\S]*approved/.test(t));

// ---------------------------------------------------------------- a large one: more of the finance ladder, then the board
await markReadDb(ALEX);
const large = await raiseUI('Capital Expenditure Request', TOM,
  { Project: 'QA large capex: data centre', Classification: 'Budgetary', Amount: '6000000', Justification: 'Second site for resilience.' });
const largeRef = await refOf(large);
c = await chain(large);
const board = c.filter((r) => r.stage === 'Board approval');
ok('a 6,000,000 capex climbs the finance ladder: Controller, Head of Finance, CFO',
  [SAM, RAJ, DANA, ALEX].every((p) => c.some((r) => r.a === p && r.stage !== 'Board approval')), JSON.stringify(c));
ok('...then the board: three members, any two', board.length === 3 && board.every((r) => r.q === 2)
  && [ALEX, HANA, PRIYA].every((p) => board.some((r) => r.a === p)) && new Set(board.map((r) => r.s)).size === 1, JSON.stringify(board));
ok('the small and the large route to different approvers', c.some((r) => r.a === DANA) && !(await chain(small)).some((r) => r.a === DANA));

for (let i = 0; i < 6; i++) {
  const p = await rows(`select approver_user_id, stage_label from public.approval_requests where submission_id = $1 and status = 'pending'`, [large]);
  if (p.length !== 1 || p[0].stage_label === 'Board approval') break;
  await approveAs(p[0].approver_user_id, large);
}
const boardLive = await rows(`select approver_user_id a from public.approval_requests where submission_id = $1 and status = 'pending' order by lane`, [large]);
ok('after the finance ladder, all three board members are asked at once', boardLive.map((r) => r.a).sort().join(',') === [ALEX, HANA, PRIYA].sort().join(','), JSON.stringify(boardLive));
ok('...each told it is their turn', (await notes(HANA, large, 'approval.turn')).length === 1 && (await notes(PRIYA, large, 'approval.turn')).length === 1);
await page.goto(`${BASE}/approvals?as=${HANA}`);
await settle(3000);
ok('the COO\'s queue shows the board step', (await page.locator(`#approval-${await stepOf(large, HANA)}`).count()) === 1);
await approveAs(HANA, large);
ok('one board approval is not enough', (await statusOf(large)) === 'in_progress'
  && (await live(large)).split(',').sort().join(',') === [ALEX, PRIYA].sort().join(','), await live(large));
ok('...the other board members hear it was cleared', (await notes(PRIYA, large, 'phase.lane_cleared')).length === 1, JSON.stringify(await notes(PRIYA, large)));
await approveAs(PRIYA, large);
ok('two of three board members complete it', (await statusOf(large)) === 'completed');
const third = await one(`select status from public.approval_requests where submission_id = $1 and stage_label = 'Board approval' and approver_user_id = $2`, [large, ALEX]);
ok('...and the third board member is no longer asked', third?.status === 'skipped', JSON.stringify(third));
await page.goto(`${BASE}/approvals?as=${ALEX}`);
await settle(3000);
ok('...nor shown it in the CFO\'s queue', !(await page.locator('[id^="approval-"]').allInnerTexts()).some((x) => x.includes(largeRef)));

// The rule: Capital Expenditure Request above 1,000,000 approved → the CFO is told.
ok('above 1,000,000 the CFO is told it was approved', (await notes(ALEX, large, 'watch.approved')).length === 1, JSON.stringify(await notes(ALEX, large)));
ok('...by email as well', (await mails(ALEX, large, 'watch.approved')).some((m) => m.to_address === 'alex.mercer@example.com'));
b = await bell(ALEX);
ok('...and the CFO\'s bell names it', /A request you watch was approved/.test(b.panelText) && b.panelText.includes(largeRef), b.panelText.slice(0, 400));

// ---------------------------------------------------------------- the email log
await page.goto(`${BASE}/admin/email?as=${FARAH}`);
await settle(3500);
const log = page.locator('[data-testid="email-log"]');
ok('the email log lists approval-turn emails', (await log.locator('[data-email-kind="approval.turn"]').count()) > 0);
ok('...the requester\'s completion email', (await log.locator('[data-email-kind="request.completed"]').count()) > 0);
ok('...and the CFO\'s watch email', (await log.locator('[data-email-kind="watch.approved"]').count()) > 0);
await page.locator('input[aria-label="Search emails"]').fill('Alex Mercer');
await settle(2500);
ok('searching the log by person finds the CFO\'s email', /Alex Mercer|alex\.mercer@example\.com/.test(await log.innerText()), (await log.innerText()).slice(0, 300));
await shot('qa-approvals-email-log');

// ---------------------------------------------------------------- Mark all read
b = await bell(TOM);
ok('Tom has unread notifications before marking', b.count > 0, String(b.count));
// The bell's own claim about email, beside the email log that says every notification is also an email.
ok('the bell panel does not say nothing is emailed while every notification is queued as an email',
  !/nothing is emailed/i.test(b.panelText), b.panelText.slice(-120));
await page.getByRole('button', { name: 'Mark all read' }).click();
await settle(2000);
await page.reload();
await settle(3000);
const after = (await page.locator('button[aria-label^="Notifications"]').first().getAttribute('aria-label')) ?? '';
ok('Mark all read clears the badge', !/unread/.test(after), after);
ok('...and the database agrees', (await unreadDb(TOM)) === 0, String(await unreadDb(TOM)));

// More than ten unread: does the badge count them all, and does Mark all read clear them all?
await blank();
for (let i = 0; i < 13; i++) {
  await db.query(`insert into public.notifications (tenant_id, recipient_id, kind, title, body) values ($1, 'EMP-9001', 'qa.bulk', $2, 'bulk')`, [tenant, `QA bulk notice ${i + 1}`]);
}
b = await bell('EMP-9001');
const ivanUnread = await unreadDb('EMP-9001');
ok(`with ${ivanUnread} unread the badge shows them all`, b.count === ivanUnread, `badge ${b.count}, unread ${ivanUnread}`);
await page.getByRole('button', { name: 'Mark all read' }).click();
await settle(2000);
ok('...and Mark all read leaves none unread', (await unreadDb('EMP-9001')) === 0, `${await unreadDb('EMP-9001')} still unread`);

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA APPROVALS (1) CHECKS PASSED');
process.exit(failures ? 1 : 0);
