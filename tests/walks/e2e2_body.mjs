
// ================================================================ Stage 2
const asOwner = async (sql, params = []) => {
  await db.exec(`select set_config('app.tenant_id', '${tenant}', false)`);
  return (await db.query(sql, params)).rows;
};

// ------------------------------------------------ the exit clearance page
const exitSub = await subOf('Employee Exit Clearance', 'EMP-2847');
const exitRef = (await one(`select ref_number from public.form_submissions where id = $1`, [exitSub])).ref_number;
ok('requests carry readable references', /^AMS-\d{4}-\d{5}$/.test(exitRef ?? ''), exitRef);

await page.goto(`${BASE}/status/${exitSub}?as=EMP-2847`);
await settle(3000);
let t = await text();
ok('the status page leads with the reference', t.includes(exitRef));
ok('dates are written dd/MM/yyyy', /\b\d{2}\/\d{2}\/\d{4}\b/.test(t) && !/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}/.test(t));
ok('the seeded note is on the request', t.includes('Locker key still outstanding'));
ok('...and the person copied', /copied on this/i.test(t) && t.includes('Priya Raman'));
ok('...and the linked leave application', t.includes('Leave taken during the notice period'));

await page.getByRole('tab', { name: 'Process map' }).click();
await settle(800);
const boxes = await page.locator('[aria-label="Process map"] svg rect').count();
ok('the process map draws every step', boxes === 8, `${boxes} steps drawn`);
await shot('s2-process-map');
await page.getByRole('tab', { name: 'Timeline' }).click();

// A document, then a revised one, described and tagged.
async function attach(name, body, desc, tags) {
  await page.locator('input[aria-label="Document file"]').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(body) });
  await page.locator('input[aria-label="New document description"]').fill(desc);
  await page.locator('input[aria-label="New document tags"]').fill(tags);
  await page.getByRole('button', { name: /^Attach$/ }).click();
  await settle(1800);
}
await attach('handover-v1.pdf', '%PDF v1', 'Signed handover note', 'handover, it-assets');
await attach('handover-v2.pdf', '%PDF v2', 'Handover note, countersigned', 'handover, it-assets');
const versions = await rows(
  `select file_name, version, superseded_at is not null as old, tags from public.attachments
    where submission_id = $1 and field_name = 'Handover note' order by version`, [exitSub]);
ok('a revised document is a new version, the first kept', versions.length === 2 && versions[0].old && !versions[1].old && versions[1].version === 2,
  JSON.stringify(versions.map((v) => [v.file_name, v.version, v.old])));
ok('...tagged as typed', JSON.stringify(versions[1]?.tags) === JSON.stringify(['handover', 'it-assets']));
ok('...and each addition after routing is on the trail',
  (await rows(`select action from public.approval_events where subject_id = $1 and action in ('document_added', 'document_revised')`, [exitSub])).length === 2);

const href = await page.locator('a[href^="/files/"]').first().getAttribute('href');
const dl = await page.evaluate(async (h) => (await fetch(h)).status, href);
ok('opening a document is logged with who opened it',
  dl === 200 && (await rows(`select actor_id from public.attachment_access`)).some((r) => r.actor_id === 'EMP-2847'));

await page.locator('input[placeholder^="Search submissions"]').fill('handover');
await settle(2000);
t = await text();
ok('documents are found by tag from the search box', t.includes('handover-v2.pdf'));
await page.keyboard.press('Escape');

// A note from an approver tells everybody else on it.
await page.goto(`${BASE}/status/${exitSub}?as=EMP-0312`);
await settle(2500);
await page.locator('input[aria-label="New note"]').fill('No IOUs outstanding — finance is clear.');
await page.getByRole('button', { name: /^Add note$/ }).click();
await settle(1800);
ok('an approver adds a note, and the requester is told',
  (await rows(`select 1 from public.notifications where kind = 'note.added' and recipient_id = 'EMP-2847' and entity_id = $1`, [exitSub])).length >= 1);

// Clear every lane, then HR signs the final settlement.
for (const who of ['EMP-3120', 'EMP-0520', 'EMP-1134', 'EMP-0201', 'EMP-0800']) await approveAs(who, exitSub);
ok('it reaches HR once every lane has cleared', (await live(exitSub)) === 'EMP-0650', await live(exitSub));

