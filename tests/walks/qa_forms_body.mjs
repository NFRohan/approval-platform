// ================================================================ QA: every request form, part 1
// For each published form: open it from Available Forms, see it render,
// see a required field block the step with a clear message, fill every
// field type it has, walk the wizard, review, submit; then check the
// submission, its answers and its chain in the database, and that the
// status page shows the reference and the first approver.
//
// Part 1 takes the forms A–G; qa_forms2_body.mjs the rest.
const PART = ['Campaign Extension', 'Campaign NFA', 'Campaign Request', 'Capital Expenditure Request',
  'Compensatory Allowance', 'Employee Exit Clearance', 'Fraud Incident Fund Transfer', 'Gate Pass',
  'Gift & Hospitality Declaration', 'IT System Access Request'];

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
const opsHead = await deptHead('Operations');
for (const name of PART) {
  switch (name) {
    case 'Campaign Extension':
      // Offered to Commercial and Business Finance: raised by the campaign manager.
      await raise(name, { as: 'EMP-0416', first: ['EMP-0410'],
        vals: { 'Approval route': 'Regular', 'Current end date': '2026-12-31', 'New end date': '2027-01-31', 'Additional budget': '150000' } });
      break;
    case 'Campaign NFA':
      await raise(name, { first: ['EMP-1134'],
        vals: { 'Start date': '2026-12-01', 'End date': '2026-12-31', 'Beneficiary count': '1000', 'Transaction count': '5000',
          'Transaction volume': '2000000', 'bKash cost': '400000', 'Total cost': '800000', 'Wallet': ['Customer', 'Agent'],
          'Wallet-wise budget': 'Customer: 500,000\nAgent: 300,000' } });
      break;
    case 'Campaign Request':
      // Regular route: the CXO's exceptional step is skipped; the reviewer chosen is first.
      await raise(name, { first: ['EMP-0411'], vals: { 'Approval route': 'Regular', 'Budget': '500000' } });
      break;
    case 'Capital Expenditure Request':
      await raise(name, { first: ['EMP-1134'], vals: { 'Classification': 'Budgetary', 'Amount': '300000',
        'PO lines': 'PO-1001 | Laptops | 300000' } });
      break;
    case 'Employee Exit Clearance': {
      // Every division clears at once: Tom's own line first, and Finance, SCM, Admin and Technology alongside.
      const sub = await raise(name, { first: ['EMP-1134', 'EMP-0312', 'EMP-3120', 'EMP-0445', 'EMP-0520'],
        vals: { 'Resignation date': '2026-11-20', 'Last working day': '2026-12-20', 'Reason for leaving': 'Resignation' },
        afterFill: async () => {
          // A required confirmation ticked and then unticked is not an answer.
          const confirm = page.locator('label').filter({ hasText: 'I confirm all company assets' }).locator('input[type="checkbox"]');
          await confirm.uncheck();
          await page.getByRole('button', { name: /^Next/ }).click();
          await settle(800);
          ok('Employee Exit Clearance: an unticked required confirmation blocks the step',
            (await heading()) === 'Form Details' && /I confirm all company assets.*is required/.test(await toasts()), `${await heading()} — ${await toasts()}`);
          if ((await heading()) !== 'Form Details') await page.getByRole('button', { name: /^Back/ }).click();
          await settle(600);
          await confirm.check();
        } });
      void sub;
      break;
    }
    case 'Gate Pass': {
      // The card number is auto-filled from the requester's record.
      await page.goto(`${BASE}/forms/${await formId(name)}?as=EMP-2847`);
      await settle(3000);
      ok('Gate Pass: the gate pass card is auto-filled from Tom\'s record', (await genBox('Gate pass card').innerText()).includes('CARD-2847'));
      await raise(name, { first: ['EMP-0445'], vals: { 'Pass type': 'Returnable', 'Quantity': '2', 'Expected return': '2026-12-12' } });
      break;
    }
    case 'Gift & Hospitality Declaration':
      await raise(name, { first: ['EMP-1134'], vals: { 'Value': '30000' } });
      break;
    default:
      await raise(name, { first: ['EMP-1134'] });
  }
}
void opsHead;

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA FORMS (PART 1) CHECKS PASSED');
process.exit(failures ? 1 : 0);
