// ================================================================ QA flows 1: exit clearance, end to end, as the people would
// Tom raises it through the form; each department's approver ticks their
// own checklist in the approvals queue and approves; HR signs; Payroll
// settles last; Tom gets his certificate. No direct writes: every tick and
// every decision is a click.
const go = async (path, who, ms = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${who}`); await settle(ms); };
const openStep = async (sub, who) => (await one(
  `select id from public.approval_requests where submission_id = $1 and approver_user_id = $2 and status in ('pending', 'clarification')
    order by step_index, lane, lane_step limit 1`, [sub, who]))?.id;
const status = async (id) => (await one(`select status from public.approval_requests where id = $1`, [id]))?.status;
const told = async (who, kind, sub) => (await one(
  `select count(*)::int n from public.notifications where recipient_id = $1 and kind = $2 and entity_id = $3`, [who, kind, sub])).n;

// Their queue, with the row for this request.
async function queueRow(who, sub) {
  const id = await openStep(sub, who);
  await go('/approvals', who, 3000);
  return { id, row: page.locator(`#approval-${id}`) };
}
async function expand(row) {
  if (!(await row.getByText(/View full timeline/).count())) {
    await row.getByText(/Submitted by/).first().click();
    await settle(2000);
  }
}
// Tick, one click at a time, whatever is still open on the person's own checklist.
async function tickOpen(row, max = 12) {
  let n = 0;
  for (let i = 0; i < max; i++) {
    const b = row.locator('button[title="Tick it once it is done"]').first();
    if (!(await b.count())) break;
    await b.click();
    await settle(1100);
    n++;
  }
  return n;
}
async function approve(row) {
  await row.getByRole('button', { name: /^Approve$/ }).click();
  await settle(2500);
}
async function signAndApprove() {
  const pad = page.locator('canvas[aria-label^="Signature pad"]');
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 90);
  await page.mouse.down();
  for (const [dx, dy] of [[60, 40], [110, 100], [170, 30], [230, 95], [290, 50]]) await page.mouse.move(box.x + dx, box.y + dy, { steps: 6 });
  await page.mouse.up();
  await settle(300);
  await page.getByRole('button', { name: /Sign and approve/ }).click();
  await settle(2500);
}
// One department's whole turn: open the row, tick everything, approve.
async function clearLane(who, sub, label) {
  const { id, row } = await queueRow(who, sub);
  const there = id && (await row.count()) === 1;
  if (!there) { ok(`${label}: the step is in ${who}'s queue`, false, `step ${id}`); return null; }
  await expand(row);
  const ticked = await tickOpen(row);
  await approve(row);
  const st = await status(id);
  ok(`${label}: ticked ${ticked} item(s) in the queue and approved`, st === 'approved', `status ${st}; ${(await text()).slice(0, 200)}`);
  return id;
}
// The clearance checklist on the status page: [track, "n of m done", state].
const lane = (track) => page.evaluate((t) => {
  const span = [...document.querySelectorAll('span')].find((s) => s.textContent === t && /of \d+ done/.test(s.nextElementSibling?.textContent ?? ''));
  return span ? [...span.parentElement.querySelectorAll('span')].map((s) => s.textContent.trim()) : null;
}, track);
const TRACKS = ['Own division', 'Finance & Accounts', 'Supply Chain', 'Administration', 'Product & Technology', 'Final settlement', 'Payroll settlement'];
async function lanes(sub) {
  await go(`/status/${sub}`, 'EMP-2847', 3500);
  const out = {};
  for (const t of TRACKS) out[t] = await lane(t);
  return out;
}
const stateOf = (ls) => Object.fromEntries(Object.entries(ls).map(([k, v]) => [k, v ? `${v[1]}|${v[2]}` : null]));

