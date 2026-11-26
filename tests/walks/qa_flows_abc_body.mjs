// ================================================================ QA flows 2: the ABC (gift & hospitality) declaration, through the UI
// Tom declares a gift with its value and invoice, copies a colleague; his
// line manager clears it, then any two of the three compliance officers
// (one asks Tom to clarify, one asks the other a question), the third is
// then not needed, then finance by value. Compliance follow it on their tracker.
const go = async (path, who, ms = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${who}`); await settle(ms); };
const openStep = async (sub, who) => (await one(
  `select id from public.approval_requests where submission_id = $1 and approver_user_id = $2 and status in ('pending', 'clarification')
    order by step_index, lane, lane_step limit 1`, [sub, who]))?.id;
const status = async (id) => (await one(`select status from public.approval_requests where id = $1`, [id]))?.status;
const told = async (who, kind, sub) => (await one(
  `select count(*)::int n from public.notifications where recipient_id = $1 and kind = $2 and entity_id = $3`, [who, kind, sub])).n;
async function queueRow(who, sub) {
  const id = await openStep(sub, who);
  await go('/approvals', who, 3000);
  return { id, row: page.locator(`#approval-${id}`) };
}
async function approveIn(who, sub, label) {
  const { id, row } = await queueRow(who, sub);
  if (!id || !(await row.count())) { ok(`${label}: in ${who}'s queue`, false, `step ${id}`); return; }
  await row.getByRole('button', { name: /^Approve$/ }).click();
  await settle(2500);
  ok(`${label}: approved from the queue`, (await status(id)) === 'approved', (await text()).slice(0, 200));
}
const fileFetch = (href) => page.evaluate(async (h) => { const r = await fetch(h); return r.status; }, href);

// ---------------------------------------------------------------- Tom declares
const giftForm = await formId('Gift & Hospitality Declaration');
await go(`/forms/${giftForm}`, 'EMP-2847', 3000);
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(900);
await (await field('Declaration type')).locator('select').selectOption('Gift received');
await (await field('Counterparty')).locator('input').fill('Apex Telecom Ltd');
await (await field('Event date')).locator('input[data-date]').fill('2026-11-18');
await (await field('Value')).locator('input').fill('75000');
await (await field('Reference number')).locator('input').fill('GH-2026-114');
await (await field('Supporting document')).locator('input[type="file"]').setInputFiles({ name: 'apex-gift-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Apex gift hamper invoice BDT 75,000') });
await settle(400);
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(3500);
let body = await text();
let who = body.slice(body.search(/Who will approve/i));
ok('ABC review: Sam first, then any 2 of the 3 compliance officers at once',
  who.indexOf('Sam Lindqvist') >= 0 && /Compliance review — at the same time · any 2 of 3 must clear/.test(who)
  && ['Lena Ortiz', 'Kofi Mensah', 'Ravi Shah'].every((n) => who.includes(n)) && who.indexOf('Lena Ortiz') > who.indexOf('Sam Lindqvist'), who.slice(0, 500));
ok('ABC review: then finance by value — 75,000 climbs past the 50,000 band to the Head of Finance',
  who.includes('Raj Patel') && who.includes('Dana Whitfield') && who.indexOf('Raj Patel') > who.indexOf('Ravi Shah'), who.slice(0, 700));