const hrStep = await stepOf(exitSub, 'EMP-0650');
// HR's final-settlement checklist, ticked as Priya would.
await page.goto('about:blank');
await settle(800);
await db.query(`insert into public.checklist_ticks (tenant_id, submission_id, item_id, done_by)
  select ar.tenant_id, ar.submission_id, i.id, ar.approver_user_id from public.approval_requests ar
    join public.form_submissions s on s.id = ar.submission_id
    join public.checklist_items i on i.tenant_id = ar.tenant_id and i.form_template_id = s.form_template_id and i.active
                                 and i.track = app.checklist_track(ar.lane_label, ar.stage_label)
   where ar.id = $1 on conflict do nothing`, [hrStep]);
await page.goto(`${BASE}/approvals?as=EMP-0650`);
await settle(2500);
await page.locator(`#approval-${hrStep}`).getByRole('button', { name: /^Approve$/ }).click();
await settle(800);
ok('a step that needs a signature asks for one', (await page.getByText('This step needs your signature').count()) === 1);
const pad = page.locator('canvas[aria-label^="Signature pad"]');
const box = await pad.boundingBox();
await page.mouse.move(box.x + 20, box.y + 90);
await page.mouse.down();
for (const [dx, dy] of [[60, 40], [110, 100], [170, 30], [230, 95], [290, 50]]) await page.mouse.move(box.x + dx, box.y + dy, { steps: 6 });
await page.mouse.up();
await settle(300);
await page.getByRole('button', { name: /Sign and approve/ }).click();
await settle(2500);
const signed = await one(`select status, signature like 'data:image/png;base64,%' as has_sig from public.approval_requests where id = $1`, [hrStep]);
ok('...and is approved with the drawn signature kept', signed?.status === 'approved' && signed?.has_sig, JSON.stringify(signed));
await page.goto(`${BASE}/status/${exitSub}?as=EMP-2847`);
await settle(2500);
ok('the signature shows on the timeline', (await page.locator('img[alt="Signature"]').count()) === 1);

// ------------------------------------------------ priority and CC on a claim
const travel = await formId('Travel & Expense Reimbursement');
await page.goto(`${BASE}/forms/${travel}?as=EMP-2847`);
await settle(2500);
for (let i = 0; i < 4 && !(await page.locator('input[type="number"]').count()); i++) {
  await page.getByRole('button', { name: /Next|Continue/ }).first().click().catch(() => {});
  await settle(600);
}
await (await field('Purpose of travel')).locator('input').fill('Supplier audit, Sylhet');
await page.locator('input[data-date]').first().fill('2026-12-01');
await page.locator('input[type="number"]').first().fill('45000');
await page.getByRole('button', { name: /Next|Continue/ }).first().click();
await settle(2500);
await page.locator('select[aria-label="Priority"]').selectOption('urgent');
await page.locator('select[aria-label="Copy somebody"]').selectOption('EMP-3120');
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(2000);
const claim = page.url().split('/status/')[1].split('?')[0];
const c = await one(`select priority, ref_number from public.form_submissions where id = $1`, [claim]);
ok('the claim is urgent', c?.priority === 'urgent');
ok('...and the person copied was told it was raised',
  (await rows(`select 1 from public.notifications where recipient_id = 'EMP-3120' and kind = 'cc.raised' and entity_id = $1`, [claim])).length === 1);
// Sooner than the rule's three working days would make it, whatever the weekday.
const due = await one(`select deadline_at < app.add_working_days(now(), 3, tenant_id) as sooner, deadline_at
                         from public.approval_requests where submission_id = $1 and status = 'pending'`, [claim]);
ok('...and due sooner than three working days', due?.sooner === true, JSON.stringify(due));
await page.goto(`${BASE}/approvals?as=EMP-1134`);
await settle(3000);
const firstRow = await page.locator('[id^="approval-"]').first().innerText();
ok('the urgent claim heads the line manager\'s queue', firstRow.includes(c?.ref_number) && firstRow.includes('Urgent'));

// ------------------------------------------------ copied-to-me, copy, link
await page.goto(`${BASE}/submissions?as=EMP-3120`);
await settle(2500);
await page.getByRole('tab', { name: 'Copied to me' }).click();
await settle(2000);
ok('the claim is among what was copied to Mei', (await text()).includes(c?.ref_number));