// ---------------------------------------------------------------- Tom raises it
const exitForm = await formId('Employee Exit Clearance');
await go(`/forms/${exitForm}`, 'EMP-2847', 3000);
let body = await text();
ok('exit form: Tom is named on it without typing', body.includes('Tom Bexley'), body.slice(0, 300));
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(900);
// Next with nothing filled: refused, still on the details.
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(500);
const refused = (await page.locator('[data-sonner-toast]').allInnerTexts()).some((t) => /Reason for leaving is required/.test(t)) && /Step 2 of 3/.test(await text());
body = await text();
ok('exit form: moving on with required answers missing is refused', refused && /Before you leave/i.test(body), body.slice(body.indexOf('Form Details'), body.indexOf('Form Details') + 400));
ok('exit form: the leaver\'s own "Before you leave" checklist is on the form',
  ['I have handed over my work, with a signed-off handover note', 'I have returned company property', 'I have handed over official social media and portal accounts', 'I have left or handed over official chat groups']
    .every((t) => body.includes(t)));
await (await field('Reason for leaving')).locator('select').selectOption('Resignation');
await (await field('Resignation date')).locator('input[type="date"]').fill('2026-11-20');
await (await field('Last working day')).locator('input[type="date"]').fill('2026-12-20');
for (const c of ['I have handed over my work, with a signed-off handover note', 'I have returned company property: phone, SIM, laptop, cards and keys',
  'I have handed over official social media and portal accounts', 'I have left or handed over official chat groups']) {
  await page.getByLabel(c).check();
}
await (await field('Anything still outstanding')).locator('textarea').fill('Locker key returned to admin on the last day.');
await (await field('Bank name')).locator('input').fill('Dutch-Bangla Bank');
await (await field('Branch')).locator('input').fill('Gulshan');
await (await field('Account name')).locator('input').fill('Tom Bexley');
await (await field('Account number')).locator('input').fill('1011100123456');
await (await field('Handover note')).locator('input[type="file"]').setInputFiles({ name: 'tom-handover.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Tom handover note') });
await settle(400);
await page.getByLabel(/I confirm all company assets will be returned/).check();
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(3500);
body = await text();
const who = body.slice(body.search(/Who will approve/i));
ok('exit review: five departments clear at the same time', /Departmental clearance — at the same time · all 5 must clear/.test(who), who.slice(0, 300));
ok('exit review: the own-division chain is line manager, HRBP, CXO (Sam once, as line manager and head)',
  /Own division · 1 of 3/.test(who) && /Own division · 3 of 3/.test(who) && !/of 4/.test(who) && (who.match(/Sam Lindqvist/g) ?? []).length === 1
  && who.includes('Nadia Okonjo') && who.includes('Hana Kim'), who.slice(0, 600));
ok('exit review: then HR\'s final settlement, then Payroll',
  who.indexOf('Priya Raman') > who.indexOf('Omar Reyes') && who.indexOf('Zara Ahmed') > who.indexOf('Priya Raman'), who.slice(0, 900));
await shot('qa-exit-review');
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 }).catch(() => {});
await settle(2500);
const sub = page.url().includes('/status/') ? page.url().split('/status/')[1].split('?')[0] : null;
ok('exit: submitted, and Tom lands on its status page', !!sub, page.url());

const vals = Object.fromEntries((await rows(`select field_name, value from public.submission_values where submission_id = $1`, [sub])).map((r) => [r.field_name, r.value]));
ok('exit: the dates, bank account and declarations are kept as answered',
  vals['Resignation date'] === '2026-11-20' && vals['Last working day'] === '2026-12-20' && vals['Account number'] === '1011100123456'
  && vals['Bank name'] === 'Dutch-Bangla Bank' && vals['I have returned company property: phone, SIM, laptop, cards and keys'] === 'Yes'
  && /^Yes$/.test(vals['I confirm all company assets will be returned and the account above may receive my final settlement'] ?? ''), JSON.stringify(vals).slice(0, 400));
ok('exit: the handover note is attached to it',
  (await one(`select count(*)::int n from public.attachments where submission_id = $1 and field_name = 'Handover note' and file_name = 'tom-handover.pdf'`, [sub])).n === 1);

// ---------------------------------------------------------------- the chain as built
const chain = await rows(`select approver_user_id a, step_index s, lane_label l, lane_step ls, status from public.approval_requests
  where submission_id = $1 order by step_index, lane, lane_step`, [sub]);
