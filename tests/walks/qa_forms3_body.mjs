// ================================================================ QA: drafts, resuming, copying, Word import
// Save a request as a draft, leave, find it in My Submissions, resume
// it with its answers, submit it as the same request; copy a submitted
// request to a new one with its answers; fill an NFA from a Word file.
const toasts = async () => (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
const heading = async () => (await page.locator('h2').first().innerText().catch(() => '')).trim();
const valuesOf = async (sub) => Object.fromEntries((await rows(
  `select field_name, value from public.submission_values where submission_id = $1`, [sub])).map((r) => [r.field_name, r.value]));
const next = async () => { await page.getByRole('button', { name: /^Next/ }).click(); await settle(900); };
const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 QA ' + name) });

// ---------------------------------------------------------------- a draft, saved and left
const leave = await formId('Leave Application');
const mineOn = async (form) => (await one(`select count(*)::int n from public.form_submissions where form_template_id = $1 and submitted_by = 'EMP-2847'`, [form])).n;
const leaveBefore = await mineOn(leave);
await page.goto(`${BASE}/forms/${leave}?as=EMP-2847`);
await settle(3000);
await next();
await (await field('Leave type')).locator('select').selectOption('Sick');
await (await field('From')).locator('input').fill('2026-12-21');
await (await field('To')).locator('input').fill('2026-12-22');
await (await field('Reason')).locator('textarea').fill('Dentist, then rest');
await next();
await settle(1500);
await page.getByRole('button', { name: /^Save draft$/ }).click();
await settle(2500);
ok('Draft: saving says where it went', /Draft saved/.test(await toasts()), await toasts());
ok('Draft: ...and the button now updates that draft', (await page.getByRole('button', { name: /^Update draft$/ }).count()) === 1);
const draft = (await one(`select id, status from public.form_submissions where form_template_id = $1 and submitted_by = 'EMP-2847' order by submitted_at desc limit 1`, [leave]));
let v = await valuesOf(draft?.id);
ok('Draft: it is kept as a draft with the answers, and nobody is asked to approve it',
  draft?.status === 'draft' && v['Leave type'] === 'Sick' && v['From'] === '2026-12-21' && v['Reason'] === 'Dentist, then rest'
  && (await one(`select count(*)::int n from public.approval_requests where submission_id = $1`, [draft?.id])).n === 0, JSON.stringify(v));
// Saving again updates the one draft, it does not make another.
await page.getByRole('button', { name: /^Update draft$/ }).click();
await settle(2000);
ok('Draft: saving twice keeps one draft', (await mineOn(leave)) === leaveBefore + 1, `${leaveBefore} -> ${await mineOn(leave)}`);

// Leave, and come back to it from My Submissions.
await page.goto(`${BASE}/?as=EMP-2847`);
await settle(2000);
await page.goto(`${BASE}/submissions?as=EMP-2847`);
await settle(3000);
await page.locator('select[aria-label="Status"]').selectOption('draft');
await settle(600);
const draftLink = page.locator(`a[href*="draft=${draft?.id}"]`);
ok('Draft: My Submissions lists it as a draft', (await draftLink.count()) === 1 && (await draftLink.innerText()).includes('Leave Application'));
await draftLink.click();
await page.waitForURL(/draft=/, { timeout: 15000 });
await settle(3000);
await next();
ok('Draft: resuming brings every answer back',
  (await (await field('Leave type')).locator('select').inputValue()) === 'Sick'
  && (await (await field('From')).locator('input').inputValue()) === '2026-12-21'
  && (await (await field('To')).locator('input').inputValue()) === '2026-12-22'
  && (await (await field('Reason')).locator('textarea').inputValue()) === 'Dentist, then rest');
await (await field('To')).locator('input').fill('2026-12-23');
await next();
await settle(1500);
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(2500);
const submittedId = page.url().split('/status/')[1].split('?')[0];
const s = await one(`select status, ref_number from public.form_submissions where id = $1`, [submittedId]);
v = await valuesOf(submittedId);
ok('Draft: submitting it makes that same request submitted, with the change, not a second one',
  submittedId === draft?.id && ['submitted', 'in_progress'].includes(s?.status) && v['To'] === '2026-12-23' && (await mineOn(leave)) === leaveBefore + 1,
  JSON.stringify({ submittedId, draft: draft?.id, s, to: v['To'] }));
ok('Draft: once submitted it goes to the line manager', (await one(`select approver_user_id from public.approval_requests where submission_id = $1 and status = 'pending'`, [submittedId]))?.approver_user_id === 'EMP-1134');
ok('Draft: the status page shows its reference', (await text()).includes(s?.ref_number));

// ---------------------------------------------------------------- a draft with a date range and a file
const night = await formId('Night Allowance');
await page.goto(`${BASE}/forms/${night}?as=EMP-2847`);
await settle(3000);
await next();
{
  const box = await field('Period');
  await box.locator('input[type="date"]').nth(0).fill('2026-11-16');
  await box.locator('input[type="date"]').nth(1).fill('2026-11-18');
}
await (await field('Nights worked')).locator('input').fill('3');
await (await field('Rate per night')).locator('input').fill('1000');
await (await field('Note')).locator('textarea').fill('Month-end close');
await next();
await settle(1500);
await page.getByRole('button', { name: /^Save draft$/ }).click();
await settle(2500);
const nDraft = (await one(`select id from public.form_submissions where form_template_id = $1 and submitted_by = 'EMP-2847' and status = 'draft' order by submitted_at desc limit 1`, [night]))?.id;
await page.goto(`${BASE}/submissions?as=EMP-2847`);
await settle(3000);
await page.locator(`a[href*="draft=${nDraft}"]`).click();
await page.waitForURL(/draft=/, { timeout: 15000 });
await settle(3000);
await next();
{
  const box = await field('Period');
  const from = await box.locator('input[type="date"]').nth(0).inputValue();
  const to = await box.locator('input[type="date"]').nth(1).inputValue();
  ok('Draft: a resumed date range shows both its dates', from === '2026-11-16' && to === '2026-11-18', `from "${from}" to "${to}"`);
}
ok('Draft: resumed numbers and notes are back', (await (await field('Nights worked')).locator('input').inputValue()) === '3'
  && (await (await field('Note')).locator('textarea').inputValue()) === 'Month-end close');
await (await field('Nights worked')).locator('input').fill('5');
await next();
await settle(1500);
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(2500);
const nightSub = page.url().split('/status/')[1].split('?')[0];
v = await valuesOf(nightSub);
ok('Draft: the resumed allowance is submitted with its period intact and the new nights',
  nightSub === nDraft && v['Nights worked'] === '5' && v['Period'] === JSON.stringify({ from: '2026-11-16', to: '2026-11-18' }), JSON.stringify(v));

// A file chosen before saving the draft is attached once and still there on resuming.
const gift = await formId('Gift & Hospitality Declaration');
await page.goto(`${BASE}/forms/${gift}?as=EMP-2847`);
await settle(3000);
await next();
await (await field('Declaration type')).locator('select').selectOption('Gift received');
await (await field('Counterparty')).locator('input').fill('Acme Supplies Ltd');
await (await field('Event date')).locator('input').fill('2026-11-20');
await (await field('Value')).locator('input').fill('4500');
await (await field('Supporting document')).locator('input[type="file"]').setInputFiles(pdf('gift-photo.pdf'));
await next();
await settle(1500);
await page.getByRole('button', { name: /^Save draft$/ }).click();
await settle(3000);
const gDraft = (await one(`select id from public.form_submissions where form_template_id = $1 and submitted_by = 'EMP-2847' and status = 'draft' order by submitted_at desc limit 1`, [gift]))?.id;
ok('Draft: a file chosen before saving is attached to the draft',
  (await one(`select count(*)::int n from public.attachments where submission_id = $1 and file_name = 'gift-photo.pdf'`, [gDraft])).n === 1);
await page.goto(`${BASE}/forms/${gift}?draft=${gDraft}&as=EMP-2847`);
await settle(3000);
await next();
ok('Draft: ...and shows on the form when it is resumed', (await (await field('Supporting document')).innerText()).includes('gift-photo.pdf'));
await next();
await settle(1500);
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(2500);
ok('Draft: submitting it does not attach the file twice',
  (await one(`select count(*)::int n from public.attachments where submission_id = $1`, [gDraft])).n === 1
  && (await one(`select status from public.form_submissions where id = $1`, [gDraft])).status !== 'draft');

// ---------------------------------------------------------------- copy to a new request
await page.goto(`${BASE}/submissions?as=EMP-2847`);
await settle(3000);
await page.locator('input[aria-label="Search submissions"]').fill(s?.ref_number ?? 'none');
await settle(600);
await page.getByRole('button', { name: /^Copy$/ }).first().click();
await page.waitForURL(/\/forms\/.*draft=/, { timeout: 15000 });
await settle(3000);
const copyId = new URL(page.url()).searchParams.get('draft');
const cv = await valuesOf(copyId);
ok('Copy: a new draft is made, linked to the original', copyId && copyId !== submittedId
  && (await one(`select status from public.form_submissions where id = $1`, [copyId]))?.status === 'draft'
  && (await one(`select count(*)::int n from public.submission_links where from_id = $1 and to_id = $2`, [copyId, submittedId])).n === 1);
ok('Copy: ...with the same answers', cv['Leave type'] === 'Sick' && cv['To'] === '2026-12-23' && cv['Reason'] === 'Dentist, then rest', JSON.stringify(cv));
await next();
ok('Copy: ...which the form opens with', (await (await field('Reason')).locator('textarea').inputValue()) === 'Dentist, then rest'
  && (await (await field('Leave type')).locator('select').inputValue()) === 'Sick');
await (await field('From')).locator('input').fill('2027-01-04');
await (await field('To')).locator('input').fill('2027-01-05');
await next();
await settle(1500);
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(2500);
ok('Copy: the copy is submitted as its own request with a new reference',
  page.url().includes(copyId) && (await one(`select ref_number from public.form_submissions where id = $1`, [copyId]))?.ref_number !== s?.ref_number
  && (await valuesOf(submittedId))['From'] === '2026-12-21');

// ---------------------------------------------------------------- an NFA filled from Word
const sample = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/samples/campaign-nfa')).arrayBuffer())));
ok('Word: the sample NFA downloads as a Word file', sample.length > 1000 && sample[0] === 0x50 && sample[1] === 0x4b, `${sample.length} bytes`);
const nfa = await formId('Campaign NFA');
await page.goto(`${BASE}/forms/${nfa}?as=EMP-2847`);
await settle(3000);
await page.locator('input[aria-label="Word document"]').setInputFiles({ name: 'sample-nfa.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(sample) });
await settle(3500);
const found = await page.locator('[data-testid="word-found"]').innerText().catch(() => '');
ok('Word: the document is read and what it found is listed', /business case/i.test(found) && found.includes('Winter Cashback 2026'), found.slice(0, 200));
await page.locator('button[name="word-apply"]').click();
await settle(800);
await next();
const wv = async (label, kind = 'input') => (await field(label)).locator(kind).first().inputValue();
ok('Word: applying fills the campaign name, dates, KPIs and cost',
  (await wv('Campaign name')) === 'Winter Cashback 2026'
  && (await wv('Total cost')).replace(/\D/g, '') === '3800000'
  && /^\d{4}-\d{2}-\d{2}$/.test(await wv('Start date'))
  && Number(await wv('Beneficiary count')) > 0,
  `${await wv('Campaign name')} / ${await wv('Total cost')} / ${await wv('Start date')} / ${await wv('Beneficiary count')}`);
const filled = await page.locator('.placed-field input:not([type="checkbox"]):not([type="file"]), .placed-field textarea').evaluateAll((els) => els.filter((e) => e.value).length);
ok('Word: most of the form is filled from it', filled >= 10, `${filled} inputs filled`);
await page.goto(`${BASE}/forms/${await formId('Travel & Expense Reimbursement')}?as=EMP-2847`);
await settle(3000);
ok('Word: the import is not on a form that is not an NFA or campaign', (await page.locator('[data-testid="word-import"]').count()) === 0);

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA FORMS (DRAFTS) CHECKS PASSED');
process.exit(failures ? 1 : 0);