await page.goto(`${BASE}/submissions?as=EMP-2847`);
await settle(2500);
await page.locator('input[aria-label="Search submissions"]').fill(c?.ref_number ?? '');
await settle(500);
await page.getByRole('button', { name: /^Copy$/ }).first().click();
await page.waitForURL(/\/forms\//, { timeout: 15000 });
await settle(1500);
const copy = await one(
  `select s.id, s.status, s.priority from public.form_submissions s
     join public.submission_links l on l.from_id = s.id and l.to_id = $1 and l.note = 'Copied from'`, [claim]);
ok('copying makes a linked draft with the same priority', copy?.status === 'draft' && copy?.priority === 'urgent');
ok('...and the same answers',
  (await one(`select value from public.submission_values where submission_id = $1 and field_name = 'Purpose of travel'`, [copy?.id]))?.value === 'Supplier audit, Sylhet');

await page.goto(`${BASE}/status/${claim}?as=EMP-2847`);
await settle(2500);
await page.locator('input[aria-label="Link to reference"]').fill(exitRef);
await page.locator('input[aria-label="Link note"]').fill('Settled before leaving');
await page.getByRole('button', { name: /^Link$/ }).click();
await settle(1800);
ok('requests link by reference', (await text()).includes('Settled before leaving'));

// ------------------------------------------------ board tier, exceptional flag
const capex = await formId('Capital Expenditure Request');
const plan = (await asOwner(`select public.preview_approval_chain($1, 'EMP-2847', '{"Amount": "6,000,000"}'::jsonb) p`, [capex]))[0].p;
const board = plan.filter((p) => p.stage_label === 'Board approval');
ok('above 5,000,000 a capex request needs any two of three board members', board.length === 3 && board.every((p) => p.quorum === 2),
  JSON.stringify(board.map((b) => [b.approver, b.quorum])));
const small = (await asOwner(`select public.preview_approval_chain($1, 'EMP-2847', '{"Amount": "400000"}'::jsonb) p`, [capex]))[0].p;
ok('...and below it the board is not asked', !small.some((p) => p.stage_label === 'Board approval'));

const campaign = await formId('Campaign Request');
const ex = (await asOwner(
  `insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status) values ($1, $2, 'EMP-2847', 'submitted') returning id`,
  [tenant, campaign]))[0].id;
await asOwner(`insert into public.submission_values (tenant_id, submission_id, field_name, value) values ($1, $2, 'Approval route', 'Exceptional')`, [tenant, ex]);
await asOwner(`select public.build_approval_chain('form_submission', $1, $2)`, [ex, campaign]);
await page.goto(`${BASE}/approvals?as=EMP-0800`);
await settle(3000);
ok('an exceptional request says so in the CXO\'s queue', (await page.locator(`#approval-${await stepOf(ex, 'EMP-0800')}`).innerText()).includes('Exceptional'));

// ------------------------------------------------ a leaver hands over
const samOpen = (await rows(`select count(*)::int n from public.approval_requests where approver_user_id = 'EMP-1134' and status in ('pending','waiting','clarification') and tenant_id = $1`, [tenant]))[0].n;
await page.goto(`${BASE}/approvals/delegate?as=EMP-0650`);
await settle(2500);
await page.locator('select[aria-label="Who is leaving"]').selectOption('EMP-1134');
await page.locator('select[aria-label="Who takes over"]').selectOption('EMP-0201');
await page.getByRole('button', { name: /^Hand over$/ }).click();
await settle(2500);
const after = await rows(`select
    (select count(*)::int from public.approval_requests where approver_user_id = 'EMP-1134' and status in ('pending','waiting','clarification') and tenant_id = $1) as left_with_sam,
    (select active from public.employees where employee_id = 'EMP-1134' and tenant_id = $1) as sam_active,
    (select line_manager_id from public.employees where employee_id = 'EMP-2847' and tenant_id = $1) as toms_manager,
    (select head_employee_id from public.departments where name = 'Operations' and tenant_id = $1) as ops_head`, [tenant]);
ok(`a leaver's ${samOpen} open steps, reports and department all pass to the successor`,
  samOpen > 0 && after[0].left_with_sam === 0 && after[0].sam_active === false &&
  after[0].toms_manager === 'EMP-0201' && after[0].ops_head === 'EMP-0201', JSON.stringify(after[0]));

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL STAGE 2 E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
