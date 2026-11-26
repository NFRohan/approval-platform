// ================================================================ QA: every request form, part 2
// The forms L–T (part 1 has A–I), then: calculated and auto-filled
// fields, conditional routes, who each form is offered to, and finding
// forms by keyword and classification on Available Forms.
const PART = ['Leave Application', 'MNO Campaign NFA', 'MNO Campaign Request', 'New Employee Onboarding',
  'New SIM Requisition', 'Night Allowance', 'SIM Transfer', 'Travel & Expense Reimbursement'];

// ---------------------------------------------------------------- helpers (same in part 2)
const toasts = async () => (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
const nameOf = async (id) => (await one(`select name from public.employees where tenant_id = $1 and employee_id = $2`, [tenant, id]))?.name;
const heading = async () => (await page.locator('h2').first().innerText().catch(() => '')).trim();
const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 QA evidence ' + name) });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
// An auto-filled field has no input: its card is the rounded box around the label.
const genBox = (label) => page.getByText(label, { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"rounded-[10px]")][1]');
const deptHead = async (d) => (await one(`select head_employee_id h from public.departments where tenant_id = $1 and name = $2`, [tenant, d]))?.h;

function defaultValue(f) {
  const o = f.field_config?.options ?? [];
  switch (f.field_type) {
    case 'text': return `QA ${f.field_name}`;
    case 'textarea': return `QA ${f.field_name}: written by the walk`;
    case 'email': return 'partner@example.com';
    case 'phone': return '01711000000';
    case 'number': return '3';
    case 'money': return '25000';
    case 'date': return '2026-12-10';
    case 'daterange': return { from: '2026-11-02', to: '2026-11-05' };
    case 'select': return o[0];
    case 'multi_select': return [o[0]];
    case 'checkbox': return true;
    case 'file': return `${slug(f.field_name)}.pdf`;
    case 'employee': return 'EMP-3120';
    case 'reviewer': return 'EMP-0411';
    default: return undefined;
  }
}
// What the answer should be stored as.
function storedAs(f, v) {
  if (f.field_type === 'checkbox') return 'Yes';
  if (f.field_type === 'multi_select' || f.field_type === 'daterange') return JSON.stringify(v);
  return String(v);
}

async function fillField(f, v) {
  const t = f.field_type;
  if (t === 'checkbox') {
    await page.locator('label').filter({ hasText: f.field_name }).locator('input[type="checkbox"]').first().check();
    return;
  }
  if (t === 'reviewer') {
    await page.locator(`[data-reviewer="${v}"] input`).check();
    return;
  }
  const box = await field(f.field_name);
  if (t === 'textarea') await box.locator('textarea').fill(v);
  else if (t === 'number' || t === 'money') await box.locator('input[type="number"]').fill(v);
  else if (t === 'date') await box.locator('input[data-date]').fill(v);
  else if (t === 'daterange') {
    await box.locator('input[data-date]').nth(0).fill(v.from);
    await box.locator('input[data-date]').nth(1).fill(v.to);
  } else if (t === 'select') await box.locator('select').selectOption(v);
  else if (t === 'multi_select') {
    for (const o of v) await box.locator('label').filter({ hasText: o }).locator('input[type="checkbox"]').check();
  } else if (t === 'file') await box.locator('input[type="file"]').setInputFiles(pdf(v));
  else if (t === 'employee') {
    await box.locator('input').first().fill(v);
    await box.locator('input').first().press('Tab');
    await settle(1500);
  } else await box.locator('input').first().fill(v);
}

const NOT_ANSWERED = new Set(['section_header', 'calculation']);
const isEmpStep = (t) => t === 'employee' || t.startsWith('gen_');

/**
 * Raise one form as somebody, through the screens, checking along the way.
 * Returns the submission id, or null if it did not get as far as submitting.
 */
async function raise(name, { as = 'EMP-2847', vals = {}, first = [], expectWord = /NFA|Campaign/.test(name), afterFill } = {}) {
  const id = await formId(name);
  const fields = await rows(`select field_type, field_name, is_required, field_config from public.form_fields
                              where form_template_id = $1 order by order_index`, [id]);
  const errsBefore = pageErrors.length;
  const who = await nameOf(as);

  // Open it from Available Forms, found by name.
  await page.goto(`${BASE}/forms?as=${as}`);
  await settle(3000);
  await page.locator('input[aria-label="Find a form"]').fill(name);
  await settle(600);
  const card = page.locator('div.rounded-xl', { has: page.getByRole('heading', { name, exact: true }) });
  if (!(await card.count())) {
    ok(`${name}: offered on Available Forms to ${who}`, false, (await text()).slice(0, 300));
    return null;
  }
  await card.getByRole('link', { name: /Fill Form/ }).click();
  await page.waitForURL(/\/forms\/[0-9a-f-]{36}/, { timeout: 15000 });
  await settle(3000);
  let t = await text();
  ok(`${name}: opens from Available Forms with its title and steps`, t.includes(name) && /Review & Submit/.test(t) && t.includes(`Submitting as ${who}`), t.slice(0, 300));

  // The Word import is offered on the campaign and NFA forms only.
  const word = await page.locator('input[aria-label="Word document"]').count();
  ok(`${name}: Word import ${expectWord ? 'offered' : 'not offered'}`, expectWord ? word > 0 : word === 0, `inputs: ${word}`);

  const empFields = fields.filter((f) => isEmpStep(f.field_type));
  const mainFields = fields.filter((f) => !isEmpStep(f.field_type) && !f.field_type.startsWith('perm_') && !f.field_type.startsWith('linked_'));
  const answer = {};
  for (const f of fields) {
    if (NOT_ANSWERED.has(f.field_type) || f.field_type.startsWith('gen_')) continue;
    const v = f.field_name in vals ? vals[f.field_name] : defaultValue(f);
    if (v !== undefined) answer[f.field_name] = v;
  }

  // Step 1: who it is for — the auto-filled fields carry the requester.
  if (empFields.length) {
    ok(`${name}: first step is Employee Details`, (await heading()) === 'Employee Details', await heading());
    const gen = empFields.find((f) => f.field_type === 'gen_employee_name');
    if (gen) ok(`${name}: Employee name is auto-filled as ${who}`, (await genBox(gen.field_name).innerText()).includes(who), await genBox(gen.field_name).innerText().catch((e) => String(e)));
    for (const f of empFields.filter((x) => x.field_type === 'employee')) await fillField(f, answer[f.field_name]);
    await page.getByRole('button', { name: /^Next/ }).click();
    await settle(900);
  }

  // Step 2: the details. Next with nothing filled is refused, by name.
  ok(`${name}: reaches the Form Details step`, (await heading()) === 'Form Details', await heading());
  const firstReq = mainFields.find((f) => f.is_required && !NOT_ANSWERED.has(f.field_type));
  if (firstReq) {
    await page.getByRole('button', { name: /^Next/ }).click();
    await settle(700);
    const msg = await toasts();
    ok(`${name}: an empty required field blocks the step with "${firstReq.field_name} is required"`,
      msg.includes(`${firstReq.field_name} is required`) && (await heading()) === 'Form Details', msg);
  }
  for (const f of mainFields) {
    if (!(f.field_name in answer)) continue;
    try { await fillField(f, answer[f.field_name]); }
    catch (e) { ok(`${name}: field "${f.field_name}" (${f.field_type}) can be filled`, false, String(e).slice(0, 200)); }
  }
  if (afterFill) await afterFill();
  await page.getByRole('button', { name: /^Next/ }).click();
  await settle(2500);

  // Step 3: review — the answers and who will approve.
  t = await text();
  if ((await heading()) !== 'Review & Submit') {
    ok(`${name}: a fully filled form reaches Review & Submit`, false, `${await heading()} — ${await toasts()}`);
    return null;
  }
  for (let i = 0; i < 6 && /Working out who will be asked/i.test(await text()); i++) await settle(700);
  t = await text();
  const firstNames = await Promise.all(first.map(nameOf));
  const sample = Object.entries(answer).find(([, v]) => typeof v === 'string' && /^QA /.test(v));
  ok(`${name}: review lists the answers and the first approver`,
    /Your Answers/i.test(t) && (!sample || t.includes(sample[1])) && firstNames.every((n) => t.includes(n)),
    `want ${firstNames.join(', ')}; ${t.slice(t.search(/Who will approve/i), t.search(/Who will approve/i) + 300)}`);

  await page.getByRole('button', { name: /Confirm & Submit/ }).click();
  try { await page.waitForURL(/\/status\//, { timeout: 20000 }); }
  catch {
    ok(`${name}: submits`, false, await toasts());
    return null;
  }
  await settle(3000);
  const sub = page.url().split('/status/')[1].split('?')[0];

  // In the database: the request, every answer, and its chain.
  const s = await one(`select status, ref_number, submitted_by from public.form_submissions where id = $1`, [sub]);
  ok(`${name}: the submission is recorded, submitted by ${who}, with a reference`,
    s && ['submitted', 'in_progress'].includes(s.status) && s.submitted_by === as && /^AMS-\d{4}-\d{5}$/.test(s.ref_number ?? ''), JSON.stringify(s));
  const stored = Object.fromEntries((await rows(`select field_name, value from public.submission_values where submission_id = $1`, [sub])).map((r) => [r.field_name, r.value]));
  const wrong = [];
  for (const f of fields) {
    if (f.field_type === 'section_header') continue;
    let want;
    if (f.field_type === 'gen_employee_name') want = who;
    else if (f.field_type === 'gen_gate_pass') want = (await one(`select gate_pass_card_number c from public.employees where tenant_id = $1 and employee_id = $2`, [tenant, as])).c;
    else if (f.field_type === 'calculation') continue;   // checked where a form has one
    else if (f.field_type === 'employee') {
      if (!String(stored[f.field_name] ?? '').includes(answer[f.field_name])) wrong.push(`${f.field_name}=${stored[f.field_name]}`);
      continue;
    } else if (f.field_name in answer) want = storedAs(f, answer[f.field_name]);
    else continue;
    if (stored[f.field_name] !== want) wrong.push(`${f.field_name}: want ${want}, got ${stored[f.field_name]}`);
  }
  ok(`${name}: every answer is stored as entered (${Object.keys(stored).length} rows)`, wrong.length === 0, wrong.join('; '));
  const files = fields.filter((f) => f.field_type === 'file');
  if (files.length) {
    const att = await rows(`select field_name, file_name from public.attachments where submission_id = $1`, [sub]);
    ok(`${name}: the chosen file is attached`, files.every((f) => att.some((a) => a.field_name === f.field_name && a.file_name === answer[f.field_name])), JSON.stringify(att));
  }
  const chain = await rows(`select approver_user_id, status, step_index from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [sub]);
  const pending = chain.filter((c) => c.status === 'pending').map((c) => c.approver_user_id);
  ok(`${name}: an approval chain is built, first with ${firstNames.join(' + ')}`,
    chain.length > 0 && first.every((p) => pending.includes(p)) && pending.length === first.length,
    `pending: ${pending.join(',')}; chain: ${chain.map((c) => `${c.step_index}:${c.approver_user_id}:${c.status}`).join(' ')}`);

  // The status page, as the requester.
  t = await text();
  ok(`${name}: the status page shows the reference and the first approver, pending`,
    t.includes(s?.ref_number) && firstNames.every((n) => t.includes(n)) && /Pending/.test(t), t.slice(0, 400));
  ok(`${name}: no page errors on the way`, pageErrors.length === errsBefore, pageErrors.slice(errsBefore).join(' | '));
  return sub;
}

// ================================================================ the forms
const asOwner = async (sql, params = []) => {
  await db.exec(`select set_config('app.tenant_id', '${tenant}', false)`);
  return (await db.query(sql, params)).rows;
};
const commercialHead = await deptHead('Commercial');
const placed = (label) => page.getByText(label, { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"placed-field")][1]');
const subs = {};
for (const name of PART) {
  switch (name) {
    case 'Leave Application':
      subs[name] = await raise(name, { first: ['EMP-1134'], vals: { 'Leave type': 'Annual', 'From': '2026-12-14', 'To': '2026-12-16' } });
      break;
    case 'MNO Campaign NFA':
      // Offered to Commercial; the SO configuration step only when the NFA needs it.
      subs[name] = await raise(name, { as: 'EMP-0416', first: [commercialHead],
        vals: { 'NFA type': 'Requires SO configuration', 'Total cost': '600000' } });
      break;
    case 'MNO Campaign Request':
      subs[name] = await raise(name, { as: 'EMP-0416', first: ['EMP-0520'] });
      break;
    case 'New Employee Onboarding':
      subs[name] = await raise(name, { first: ['EMP-0201'], vals: { 'Department': 'Operations' } });
      break;
    case 'Night Allowance':
      subs[name] = await raise(name, { first: ['EMP-1134'],
        vals: { 'Period': { from: '2026-11-02', to: '2026-11-05' }, 'Nights worked': '4', 'Rate per night': '1500' },
        afterFill: async () => {
          ok('Night Allowance: Total allowance computes nights × rate on screen (4 × 1,500 = 6,000)',
            /6,000/.test(await placed('Total allowance').innerText()), await placed('Total allowance').innerText().catch((e) => String(e)));
        } });
      break;
    case 'SIM Transfer':
      subs[name] = await raise(name, { first: ['EMP-1134'], vals: { 'Mobile number': '01711000222', 'Transfer to': 'EMP-3120', 'Reason': 'Role change' } });
      break;
    case 'Travel & Expense Reimbursement':
      subs[name] = await raise(name, { first: ['EMP-1134'], vals: { 'Amount claimed': '42000' } });
      break;
    default:
      subs[name] = await raise(name, { first: ['EMP-1134'] });
  }
}

// ---------------------------------------------------------------- calculated fields
const night = subs['Night Allowance'];
if (night) {
  ok('Night Allowance: the computed total is stored with the request (6000)',
    (await one(`select value from public.submission_values where submission_id = $1 and field_name = 'Total allowance'`, [night]))?.value === '6000');
  // The line manager opens it from his queue and reads the answers, formatted.
  await page.goto(`${BASE}/approvals?as=EMP-1134`);
  await settle(3000);
  const row = page.locator(`#approval-${await stepOf(night, 'EMP-1134')}`);
  await row.getByRole('button').first().click();
  await settle(2000);
  const rt = await row.innerText();
  ok('Night Allowance: the approver sees the total, the period as dates, and the nights',
    /Total allowance\s+6,000/.test(rt) && /Period\s+02\/11\/2026\s+–\s+05\/11\/2026/.test(rt) && /Nights worked\s+4/.test(rt), rt.slice(0, 500));
}
// The review step shows what the calculation came to, not a blank.
await page.goto(`${BASE}/forms/${await formId('Night Allowance')}?as=EMP-2847`);
await settle(3000);
await page.getByRole('button', { name: /^Next/ }).click();
await settle(700);
{
  const box = await field('Period');
  await box.locator('input[data-date]').nth(0).fill('2026-11-10');
  await box.locator('input[data-date]').nth(1).fill('2026-11-12');
  await (await field('Nights worked')).locator('input').fill('2');
  await (await field('Rate per night')).locator('input').fill('1250');
  ok('Night Allowance: the total recomputes as the answers change (2 × 1,250 = 2,500)', /2,500/.test(await placed('Total allowance').innerText()));
  await page.getByRole('button', { name: /^Next/ }).click();
  await settle(2000);
  const rv = await text();
  ok('Night Allowance: the review shows the calculated total', /Total allowance\s+2,?500/.test(rv), rv.slice(rv.indexOf('Total allowance'), rv.indexOf('Total allowance') + 60));
}

// ---------------------------------------------------------------- an employee picker
const simT = subs['SIM Transfer'];
if (simT) {
  const v = Object.fromEntries((await rows(`select field_name, value from public.submission_values where submission_id = $1`, [simT])).map((r) => [r.field_name, r.value]));
  ok('SIM Transfer: the picker finds the person transferred to (Mei Sun, EMP-3120)', /EMP-3120/.test(v['Transfer to'] ?? '') && /Mei Sun/.test(v['Transfer to'] ?? ''), v['Transfer to']);
  ok('SIM Transfer: "Employee name" stays the requester, not the person picked', v['Employee name'] === 'Tom Bexley', v['Employee name']);
}
await page.goto(`${BASE}/forms/${await formId('SIM Transfer')}?as=EMP-2847`);
await settle(3000);
{
  const box = await field('Transfer to');
  await box.locator('input').fill('EMP-0000');
  await box.locator('input').press('Tab');
  await settle(1500);
  await page.getByRole('button', { name: /^Next/ }).click();
  await settle(700);
  ok('SIM Transfer: an employee ID that does not exist is not accepted', (await heading()) === 'Employee Details' && /Transfer to is required/.test(await toasts()), `${await heading()} — ${await toasts()}`);
}

// ---------------------------------------------------------------- conditional routes
const mno = subs['MNO Campaign NFA'];
if (mno) {
  const chain = (await rows(`select approver_user_id, stage_label from public.approval_requests where submission_id = $1 order by step_index`, [mno]));
  ok('MNO Campaign NFA: "Requires SO configuration" adds the SO configuration step (Omar Reyes)',
    chain.some((c) => c.approver_user_id === 'EMP-0520' && c.stage_label === 'SO configuration'), JSON.stringify(chain));
}
await page.goto('about:blank');
await settle(800);
{
  const plan = (await asOwner(`select public.preview_approval_chain($1, 'EMP-0416', '{"NFA type": "Information only", "Total cost": "600000"}'::jsonb) p`, [await formId('MNO Campaign NFA')]))[0].p;
  ok('MNO Campaign NFA: "Information only" has no SO configuration step', !plan.some((p) => p.stage_label === 'SO configuration'), JSON.stringify(plan.map((p) => p.stage_label)));
  const ex = (await asOwner(`select public.preview_approval_chain($1, 'EMP-2847', '{"Approval route": "Exceptional", "Budget": "500000", "Business finance reviewer": "EMP-0411"}'::jsonb) p`, [await formId('Campaign Request')]))[0].p;
  ok('Campaign Request: the Exceptional route goes to the CXO first', ex[0]?.approver === 'EMP-0800' && ex[0]?.stage_label === 'Exceptional approval', JSON.stringify(ex.slice(0, 2)));
  const big = (await asOwner(`select public.preview_approval_chain($1, 'EMP-2847', '{"Amount claimed": "620000"}'::jsonb) p`, [await formId('Travel & Expense Reimbursement')]))[0].p;
  ok('Travel & Expense: a 620,000 claim climbs every finance slab (Raj, Dana, Alex) after the line manager',
    big.map((p) => p.approver).join(',') === 'EMP-1134,EMP-0312,EMP-0600,EMP-0700', big.map((p) => p.approver).join(','));
}
const travel = subs['Travel & Expense Reimbursement'];
if (travel) {
  const chain = (await rows(`select approver_user_id from public.approval_requests where submission_id = $1 order by step_index`, [travel])).map((r) => r.approver_user_id);
  ok('Travel & Expense: a 42,000 claim goes to the line manager then the first finance slab only', chain.join(',') === 'EMP-1134,EMP-0312', chain.join(','));
}

// ---------------------------------------------------------------- who each form is offered to
const offeredTo = async (as, term) => {
  await page.goto(`${BASE}/forms?as=${as}`);
  await settle(3000);
  await page.locator('input[aria-label="Find a form"]').fill(term);
  await settle(600);
  return page.locator('h3').allInnerTexts();
};
let h = await offeredTo('EMP-2847', 'mno');
ok('Audience: the MNO forms (Commercial only) are not offered to Tom in Operations', h.length === 0, h.join(', '));
h = await offeredTo('EMP-0416', 'mno');
ok('Audience: ...but are to Mitu in Commercial', h.includes('MNO Campaign NFA') && h.includes('MNO Campaign Request'), h.join(', '));
h = await offeredTo('EMP-2847', 'extension');
ok('Audience: Campaign Extension (Commercial, Business Finance) is not offered to Tom', !h.includes('Campaign Extension'), h.join(', '));
h = await offeredTo('EMP-0410', 'extension');
ok('Audience: ...but is to Nusrat in Business Finance', h.includes('Campaign Extension'), h.join(', '));
h = await offeredTo('EMP-0201', 'mno');
ok('Audience: a workflow designer sees every form, the MNO ones too', h.includes('MNO Campaign NFA'), h.join(', '));

// Opening one by its address does not get round it: the database refuses.
const mnoReq = await formId('MNO Campaign Request');
const before = (await one(`select count(*)::int n from public.form_submissions where form_template_id = $1 and submitted_by = 'EMP-2847'`, [mnoReq])).n;
await page.goto(`${BASE}/forms/${mnoReq}?as=EMP-2847`);
await settle(3000);
await (await field('Partner')).locator('input').fill('robi.com.bd');
await (await field('Sender')).locator('input').fill('partner@robi.com.bd');
await (await field('Subject')).locator('input').fill('Bundle offer');
await (await field('Request details')).locator('textarea').fill('Joint data bundle.');
await page.getByRole('button', { name: /^Next/ }).click();
await settle(2000);
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await settle(3000);
const after = (await one(`select count(*)::int n from public.form_submissions where form_template_id = $1 and submitted_by = 'EMP-2847'`, [mnoReq])).n;
ok('Audience: raising a form outside your department by its address is refused, with a reason',
  after === before && !/\/status\//.test(page.url()) && /not offered to your department/i.test(await toasts()), `${before}->${after} ${page.url()} ${await toasts()}`);

// ---------------------------------------------------------------- finding forms
const find = async (term, cls = '') => {
  await page.goto(`${BASE}/forms?as=EMP-2847`);
  await settle(3000);
  if (cls) await page.locator('select[aria-label="Classification"]').selectOption(cls);
  if (term) await page.locator('input[aria-label="Find a form"]').fill(term);
  await settle(600);
  return page.locator('h3').allInnerTexts();
};
h = await find('per diem');
ok('Search: "per diem" (a keyword) finds Travel & Expense Reimbursement', h.length === 1 && h[0] === 'Travel & Expense Reimbursement', h.join(', '));
h = await find('shift');
ok('Search: "shift" finds Night Allowance', h.includes('Night Allowance'), h.join(', '));
h = await find('Gift');
ok('Search: part of a name finds the form across tabs', h.includes('Gift & Hospitality Declaration'), h.join(', '));
h = await find('zzqq');
ok('Search: a term that matches nothing says so', h.length === 0 && /No form matches/.test(await text()));
h = await find('', 'budgetary');
ok('Classification: Budgetary on the HR tab lists the two allowances, not leave or onboarding',
  h.includes('Night Allowance') && h.includes('Compensatory Allowance') && !h.includes('Leave Application') && !h.includes('New Employee Onboarding'), h.join(', '));
h = await find('sim', 'operational');
ok('Classification: Operational with "sim" lists both SIM forms', h.includes('New SIM Requisition') && h.includes('SIM Transfer') && h.length === 2, h.join(', '));
h = await find('', 'regulatory');
await page.getByRole('button', { name: 'Finance', exact: true }).click();
await settle(500);
h = await page.locator('h3').allInnerTexts();
ok('Classification: Regulatory on the Finance tab is the fraud transfer alone', h.length === 1 && h[0] === 'Fraud Incident Fund Transfer', h.join(', '));
await page.getByRole('button', { name: 'Commercial', exact: true }).click();
await page.locator('select[aria-label="Classification"]').selectOption('');
await settle(500);
h = await page.locator('h3').allInnerTexts();
ok("Tabs: Tom's Commercial tab has the campaign forms open to everyone and not the MNO ones",
  h.includes('Campaign NFA') && h.includes('Campaign Request') && !h.some((x) => /MNO|Extension/.test(x)), h.join(', '));
h = await find('IT System');
ok('Search: a form with no classification is still found', h.includes('IT System Access Request'), h.join(', '));

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA FORMS (PART 2) CHECKS PASSED');
process.exit(failures ? 1 : 0);