await page.locator('select[aria-label="Copy somebody"]').selectOption('EMP-3120');
await settle(500);
ok('ABC review: Tom copies Mei Sun', (await text()).includes('Mei Sun'));
await shot('qa-abc-review');
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 }).catch(() => {});
await settle(2500);
const sub = page.url().includes('/status/') ? page.url().split('/status/')[1].split('?')[0] : null;
ok('ABC: submitted', !!sub, page.url());
const ref = (await one(`select ref_number from public.form_submissions where id = $1`, [sub]))?.ref_number;
const vals = Object.fromEntries((await rows(`select field_name, value from public.submission_values where submission_id = $1`, [sub])).map((r) => [r.field_name, r.value]));
ok('ABC: the value, counterparty and reference are kept', vals['Value'] === '75000' && vals['Counterparty'] === 'Apex Telecom Ltd' && vals['Reference number'] === 'GH-2026-114', JSON.stringify(vals));
const doc = await one(`select id from public.attachments where submission_id = $1 and file_name = 'apex-gift-invoice.pdf'`, [sub]);
ok('ABC: the invoice is attached', !!doc);
const chain = await rows(`select approver_user_id a, step_index s, quorum q, status from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [sub]);
ok('ABC: the chain is Sam, compliance (2 of 3), then finance by value',
  chain.filter((c) => c.s === 1).every((c) => c.q === 2) && chain.map((c) => c.a).join(' ') === 'EMP-1134 EMP-0830 EMP-0831 EMP-0832 EMP-0312 EMP-0600', chain.map((c) => `${c.s}:${c.a}:q${c.q}`).join(' '));
ok('ABC: Mei is copied and told', (await one(`select count(*)::int n from public.submission_cc where submission_id = $1 and employee_id = 'EMP-3120'`, [sub])).n === 1
  && (await told('EMP-3120', 'cc.raised', sub)) === 1);

// ---------------------------------------------------------------- who sees it, and its documents
await go(`/status/${sub}`, 'EMP-3120', 3500);
body = await text();
const docLink = page.locator('a[href^="/files/"]', { hasText: 'apex-gift-invoice.pdf' }).first();
ok('ABC: Mei, copied, sees the declaration and its invoice', body.includes(ref) && (await docLink.count()) === 1, body.slice(0, 300));
ok('ABC: ...and can open the invoice', (await docLink.count()) === 1 && (await fileFetch(await docLink.getAttribute('href'))) === 200);
const errsBefore = pageErrors.length;
await go(`/status/${sub}`, 'EMP-0416', 3500);
body = await text();
ok('ABC: somebody with no part in it does not see it', !body.includes('Apex Telecom') && !body.includes('apex-gift-invoice.pdf'), body.slice(0, 300));
ok('ABC: ...nor its invoice', doc && (await fileFetch(`/files/${doc.id}`)) !== 200);
// The refusals just asked for are logged by the browser as failed loads; anything else stays an error.
pageErrors.push(...pageErrors.splice(errsBefore).filter((e) => !/status of 40[34]/.test(e)));

// ---------------------------------------------------------------- compliance follow it on their tracker
await go('/trackers', 'EMP-0830', 3500);
await page.locator('[data-testid="tracker-list"] button', { hasText: 'ABC declarations' }).click();
await settle(2500);
ok('ABC tracker: Lena sees Tom\'s declaration on the ABC declarations tracker', (await page.locator('[data-testid="tracker-rows"]').innerText().catch(() => '')).includes(ref), ref);
await shot('qa-abc-tracker');

// ---------------------------------------------------------------- the line manager, then compliance
await approveIn('EMP-1134', sub, 'ABC: Sam (line manager)');
ok('ABC: all three compliance officers are asked at once', (await live(sub)) === 'EMP-0830,EMP-0831,EMP-0832', await live(sub));

// Lena asks Tom to clarify.
let lena = await queueRow('EMP-0830', sub);
await lena.row.getByRole('button', { name: /^Clarify$/ }).click();
await settle(800);
await page.locator('[role="dialog"] textarea').fill('Please attach the invitation letter from Apex and say whether you have any open tender with them.');
await page.locator('[role="dialog"]').getByRole('button', { name: /^Confirm$/ }).click();
await settle(2500);
ok('ABC clarify: Lena puts her step on hold for Tom', (await status(lena.id)) === 'clarification');
ok('ABC clarify: Tom is told what is needed', (await told('EMP-2847', 'request.clarification', sub)) === 1);
ok('ABC clarify: Kofi and Ravi can carry on meanwhile', (await live(sub)).includes('EMP-0831') && (await live(sub)).includes('EMP-0832'), await live(sub));
// Tom answers on the request with a note and the letter.
await go(`/status/${sub}`, 'EMP-2847', 3500);
body = await text();
ok('ABC clarify: Tom sees Lena\'s question on his request', body.includes('Please attach the invitation letter from Apex'), body.slice(0, 400));
await page.locator('input[aria-label="Document file"]').setInputFiles({ name: 'apex-invitation.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Apex invitation') });
await page.locator('input[aria-label="New document description"]').fill('Invitation letter from Apex');
await page.getByRole('button', { name: /^Attach$/ }).click();
await settle(2000);
await page.locator('input[aria-label="New note"]').fill('Invitation letter attached. No open tender with Apex.');
await page.getByRole('button', { name: /^Add note$/ }).click();
await settle(2000);
ok('ABC clarify: Tom\'s answer and letter are on the request', (await one(`select count(*)::int n from public.attachments where submission_id = $1 and file_name = 'apex-invitation.pdf'`, [sub])).n === 1
  && (await told('EMP-0830', 'note.added', sub)) >= 1);
lena = await queueRow('EMP-0830', sub);
ok('ABC clarify: Lena\'s row waits on clarification', /Awaiting clarification/.test(await lena.row.innerText()));
await lena.row.getByRole('button', { name: /^Resume$/ }).click();
await settle(2500);
ok('ABC clarify: Lena resumes it once answered', (await status(lena.id)) === 'pending');

// Kofi asks Lena a question beside it.
const kofi = await queueRow('EMP-0831', sub);
await kofi.row.getByRole('button', { name: /^Ask$/ }).click();
await settle(1500);
await page.locator('[role="dialog"] select').selectOption('EMP-0830');
await page.locator('[role="dialog"] textarea').fill('Lena, is Apex on our restricted vendor list?');
await page.locator('[role="dialog"]').getByRole('button', { name: /^Confirm$/ }).click();
await settle(2500);
const q = await one(`select id, asked_to, answer from public.approval_queries where subject_id = $1 and asked_by = 'EMP-0831'`, [sub]);
ok('ABC ask: Kofi asks Lena a question without holding the request', q?.asked_to === 'EMP-0830' && (await status(kofi.id)) === 'pending', JSON.stringify(q));
await go('/approvals', 'EMP-0830', 3000);
ok('ABC ask: Lena sees the question in her queue', (await text()).includes('is Apex on our restricted vendor list?'));
await page.locator('input[placeholder="Your answer"]').first().fill('No — Apex is not restricted.');
await page.getByRole('button', { name: /^Answer$/ }).first().click();
await settle(2000);
ok('ABC ask: ...and answers it', (await one(`select answer from public.approval_queries where id = $1`, [q?.id]))?.answer === 'No — Apex is not restricted.');
await go(`/status/${sub}`, 'EMP-0831', 3500);
ok('ABC ask: the answer shows on the request for Kofi', /No — Apex is not restricted\./.test(await text()));

// Two of three clear it.
await approveIn('EMP-0831', sub, 'ABC: Kofi');
ok('ABC: one officer is not enough — still with compliance', (await live(sub)).includes('EMP-0830'), await live(sub));
await approveIn('EMP-0830', sub, 'ABC: Lena');
const ravi = await one(`select id, status from public.approval_requests where submission_id = $1 and approver_user_id = 'EMP-0832'`, [sub]);
ok('ABC: with two of three, the third officer is no longer needed', ravi?.status === 'skipped', JSON.stringify(ravi));
await go('/approvals', 'EMP-0832', 3000);
ok('ABC: ...and it leaves Ravi\'s queue', (await page.locator(`#approval-${ravi?.id}`).count()) === 0);
ok('ABC: on to finance', (await live(sub)) === 'EMP-0312', await live(sub));

// ---------------------------------------------------------------- finance by value
await approveIn('EMP-0312', sub, 'ABC: Raj (finance)');
ok('ABC: 75,000 goes on to the Head of Finance', (await live(sub)) === 'EMP-0600', await live(sub));
await approveIn('EMP-0600', sub, 'ABC: Dana (head of finance)');
ok('ABC: the declaration is cleared', (await one(`select status from public.form_submissions where id = $1`, [sub])).status === 'completed');
ok('ABC: Tom is told, and Mei as the person copied', (await told('EMP-2847', 'request.completed', sub)) === 1 && (await told('EMP-3120', 'cc.completed', sub)) === 1);
await go(`/status/${sub}`, 'EMP-3120', 3500);
ok('ABC: Mei still sees both documents once it is cleared', (await page.locator('a[href^="/files/"]', { hasText: 'apex-gift-invoice.pdf' }).count()) === 1
  && (await page.locator('a[href^="/files/"]', { hasText: 'apex-invitation.pdf' }).count()) === 1);
await go('/trackers', 'EMP-0831', 3500);
await page.locator('[data-testid="tracker-list"] button', { hasText: 'ABC declarations' }).click();
await settle(2500);
ok('ABC tracker: Kofi, in Compliance too, sees it on the shared tracker', (await page.locator('[data-testid="tracker-rows"]').innerText().catch(() => '')).includes(ref));
await go('/trackers', 'EMP-2847', 3500);
ok('ABC tracker: the ABC tracker is not offered to Tom', !(await page.locator('[data-testid="tracker-list"]').innerText().catch(() => '')).includes('ABC declarations'));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL ABC QA CHECKS PASSED');
process.exit(failures ? 1 : 0);
