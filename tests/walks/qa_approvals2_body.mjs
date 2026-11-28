// ================================================================ QA: approval chain and notifications (2 of 3)
// The approver's actions from the queue: reject, clarify, ask, return,
// forward (and forwarding kept within the line), add a reviewer; the
// requester's take back and cancel.
const TOM = 'EMP-2847', SAM = 'EMP-1134', NADIA = 'EMP-0201', MEI = 'EMP-3120', IVAN = 'EMP-9001', NUSRAT = 'EMP-0410';

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
  `select id, approver_user_id a, step_index s, lane l, lane_step ls, status, reassigned_from
     from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [sub]);
const statusOf = async (sub) => (await one(`select status from public.form_submissions where id = $1`, [sub])).status;
const refOf = async (sub) => (await one(`select ref_number from public.form_submissions where id = $1`, [sub])).ref_number;
const events = async (sub) => rows(`select action, actor_id, target_id, comment from public.approval_events where subject_id = $1 order by created_at, id`, [sub]);

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

// A request raised directly (the precondition, not the feature under test).
async function raise(form, by, answers, { cc = [], priority } = {}) {
  await blank();
  await db.query(`select set_config('app.tenant_id', $1, false), set_config('app.employee_id', $2, false)`, [tenant, by]);
  const f = await formId(form);
  const sub = (await one(`insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at, priority)
                          values ($1, $2, $3, 'submitted', now(), $4) returning id`, [tenant, f, by, priority ?? 'normal'])).id;
  for (const [k, v] of Object.entries(answers)) {
    await db.query(`insert into public.submission_values (tenant_id, submission_id, field_name, value) values ($1, $2, $3, $4)`, [tenant, sub, k, v]);
  }
  for (const p of cc) await db.query(`insert into public.submission_cc (tenant_id, submission_id, employee_id, added_by) values ($1, $2, $3, $4)`, [tenant, sub, p, by]);
  await db.query(`select public.build_approval_chain('form_submission', $1, $2)`, [sub, f]);
  await db.query(`select set_config('app.tenant_id', '', false), set_config('app.employee_id', '', false)`);
  return sub;
}
// Call a database function as somebody; the error message, or null.
async function asPerson(who, sql, params) {
  await blank();
  await db.query(`select set_config('app.tenant_id', $1, false), set_config('app.employee_id', $2, false)`, [tenant, who]);
  let err = null;
  try { await db.query(sql, params); } catch (e) { err = String(e.message ?? e); }
  await db.query(`select set_config('app.tenant_id', '', false), set_config('app.employee_id', '', false)`);
  return err;
}
const leave = (reason) => ({ 'Leave type': 'Annual', From: '2026-12-14', To: '2026-12-16', Reason: reason });

// Open somebody's queue on one step, and press one of its buttons.
async function openAction(who, sub, button) {
  await page.goto(`${BASE}/approvals?as=${who}`);
  await settle(3000);
  const row = page.locator(`#approval-${await stepOf(sub, who)}`);
  await row.getByRole('button', { name: new RegExp(`^${button}$`) }).click();
  await settle(1200);
  return page.getByRole('dialog');
}

await page.goto(`${BASE}/approvals?as=${SAM}`);  // flush the seeded overdue reminders
await settle(3000);

// ---------------------------------------------------------------- reject: a reason is required
const rej = await raise('Leave Application', TOM, leave('QA reject'), { cc: [MEI] });
const rejRef = await refOf(rej);
await markReadDb(TOM);
let dlg = await openAction(SAM, rej, 'Reject');
ok('Reject opens a dialog asking for the reason', /Reason for rejection/.test(await dlg.innerText()));
await dlg.getByRole('button', { name: 'Confirm' }).click();
await settle(1200);
ok('rejecting without a reason is refused, and says so', /Please provide a reason/.test(await text()));
ok('...and the step is still open', (await one(`select status from public.approval_requests where id = $1`, [await stepOf(rej, SAM)])).status === 'pending');
await dlg.locator('textarea').fill('Peak season: no leave in mid-December.');
await dlg.getByRole('button', { name: 'Confirm' }).click();
await settle(2500);
let c = await chain(rej);
ok('with a reason, the request is rejected', (await statusOf(rej)) === 'rejected' && c[0].status === 'rejected', JSON.stringify(c));
ok('...the HR step after it is never asked', c[1].status === 'skipped' && (await notes(NADIA, rej, 'approval.turn')).length === 0);
ok('...the reason is kept on the step and the trail',
  (await one(`select comment from public.approval_requests where id = $1`, [c[0].id])).comment === 'Peak season: no leave in mid-December.'
  && (await events(rej)).some((e) => e.action === 'rejected' && e.actor_id === SAM));