const pending0 = chain.filter((c) => c.s === 0 && c.status === 'pending').map((c) => c.a).sort().join(',');
ok('exit: five department lanes open at once', pending0 === ['EMP-0312', 'EMP-0445', 'EMP-0520', 'EMP-1134', 'EMP-3120'].sort().join(','), pending0);
const own = chain.filter((c) => c.l === 'Own division').map((c) => c.a).join('>');
ok('exit: own division runs Sam > Nadia (HRBP) > Hana (CXO), the head collapsed into Sam', own === 'EMP-1134>EMP-0201>EMP-0800', own);
ok('exit: HR\'s final settlement and Payroll wait behind them',
  chain.some((c) => c.a === 'EMP-0650' && c.s === 1 && c.status === 'waiting') && chain.some((c) => c.a === 'EMP-0661' && c.s === 2 && c.status === 'waiting'),
  JSON.stringify(chain.filter((c) => c.s > 0)));

let ls = await lanes(sub);
ok('exit status: Tom sees every track\'s checklist, five with them now, two not yet',
  Object.values(ls).filter((v) => v?.[2] === 'With them now').length === 5 && ls['Final settlement']?.[2] === 'Not yet' && ls['Payroll settlement']?.[2] === 'Not yet',
  JSON.stringify(stateOf(ls)));
ok('exit status: ...with the SOW\'s items counted (6, 4, 1, 5, 1, 10, 4)',
  ['0 of 6 done', '0 of 4 done', '0 of 1 done', '0 of 5 done', '0 of 1 done', '0 of 10 done', '0 of 4 done'].join() === TRACKS.map((t) => ls[t]?.[1]).join(),
  JSON.stringify(stateOf(ls)));
ok('exit status: Tom cannot tick anybody\'s checklist', (await page.locator('button[title="Tick it once it is done"]').count()) === 0);
await shot('qa-exit-status-open');

// ---------------------------------------------------------------- Finance: refused until ticked
let { id: finStep, row } = await queueRow('EMP-0312', sub);
ok('finance: the clearance is in Raj\'s queue', (await row.count()) === 1);
await approve(row);
body = await text();
ok('finance: approving with the checklist open is refused, and says how many are open', /tick the checklist first: 4 items are still open/i.test(body), body.slice(0, 300));
ok('finance: ...and the row opens on his own checklist only', (await row.innerText()).includes('Unsettled bills') && !(await row.innerText()).includes('Desk keys')
  && /Tick each item before you approve this step/.test(await row.innerText()));
ok('finance: ...beside the request, with Tom\'s handover note to open', (await row.locator('a', { hasText: 'tom-handover.pdf' }).count()) >= 1, (await row.innerText()).slice(0, 600));
// The SOW: "checklist ... with remarks". Is there anywhere to write one beside a tick?
const checklistInputs = await row.locator('input:not([type="checkbox"]), textarea').count();
ok('finance: an approver can write a note against a checklist item as they tick it', checklistInputs > 0, 'the checklist offers tick/untick only (ClearanceChecklist passes p_note: null)');
// Three of four, then try again.
for (let i = 0; i < 3; i++) { await row.locator('button[title="Tick it once it is done"]').first().click(); await settle(1100); }
ok('finance: ticks show who ticked them', ((await row.innerText()).match(/Raj Patel, \d{2}\/\d{2}\/\d{4}/g) ?? []).length === 3, (await row.innerText()).slice(0, 500));
await approve(row);
ok('finance: with one item open it is still refused', /1 item is still open/i.test(await text()) && (await status(finStep)) === 'pending');
// Untick and tick again: the untick is a click too.
await row.locator('button[title="Untick"]').first().click(); await settle(1100);
ok('finance: an item can be unticked', ((await row.innerText()).match(/Raj Patel, \d{2}\/\d{2}\/\d{4}/g) ?? []).length === 2);
await tickOpen(row);
await approve(row);
ok('finance: all four ticked, Finance clears', (await status(finStep)) === 'approved');
ok('finance: the other lanes are told Finance has cleared it',
  (await Promise.all(['EMP-3120', 'EMP-0445', 'EMP-0520', 'EMP-1134'].map((w) => told(w, 'phase.lane_cleared', sub)))).every((n) => n === 1));