const rn = await notes(TOM, rej, 'request.rejected');
ok('the requester is told, with the reason', rn.length === 1 && rn[0].body.includes('Peak season'), JSON.stringify(rn));
ok('...by email too', (await mails(TOM, rej, 'request.rejected')).some((m) => m.to_address === 'tom.bexley@example.com'));
let b = await bell(TOM);
ok('Tom\'s bell shows the rejection and why', /Rejected/.test(b.panelText) && b.panelText.includes(rejRef) && b.panelText.includes('Peak season'), b.panelText.slice(0, 300));
ok('Mei, copied, is told it was rejected', (await notes(MEI, rej, 'cc.rejected')).length === 1 && (await mails(MEI, rej, 'cc.rejected')).length === 1);
await page.goto(`${BASE}/status/${rej}?as=${TOM}`);
await settle(3000);
let t = await text();
ok('the status page shows it rejected, with the reason', /Rejected/.test(t) && t.includes('Peak season'));

// ---------------------------------------------------------------- clarify: back to the requester, answered, resumed
const cl = await raise('Leave Application', TOM, leave('QA clarify'));
const clRef = await refOf(cl);
await markReadDb(TOM);
dlg = await openAction(SAM, cl, 'Clarify');
await dlg.locator('textarea').fill('Who covers the month-end report while you are away?');
await dlg.getByRole('button', { name: 'Confirm' }).click();
await settle(2500);
ok('Clarify puts the step and the request on hold', (await one(`select status from public.approval_requests where id = $1`, [await stepOf(cl, SAM)])).status === 'clarification'
  && (await statusOf(cl)) === 'on_hold');
const cn = await notes(TOM, cl, 'request.clarification');
ok('the requester is told what is needed', cn.length === 1 && cn[0].body.includes('month-end report'), JSON.stringify(cn));
b = await bell(TOM);
ok('...on his bell', /Clarification needed/.test(b.panelText) && b.panelText.includes(clRef), b.panelText.slice(0, 300));
ok('...and by email', (await mails(TOM, cl, 'request.clarification')).length === 1);
await markReadDb(SAM);
await page.goto(`${BASE}/status/${cl}?as=${TOM}`);
await settle(3000);
t = await text();
ok('the requester\'s status page shows the question and that it is on hold', t.includes('month-end report') && /On Hold/i.test(t), t.slice(0, 300));
await page.locator('input[aria-label="New note"]').fill('Mei Sun covers the month-end report; handover is booked.');
await page.getByRole('button', { name: /^Add note$/ }).click();
await settle(2500);
ok('the requester answers with a note, and the approver is told', (await notes(SAM, cl, 'note.added')).some((n) => n.body.includes('Mei Sun covers')));
await page.goto(`${BASE}/approvals?as=${SAM}`);
await settle(3000);
let row = page.locator(`#approval-${await stepOf(cl, SAM)}`);
t = await row.innerText();
ok('Sam\'s queue shows it awaiting clarification, with Resume and no Approve', /Awaiting clarification/.test(t)
  && (await row.getByRole('button', { name: /^Resume$/ }).count()) === 1 && (await row.getByRole('button', { name: /^Approve$/ }).count()) === 0, t.slice(0, 200));
await row.getByRole('button', { name: /^Resume$/ }).click();
await settle(2500);
ok('Resume puts it back to Sam, and the request back in progress',
  (await one(`select status from public.approval_requests where id = $1`, [await stepOf(cl, SAM)])).status === 'pending' && (await statusOf(cl)) === 'in_progress');
await approveAs(SAM, cl);
ok('...and it carries on to HR when approved', (await live(cl)) === NADIA, await live(cl));
ok('the trail reads clarification, resumed, approved', (await events(cl)).map((e) => e.action).filter((a) => ['clarification', 'resumed', 'approved'].includes(a)).join(',') === 'clarification,resumed,approved',
  JSON.stringify((await events(cl)).map((e) => e.action)));

// ---------------------------------------------------------------- ask another approver
const ask = await raise('Leave Application', TOM, leave('QA ask'));
const askRef = await refOf(ask);
await markReadDb(NADIA);
dlg = await openAction(SAM, ask, 'Ask');
const askOpts = await dlg.locator('select option').allInnerTexts();
ok('Ask offers the request\'s other approvers', askOpts.some((o) => o.includes('Nadia Okonjo')) && !askOpts.some((o) => o.includes('Sam Lindqvist')), askOpts.join(' | '));
await dlg.locator('select').selectOption(NADIA);
await dlg.locator('textarea').fill('Does Tom have enough annual leave left for this?');
await dlg.getByRole('button', { name: 'Confirm' }).click();
await settle(2500);
const q = await one(`select id, asked_by, asked_to, answer from public.approval_queries where subject_id = $1`, [ask]);
ok('the question is recorded, from Sam to Nadia', q?.asked_by === SAM && q?.asked_to === NADIA && q?.answer == null, JSON.stringify(q));
ok('...and the request does not wait: Sam\'s step stays open', (await one(`select status from public.approval_requests where id = $1`, [await stepOf(ask, SAM)])).status === 'pending');
b = await bell(NADIA);
ok('Nadia\'s bell has the question', /A question for you/.test(b.panelText) && b.panelText.includes('enough annual leave'), b.panelText.slice(0, 300));
ok('...and an email is queued for it', (await mails(NADIA, ask, 'question.asked')).length === 1);
await markReadDb(SAM);
await page.goto(`${BASE}/approvals?as=${NADIA}`);
await settle(3000);
t = await text();
ok('Nadia\'s queue shows the question for her', /Questions for you from other approvers/.test(t) && t.includes('enough annual leave'));
const qPanel = page.getByText('Questions for you from other approvers', { exact: true }).locator('xpath=..');
const qText = await qPanel.innerText();
ok('...naming the request by the reference everyone else sees', qText.includes(askRef), `looked for ${askRef} in: ${qText.slice(0, 200)}`);
await qPanel.getByPlaceholder('Your answer').first().fill('Yes, 12 days remain.');
await qPanel.getByRole('button', { name: /^Answer$/ }).first().click();
await settle(2500);
ok('Nadia answers from her queue', (await one(`select answer from public.approval_queries where id = $1`, [q.id])).answer === 'Yes, 12 days remain.');
ok('...and Sam is told the answer', (await notes(SAM, ask, 'question.answered')).some((n) => n.body.includes('12 days remain')));
await page.goto(`${BASE}/status/${ask}?as=${TOM}`);
await settle(3000);
t = await text();
ok('the request page shows the question and its answer', /Questions between approvers/i.test(t) && t.includes('enough annual leave') && t.includes('12 days remain'));

// ---------------------------------------------------------------- return to an earlier approver
await approveAs(SAM, ask);
ok('approved by Sam, it is with Nadia', (await live(ask)) === NADIA);
await markReadDb(SAM);
dlg = await openAction(NADIA, ask, 'Return');
const retOpts = await dlg.locator('select option').allInnerTexts();
ok('Return offers whoever already approved', retOpts.some((o) => o.includes('Sam Lindqvist')), retOpts.join(' | '));
await dlg.locator('select').selectOption({ label: 'Sam Lindqvist' });
await dlg.locator('textarea').fill('Please confirm the cover arrangement in writing.');
await dlg.getByRole('button', { name: 'Confirm' }).click();
await settle(2500);
c = await chain(ask);
ok('returned: Sam\'s step is open again and Nadia\'s waits behind it', c[0].status === 'pending' && c[1].status === 'waiting', JSON.stringify(c.map((r) => [r.a, r.status])));
ok('...the trail records the return to Sam', (await events(ask)).some((e) => e.action === 'returned' && e.actor_id === NADIA && e.target_id === SAM));
const retN = await notes(SAM, ask, 'approval.returned');
ok('Sam is told it came back, and why', retN.length === 1 && retN[0].body.includes('cover arrangement'), JSON.stringify(retN));
b = await bell(SAM);
ok('...on his bell', /Returned to you/.test(b.panelText) && b.panelText.includes(askRef), b.panelText.slice(0, 300));
await approveAs(SAM, ask);
ok('Sam approves again and it goes back to Nadia', (await live(ask)) === NADIA);
await approveAs(NADIA, ask);
ok('...who approves it to completion', (await statusOf(ask)) === 'completed');