await go('/', 'EMP-3120', 2500);
await page.getByRole('button', { name: /^Notifications/ }).click();
await settle(1500);
ok('finance: ...Mei sees it in her notifications', /Finance & Accounts has cleared it/.test(await text()));
await page.keyboard.press('Escape');

ls = await lanes(sub);
ok('exit status: Finance shows cleared, 4 of 4, the rest still with them',
  ls['Finance & Accounts']?.[1] === '4 of 4 done' && ls['Finance & Accounts']?.[2] === 'Cleared' && ls['Supply Chain']?.[2] === 'With them now', JSON.stringify(stateOf(ls)));
ok('exit status: ...and who ticked each item, when', /Raj Patel, \d{2}\/\d{2}\/\d{4}/.test(await text()));

// ---------------------------------------------------------------- the other departments
await clearLane('EMP-3120', sub, 'supply chain (Mei)');
await clearLane('EMP-0445', sub, 'administration (Farah)');
// IT: ServiceDesk is not connected here, so Omar ticks it himself.
const it = await queueRow('EMP-0520', sub);
await expand(it.row);
ok('IT: Omar\'s checklist is the ManageEngine clearance', (await it.row.innerText()).includes('IT clearance completed in ManageEngine'));
await tickOpen(it.row);
await approve(it.row);
ok('IT: ticked and approved by hand when ServiceDesk is not connected', (await status(it.id)) === 'approved');
ok('IT: Sam has heard of each department that cleared (4)', (await told('EMP-1134', 'phase.lane_cleared', sub)) === 4, String(await told('EMP-1134', 'phase.lane_cleared', sub)));
ok('exit: HR is not asked while the own division is still open', !(await live(sub)).includes('EMP-0650'), await live(sub));
await go('/approvals', 'EMP-0650', 3000);
ok('HR: Priya has nothing to act on yet', (await page.locator(`#approval-${await stepOf(sub, 'EMP-0650')}`).count()) === 0);

// ---------------------------------------------------------------- own division, in order
await clearLane('EMP-1134', sub, 'own division: line manager (Sam)');
ok('own division: next it is with Nadia, the HRBP', (await live(sub)) === 'EMP-0201', await live(sub));
const nadia = await queueRow('EMP-0201', sub);
await expand(nadia.row);
ok('own division: Nadia sees the division checklist Sam ticked (6 of 6)', /6 of 6 done/.test(await nadia.row.innerText()), (await nadia.row.innerText()).slice(-500));
await approve(nadia.row);
ok('own division: Nadia approves', (await status(nadia.id)) === 'approved');
ok('own division: then Hana, the CXO', (await live(sub)) === 'EMP-0800', await live(sub));
await clearLane('EMP-0800', sub, 'own division: CXO (Hana)');

// ---------------------------------------------------------------- HR final, signed
ok('HR: only once all five lanes cleared is it with Priya', (await live(sub)) === 'EMP-0650', await live(sub));
ok('HR: Priya was told it is her turn', (await one(`select count(*)::int n from public.notifications where recipient_id = 'EMP-0650' and entity_id = $1 and kind like 'approval.%'`, [sub])).n >= 1);
ls = await lanes(sub);
ok('exit status: five departments cleared, final settlement with them now',
  ['Own division', 'Finance & Accounts', 'Supply Chain', 'Administration', 'Product & Technology'].every((t) => ls[t]?.[2] === 'Cleared') && ls['Final settlement']?.[2] === 'With them now',
  JSON.stringify(stateOf(ls)));
const hr = await queueRow('EMP-0650', sub);
ok('HR: the row says a signature is needed', /Signature required/.test(await hr.row.innerText()));
await approve(hr.row);
const padFirst = (await page.getByText('This step needs your signature').count()) === 1;
ok('HR: with 10 items open, Priya is told to tick them before being asked to sign', !padFirst && /10 items are still open/i.test(await text()),
  padFirst ? 'the signature pad opens first; the checklist refusal only comes after she has signed' : (await text()).slice(0, 200));
if (padFirst) {
  await signAndApprove();
  ok('HR: ...signing with 10 items open is then refused', /10 items are still open/i.test(await text()) && (await status(hr.id)) === 'pending', (await text()).slice(0, 200));
  await page.keyboard.press('Escape'); await settle(600);
  if (await page.getByText('This step needs your signature').count()) { await page.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {}); await settle(600); }
}
await expand(hr.row);
await tickOpen(hr.row, 12);
await approve(hr.row);
ok('HR: once ticked, approving asks for a signature', (await page.getByText('This step needs your signature').count()) === 1);
await signAndApprove();
const signed = await one(`select status, signature like 'data:image/png;base64,%' sig from public.approval_requests where id = $1`, [hr.id]);
ok('HR: Priya signs and the final settlement clears', signed?.status === 'approved' && signed.sig, JSON.stringify(signed));

// ---------------------------------------------------------------- Payroll, last
ok('payroll: then, and only then, Zara', (await live(sub)) === 'EMP-0661', await live(sub));
ok('exit: not complete before Payroll settles', (await one(`select status from public.form_submissions where id = $1`, [sub])).status !== 'completed');
const pay = await queueRow('EMP-0661', sub);
await expand(pay.row);
ok('payroll: Zara\'s checklist is the settlement one', /Final settlement calculated/.test(await pay.row.innerText()) && /Paid to the nominated bank account/.test(await pay.row.innerText()));
ok('payroll: ...beside Tom\'s nominated account', (await pay.row.innerText()).includes('1011100123456'));
await tickOpen(pay.row);
await approve(pay.row);
ok('payroll: settled', (await status(pay.id)) === 'approved');

// ---------------------------------------------------------------- done
const done = await one(`select status from public.form_submissions where id = $1`, [sub]);
ok('exit: the clearance is complete', done.status === 'completed', JSON.stringify(done));
ok('exit: Tom is told it is complete', (await told('EMP-2847', 'request.completed', sub)) === 1);
await go('/', 'EMP-2847', 2500);
await page.getByRole('button', { name: /^Notifications/ }).click();
await settle(1500);
ok('exit: ...and sees it in his notifications', /Fully approved/.test(await text()));
await page.keyboard.press('Escape');
ls = await lanes(sub);
ok('exit status: every track cleared, every item done',
  TRACKS.every((t) => ls[t]?.[2] === 'Cleared') && TRACKS.every((t) => { const m = /^(\d+) of (\d+) done$/.exec(ls[t]?.[1] ?? ''); return m && m[1] === m[2]; }), JSON.stringify(stateOf(ls)));
body = await text();
ok('exit status: it offers the certificate', /Clearance complete/.test(body) && /View certificate/.test(body));
ok('exit status: the signature shows on the timeline', (await page.locator('img[alt="Signature"]').count()) === 1);
await shot('qa-exit-complete');
// The certificate carries the organisation's name; "Local QA" reads as the portal, so name it first.
await page.goto('about:blank'); await settle(800);
await db.query(`update public.tenants set name = 'Northwind Payments Ltd' where id = $1`, [tenant]);
await go(`/status/${sub}`, 'EMP-2847', 3000);
await page.getByText('View certificate').click();
await settle(3000);
body = await text();
ok('certificate: in the organisation\'s name, for Tom', /Company Clearance Certificate/.test(body) && body.includes('Northwind Payments Ltd') && body.includes('Tom Bexley') && body.includes('EMP-2847'), body.slice(0, 400));
ok('certificate: lists who approved it, HR and Payroll included', ['Priya Raman', 'Zara Ahmed', 'Raj Patel', 'Hana Kim'].every((n) => body.includes(n)), body.slice(0, 900));
await shot('qa-exit-certificate');
await go(`/status/${sub}`, 'EMP-2847', 3000);
const pdf = await page.evaluate(async (h) => { const r = await fetch(h); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, head: String.fromCharCode(...b.slice(0, 4)), size: b.length }; }, `/records/${sub}`);
ok('exit: the approval record PDF downloads', pdf.status === 200 && pdf.head === '%PDF' && pdf.size > 2000, JSON.stringify(pdf));
ok('exit: the status page links the record', (await page.locator(`a[href="/records/${sub}"]`).count()) >= 1);

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL EXIT CLEARANCE QA CHECKS PASSED');
process.exit(failures ? 1 : 0);