// ---------------------------------------------------------------- forward
const fw = await raise('Leave Application', TOM, leave('QA forward'));
await markReadDb(IVAN);
dlg = await openAction(SAM, fw, 'Forward');
ok('an ordinary form forwards to anybody', /keeps its place in the chain/.test(await dlg.innerText())
  && (await dlg.locator('select option').allInnerTexts()).some((o) => o.startsWith('Nusrat Jahan')));
await dlg.locator('select').selectOption(IVAN);
await dlg.locator('textarea').fill('Ivan is covering my approvals this week.');
await dlg.getByRole('button', { name: 'Confirm' }).click();
await settle(2500);
const fstep = await one(`select approver_user_id, reassigned_from, status, step_index from public.approval_requests where submission_id = $1 order by step_index limit 1`, [fw]);
ok('forwarded: the step is Ivan\'s now, keeping its place', fstep.approver_user_id === IVAN && fstep.reassigned_from === SAM && fstep.status === 'pending' && fstep.step_index === 0, JSON.stringify(fstep));
ok('...Ivan is told', (await notes(IVAN, fw, 'approval.turn')).some((n) => /forwarded/.test(n.title)));
await page.goto(`${BASE}/approvals?as=${IVAN}`);
await settle(3000);
ok("...and Ivan's card says it was forwarded from Sam, with Sam's note",
  /Forwarded from Sam Lindqvist/.test(await text()) && (await text()).includes('Ivan is covering my approvals this week.'), (await text()).slice(0, 500));
await page.goto(`${BASE}/approvals?as=${SAM}`);
await settle(3000);
ok('...it has left Sam\'s queue', !(await text()).includes(await refOf(fw)));
await approveAs(IVAN, fw);
ok('Ivan approves it from his queue and it moves on to HR', (await live(fw)) === NADIA, await live(fw));
await page.goto(`${BASE}/status/${fw}?as=${TOM}`);
await settle(3000);
ok('the history says Sam forwarded to Ivan', /forwarded their step to Ivan Petrov/.test(await text()));

// A fraud transfer forwards only within the reporting line.
const fraud = await raise('Fraud Incident Fund Transfer', TOM, { Amount: '5000', 'Incident reference': 'QA-FR-1' });
dlg = await openAction(SAM, fraud, 'Forward');
const fOpts = await dlg.locator('select option').allInnerTexts();
ok('a fraud transfer\'s forward list is Sam\'s reporting line only', fOpts.some((o) => o.startsWith('Nadia Okonjo')) && fOpts.some((o) => o.startsWith('Mei Sun'))
  && !fOpts.some((o) => o.startsWith('Nusrat Jahan')) && /forwards only within the reporting line/.test(await dlg.innerText()), fOpts.join(' | '));
await page.keyboard.press('Escape');
const refused = await asPerson(SAM, `select public.reassign_approval($1, $2, null, $3)`, [await stepOf(fraud, SAM), NUSRAT, SAM]);
ok('...and forwarding it outside the line is refused by the database', /forwards only within the reporting line/.test(refused ?? ''), refused);
ok('...leaving it with Sam', (await live(fraud)) === SAM);

// ---------------------------------------------------------------- add a reviewer
const rv = await raise('Leave Application', TOM, leave('QA reviewer'));
await markReadDb(MEI);
dlg = await openAction(SAM, rv, 'Add reviewer');
await dlg.locator('select').selectOption(MEI);
await dlg.getByRole('button', { name: 'Confirm' }).click();
await settle(2500);
c = await chain(rv);
ok('the reviewer is asked first, Sam\'s step waits behind them',
  c[0].a === MEI && c[0].status === 'pending' && c[1].a === SAM && c[1].status === 'waiting' && c[0].s === c[1].s, JSON.stringify(c.map((r) => [r.a, r.status, r.ls])));
ok('Mei is told her review is wanted', (await notes(MEI, rv, 'approval.review')).length === 1);
b = await bell(MEI);
ok('...on her bell', /Your review is requested/.test(b.panelText), b.panelText.slice(0, 300));
await page.goto(`${BASE}/status/${rv}?as=${MEI}`);
await settle(3000);
await page.locator('input[aria-label="New note"]').fill('Reviewed: cover is arranged, no objection.');
await page.getByRole('button', { name: /^Add note$/ }).click();
await settle(2000);
await markReadDb(SAM);
await approveAs(MEI, rv);
ok('the reviewer passes it on and it is back with Sam', (await live(rv)) === SAM);
ok('...who is told it is his turn again', (await notes(SAM, rv, 'approval.turn')).length >= 1);
ok('...and sees the reviewer\'s remark first', (await notes(SAM, rv, 'note.added')).some((n) => n.body.includes('no objection')));
await approveAs(SAM, rv);
const order = (await events(rv)).filter((e) => e.action === 'approved').map((e) => e.actor_id).join(',');
ok('the trail has the reviewer before the approver', order === `${MEI},${SAM}`, order);
ok('...and it moves on to HR', (await live(rv)) === NADIA);

// ---------------------------------------------------------------- the requester takes it back, and cancels
const tb = await raise('Leave Application', TOM, leave('QA take back'));
await markReadDb(SAM);
await page.goto(`${BASE}/status/${tb}?as=${TOM}`);
await settle(3000);
ok('before anybody approves, the requester is offered Take back and Cancel',
  (await page.getByRole('button', { name: /Take back to edit/ }).count()) === 1 && (await page.getByRole('button', { name: /Cancel request/ }).count()) === 1);
await page.getByRole('button', { name: /Take back to edit/ }).click();
await page.waitForURL(/\/forms\//, { timeout: 15000 }).catch(() => {});
await settle(3000);
ok('taken back, it is a draft again, its chain removed', (await statusOf(tb)) === 'draft'
  && Number((await one(`select count(*)::int n from public.approval_requests where submission_id = $1`, [tb])).n) === 0);
ok('...and Sam is told there is nothing for him to do', (await notes(SAM, tb, 'request.recalled')).length === 1);
ok('...the form opens on the draft', page.url().includes(`draft=${tb}`), page.url());
for (let i = 0; i < 6; i++) {
  if (await page.getByRole('button', { name: /Confirm & Submit/ }).count()) break;
  await page.getByRole('button', { name: /Next|Continue/ }).first().click().catch(() => {});
  await settle(1000);
}
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 }).catch(() => {});
await settle(2500);
ok('submitted again, it starts a fresh chain with Sam', (await statusOf(tb)) === 'in_progress' && (await live(tb)) === SAM, `${await statusOf(tb)} ${await live(tb)}`);

const cx = await raise('Leave Application', TOM, leave('QA cancel'));
await markReadDb(SAM);
await page.goto(`${BASE}/status/${cx}?as=${TOM}`);
await settle(3000);
await page.getByRole('button', { name: /Cancel request/ }).click();
await settle(500);
await page.getByPlaceholder('Why is it being cancelled? (optional)').fill('Plans changed.');
await page.getByRole('button', { name: /Confirm cancel/ }).click();
await settle(2500);
ok('cancelled, the request ends and its steps are skipped', (await statusOf(cx)) === 'cancelled'
  && (await chain(cx)).every((r) => r.status === 'skipped'));
ok('...Sam is told, with the reason', (await notes(SAM, cx, 'request.cancelled')).some((n) => n.body.includes('Plans changed')));
ok('...and the status page says Cancelled', /Cancelled/.test(await text()));

const late = await raise('Leave Application', TOM, leave('QA too late'));
await approveAs(SAM, late);
await page.goto(`${BASE}/status/${late}?as=${TOM}`);
await settle(3000);
ok('once somebody has approved, Take back and Cancel are gone', (await page.getByRole('button', { name: /Take back to edit/ }).count()) === 0
  && (await page.getByRole('button', { name: /Cancel request/ }).count()) === 0);
const lateErr = await asPerson(TOM, `select public.cancel_submission($1, 'try', $2)`, [late, TOM]);
const lateErr2 = await asPerson(TOM, `select public.recall_submission($1, $2)`, [late, TOM]);
ok('...and the database refuses both', /already approved/.test(lateErr ?? '') && /already approved/.test(lateErr2 ?? ''), `${lateErr} / ${lateErr2}`);
ok('...it carries on', (await statusOf(late)) === 'in_progress' && (await live(late)) === NADIA);
const notMine = await asPerson(MEI, `select public.cancel_submission($1, 'not mine', $2)`, [tb, MEI]);
ok('somebody else cannot cancel Tom\'s request', /only the person who raised/.test(notMine ?? ''), notMine);

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA APPROVALS (2) CHECKS PASSED');
process.exit(failures ? 1 : 0);
