// ================================================================ QA: the form builder, round trip
// Farah (System administrator) builds a form: fields by import and by
// drag and drop, approvers by stage with a role, a condition and amount
// slabs, a watcher told on approval above an amount; publishes it. Tom
// finds it, raises it; it is approved through the chain; the right
// people were asked and the watcher told. Then: a workflow-settings-only
// user changes deadlines and signatures but not fields or approvers, and
// somebody who cannot design sees the builder read-only.
const toasts = async () => (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
const heading = async () => (await page.locator('h2').first().innerText().catch(() => '')).trim();
const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 QA ' + name) });
const asOwner = async (sql, params = []) => {
  await db.exec(`select set_config('app.tenant_id', '${tenant}', false)`);
  return (await db.query(sql, params)).rows;
};
async function drag(from, to) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 6, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 6, { steps: 20 });
  await settle(300);
  await page.mouse.up();
  await settle(1200);
}
const FORM = 'QA Asset Request';
const templateCount = async () => (await one(`select count(*)::int n from public.form_templates where tenant_id = $1`, [tenant])).n;

// ---------------------------------------------------------------- build
const countBefore = await templateCount();
await page.goto(`${BASE}/builder?as=EMP-0445`);
await settle(4000);
const tpl = (await one(`select id, name, status from public.form_templates where tenant_id = $1 and created_by = 'EMP-0445' order by created_at desc limit 1`, [tenant]));
ok('Builder: a new form starts as a draft owned by its designer', (await templateCount()) === countBefore + 1 && tpl?.status === 'draft', JSON.stringify(tpl));
const tid = tpl?.id;

await page.locator(`input[value="${tpl?.name}"]`).first().fill(FORM);
await page.locator(`input[value="${FORM}"]`).first().press('Tab');
await settle(1200);
ok('Builder: the form is renamed', (await one(`select name from public.form_templates where id = $1`, [tid]))?.name === FORM);

// Several field types at once, from an exported definition.
const definition = {
  version: 1,
  formName: FORM,
  fields: [
    { kind: 'text', label: 'Asset tag', required: true, helper: 'As printed on the label' },
    { kind: 'select', label: 'Site', required: true, helper: '', options: ['Dhaka', 'Chattogram'] },
    { kind: 'number', label: 'Units', required: true, helper: '', validation: { min: 1, max: 10 } },
    { kind: 'money', label: 'Unit cost', required: true, helper: '' },
    { kind: 'calculation', label: 'Line total', required: false, helper: '', formula: '{Units} * {Unit cost}' },
    { kind: 'date', label: 'Needed by', required: true, helper: '' },
    { kind: 'multi_select', label: 'Accessories', required: false, helper: '', options: ['Bag', 'Mouse', 'Dock'] },
    { kind: 'checkbox', label: 'I confirm the asset is for work use', required: true, helper: '' },
    { kind: 'file', label: 'Quotation', required: false, helper: '' },
  ],
};
await page.locator('input[type="file"][accept=".json"]').setInputFiles({ name: 'qa-asset.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)) });
await settle(2500);
ok('Builder: importing a definition places its fields', /Imported 9 fields/.test(await toasts()) && /9 data fields/.test(await text()), await toasts());

// And one more by hand: dragged from the palette onto the canvas, then labelled.
await drag(page.locator('.field-card', { hasText: 'Long Text' }).first(), page.locator('.placed-field', { hasText: 'Quotation' }).first());
const labelInput = page.locator('label', { hasText: 'Field Label' }).locator('input');
await labelInput.fill('Business reason');
await settle(1500);
let ff = await rows(`select field_type, field_name, field_config from public.form_fields where form_template_id = $1 order by order_index`, [tid]);
ok('Builder: a field dragged from the palette is placed, labelled and saved',
  ff.some((f) => f.field_type === 'textarea' && f.field_name === 'Business reason'), ff.map((f) => `${f.field_type}:${f.field_name}`).join(', '));
ok('Builder: every field type is saved with its settings (options, formula, range)',
  ff.length === 10 && ff.find((f) => f.field_name === 'Site')?.field_config?.options?.length === 2
  && ff.find((f) => f.field_name === 'Line total')?.field_config?.formula === '{Units} * {Unit cost}'
  && ff.find((f) => f.field_name === 'Units')?.field_config?.validation?.max === 10, ff.length);
await page.getByRole('button', { name: /Next/ }).click();
await page.waitForURL(/builder\/approvers/, { timeout: 15000 });
await settle(3500);

// ---------------------------------------------------------------- approvers, by stage
let t = await text();
ok('Approvers: the defaults show — the admin officer, and finance by amount since there is a money field',
  /Admin Officer|Farah Haddad/.test(t) && /Finance Approver/.test(t) && /Finance Approval Slabs/.test(t));
await page.getByRole('button', { name: /Add a stage/ }).click();
await page.locator('input[aria-label="Stage 1 name"]').fill('Line review');
await page.locator('[data-stage="0"] select[aria-label="Approver"]').selectOption('role:line_manager');
await page.getByRole('button', { name: /Add a stage/ }).click();
await page.locator('input[aria-label="Stage 2 name"]').fill('Compliance check');
await page.locator('[data-stage="1"] select[aria-label="Approver"]').selectOption('EMP-0830');
await page.locator('[data-stage="1"]').getByRole('button', { name: /Always/ }).click();
await page.locator('[data-stage="1"] select[aria-label="Condition question"]').selectOption('Site');
await page.locator('[data-stage="1"] select[aria-label="Condition operator"]').selectOption('eq');
await page.locator('[data-stage="1"] input[aria-label="Condition value"]').fill('Chattogram');
await page.locator('select[aria-label="Classification"]').selectOption('operational');
await page.locator('input[aria-label="Keywords"]').fill('asset, qa-roundtrip');
await page.getByRole('button', { name: /Next/ }).click();
await page.waitForURL(/builder\/notifications/, { timeout: 15000 });
await settle(3500);
const rules = await rows(`select step_index, label, approver_user_id, stage_label, condition from public.approval_rules where form_template_id = $1 order by step_index, position`, [tid]);
ok('Approvers: saved in order — admin, finance slabs, the line manager stage, the conditional compliance stage',
  rules.map((r) => r.label).join(',') === 'admin,slab_finance,line_manager,Manually added'
  && rules[2]?.stage_label === 'Line review' && rules[3]?.approver_user_id === 'EMP-0830'
  && rules[3]?.condition?.field === 'Site' && rules[3]?.condition?.value === 'Chattogram',
  JSON.stringify(rules));
const slabs = await rows(`select min_amount::numeric::text m, approver_user_id from public.approval_slabs where form_template_id = $1 order by order_index`, [tid]);
ok('Approvers: the amount slabs are saved (Raj from 0, Dana above 100,000, Alex above 500,000)',
  slabs.map((s) => s.approver_user_id).join(',') === 'EMP-0312,EMP-0600,EMP-0700', JSON.stringify(slabs));
const meta = await one(`select classification, keywords from public.form_templates where id = $1`, [tid]);
ok('Approvers: classification and keywords are saved', meta?.classification === 'operational' && meta?.keywords?.includes('qa-roundtrip'), JSON.stringify(meta));

// ---------------------------------------------------------------- a watcher, told on approval above an amount
await page.getByRole('button', { name: /Add Person/ }).click();
await settle(500);
await page.locator('section', { hasText: 'Additional people to notify' }).locator('select').first().selectOption('EMP-0700');
await settle(500);
const w = page.locator('[data-watcher="EMP-0700"]');
await w.getByLabel(/: Raised$/).uncheck();
await w.getByLabel(/: Approved$/).check();
await w.getByRole('button', { name: /Always/ }).click();
await w.getByLabel(/condition field$/).selectOption('Unit cost');
await w.getByLabel(/: condition$/).selectOption('gt');
await w.getByLabel(/condition value$/).fill('20000');
// SOW 2.1 "including approvers supervisor": the approver's line manager, told of a rejection.
await page.getByRole('button', { name: /Add Person/ }).click();
await settle(500);
await page.locator('section', { hasText: 'Additional people to notify' }).getByLabel('Who').last().selectOption('role:approver_manager');
await settle(500);
const am = page.locator('[data-watcher="role:approver_manager"]');
await am.getByLabel(/: Raised$/).uncheck();
await am.getByLabel(/: Rejected$/).check();
await page.getByRole('button', { name: /Publish Form/ }).click();
await page.waitForURL((u) => u.pathname === '/forms', { timeout: 15000 });
await settle(2500);
const watch = await one(`select events, condition from public.notification_rules where form_template_id = $1 and notifyee_user_id = 'EMP-0700' and not is_auto_added`, [tid]);
ok('Notifications: the watcher is saved — told on approval, only above 20,000',
  JSON.stringify(watch?.events) === '["approved"]' && watch?.condition?.field === 'Unit cost' && watch?.condition?.op === 'gt' && watch?.condition?.value === '20000', JSON.stringify(watch));
const amRule = await one(`select notifyee_user_id, events from public.notification_rules where form_template_id = $1 and label = 'approver_manager' and not is_auto_added`, [tid]);
ok("Notifications: the approver's line manager is saved as a role watcher, told on rejection",
  amRule && amRule.notifyee_user_id === null && JSON.stringify(amRule.events) === '["rejected"]', JSON.stringify(amRule));
await page.goto(`${BASE}/builder/notifications?templateId=${tid}&as=EMP-0445`);
await settle(3500);
ok("Notifications: ...and shows again when the form is reopened",
  (await page.locator('[data-watcher="role:approver_manager"]').count()) === 1
  && /The approver's line manager/.test(await page.locator('[data-testid="notify-when"]').innerText()));
ok('Publish: the form is published', (await one(`select status from public.form_templates where id = $1`, [tid]))?.status === 'published');

// ---------------------------------------------------------------- Tom finds it and raises it
await page.goto(`${BASE}/forms?as=EMP-2847`);
await settle(3000);
await page.locator('input[aria-label="Find a form"]').fill('qa-roundtrip');
await settle(600);
const card = page.locator('div.rounded-xl', { has: page.getByRole('heading', { name: FORM, exact: true }) });
ok('Raise: Tom finds the new form by its keyword, marked Operational', (await card.count()) === 1 && /Operational/.test(await card.innerText()));
await card.getByRole('link', { name: /Fill Form/ }).click();
await page.waitForURL(/\/forms\/[0-9a-f-]{36}/, { timeout: 15000 });
await settle(3000);
t = await text();
ok('Raise: it opens on its details, every field rendered', (await heading()) === 'Form Details'
  && ['Asset tag', 'Site', 'Units', 'Unit cost', 'Line total', 'Needed by', 'Accessories', 'I confirm the asset is for work use', 'Quotation', 'Business reason'].every((l) => t.includes(l)), t.slice(0, 600));
await page.getByRole('button', { name: /^Next/ }).click();
await settle(700);
ok('Raise: an empty required field blocks the step', /Asset tag is required/.test(await toasts()), await toasts());
await (await field('Asset tag')).locator('input').fill('AT-0042');
await (await field('Site')).locator('select').selectOption('Chattogram');
await (await field('Units')).locator('input').fill('12');
await (await field('Unit cost')).locator('input').fill('30000');
await (await field('Needed by')).locator('input').fill('2026-12-15');
await (await field('Accessories')).locator('label').filter({ hasText: 'Mouse' }).locator('input').check();
await page.locator('label').filter({ hasText: 'I confirm the asset is for work use' }).locator('input[type="checkbox"]').check();
await (await field('Quotation')).locator('input[type="file"]').setInputFiles(pdf('asset-quote.pdf'));
await (await field('Business reason')).locator('textarea').fill('Replacement for a failed laptop');
await page.getByRole('button', { name: /^Next/ }).click();
await settle(900);
ok('Raise: the range set in the builder is enforced (12 units, at most 10)',
  (await heading()) === 'Form Details' && /Units must be at most 10/.test(await toasts()), `${await heading()} — ${await toasts()}`);
if ((await heading()) !== 'Form Details') { await page.getByRole('button', { name: /^Back/ }).click(); await settle(700); }
await (await field('Units')).locator('input').fill('2');
const calc = await page.getByText('Line total', { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"placed-field")][1]').innerText();
ok('Raise: the calculated Line total is 2 × 30,000 = 60,000', /60,000/.test(calc), calc);
await page.getByRole('button', { name: /^Next/ }).click();
await settle(2500);
t = await text();
ok('Raise: the review names everybody who will approve: Farah, Raj, Sam, Lena',
  ['Farah Haddad', 'Raj Patel', 'Sam Lindqvist', 'Lena Ortiz'].every((n) => t.includes(n)), t.slice(t.search(/Who will approve/i), t.search(/Who will approve/i) + 400));
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(3000);
const sub = page.url().split('/status/')[1].split('?')[0];
const chainOf = async () => (await rows(`select approver_user_id, status from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [sub]));
let chain = await chainOf();
ok('Raise: the chain is admin → first finance slab (30,000) → line manager → compliance (Chattogram)',
  chain.map((c) => c.approver_user_id).join(',') === 'EMP-0445,EMP-0312,EMP-1134,EMP-0830' && chain[0].status === 'pending',
  chain.map((c) => `${c.approver_user_id}:${c.status}`).join(' '));
const vals = Object.fromEntries((await rows(`select field_name, value from public.submission_values where submission_id = $1`, [sub])).map((r) => [r.field_name, r.value]));
ok('Raise: the answers are stored, the calculated total too',
  vals['Asset tag'] === 'AT-0042' && vals['Units'] === '2' && vals['Accessories'] === '["Mouse"]' && vals['I confirm the asset is for work use'] === 'Yes'
  && vals['Business reason'] === 'Replacement for a failed laptop' && vals['Line total'] === '60000', JSON.stringify(vals));
ok('Raise: the watcher who asked only for approvals is not told it was raised',
  (await one(`select count(*)::int n from public.notifications where entity_id = $1 and recipient_id = 'EMP-0700'`, [sub])).n === 0,
  JSON.stringify(await rows(`select kind, title from public.notifications where entity_id = $1 and recipient_id = 'EMP-0700'`, [sub])));

// ---------------------------------------------------------------- approved through the chain
for (const who of ['EMP-0445', 'EMP-0312', 'EMP-1134', 'EMP-0830']) {
  const live = (await chainOf()).filter((c) => c.status === 'pending').map((c) => c.approver_user_id);
  ok(`Approve: it is ${who}'s turn`, live.length === 1 && live[0] === who, live.join(','));
  await approveAs(who, sub);
}
chain = await chainOf();
ok('Approve: every step approved, the request completed',
  chain.every((c) => c.status === 'approved') && (await one(`select status from public.form_submissions where id = $1`, [sub]))?.status === 'completed',
  chain.map((c) => `${c.approver_user_id}:${c.status}`).join(' '));
ok('Notify: the watcher is told it was approved',
  (await one(`select count(*)::int n from public.notifications where entity_id = $1 and recipient_id = 'EMP-0700' and kind = 'watch.approved'`, [sub])).n === 1);
await page.goto(`${BASE}/status/${sub}?as=EMP-2847`);
await settle(3000);
ok('Status: Tom sees it completed', /Completed/i.test(await text()));

// The routes the builder set, for other answers: Dhaka skips compliance; a big amount climbs every slab.
await page.goto('about:blank');
await settle(800);
const plan = (await asOwner(`select public.preview_approval_chain($1, 'EMP-2847', '{"Site": "Dhaka", "Unit cost": "600000", "Units": "1"}'::jsonb) p`, [tid]))[0].p;
ok('Routes: Dhaka skips compliance; 600,000 climbs Raj, Dana and Alex',
  plan.map((p) => p.approver).join(',') === 'EMP-0445,EMP-0312,EMP-0600,EMP-0700,EMP-1134', plan.map((p) => p.approver).join(','));

// ---------------------------------------------------------------- task settings only
const rulesBefore = await rows(`select id, approver_user_id, label, condition from public.approval_rules where form_template_id = $1 order by step_index, position`, [tid]);
const fieldsBefore = await rows(`select id, field_name, is_required from public.form_fields where form_template_id = $1 order by order_index`, [tid]);
await page.goto(`${BASE}/builder/approvers?templateId=${tid}&as=EMP-0312`);
await settle(3500);
ok('Settings-only: the builder says only task settings can change', /task settings/i.test(await page.locator('[data-testid="builder-access"]').innerText()));
await page.locator('[data-stage="1"] input[aria-label="Working days to respond"]').fill('2');
await page.locator('[data-stage="1"] input[aria-label="Signature required"]').check();
// Trying to change who approves as well.
await page.locator('[data-stage="1"] select[aria-label="Approver"]').selectOption('EMP-0831').catch(() => {});
await page.getByRole('button', { name: /Save task settings/ }).click();
await settle(2500);
const rulesAfter = await rows(`select id, approver_user_id, label, condition, deadline_days, require_signature from public.approval_rules where form_template_id = $1 order by step_index, position`, [tid]);
ok('Settings-only: the deadline and signature are saved', rulesAfter[3]?.deadline_days === 2 && rulesAfter[3]?.require_signature === true, JSON.stringify(rulesAfter[3]));
ok('Settings-only: who approves is unchanged', JSON.stringify(rulesBefore.map((r) => [r.id, r.approver_user_id, r.label])) === JSON.stringify(rulesAfter.map((r) => [r.id, r.approver_user_id, r.label])),
  JSON.stringify(rulesAfter.map((r) => r.approver_user_id)));
await page.goto(`${BASE}/builder?templateId=${tid}&as=EMP-0312`);
await settle(3500);
await page.locator('.placed-field', { hasText: 'Asset tag' }).first().click();
await settle(500);
const lbl = page.locator('label', { hasText: 'Field Label' }).locator('input');
const editable = (await lbl.count()) > 0 && await lbl.isEditable();
ok('Settings-only: a field\'s label cannot be edited', !editable, `label input editable: ${editable}`);
if (editable) { await lbl.fill('Asset tag (changed)'); await settle(1200); }
await drag(page.locator('.field-card', { hasText: 'Number' }).first(), page.locator('.placed-field', { hasText: 'Quotation' }).first());
ok('Settings-only: dragging a new field in is refused, and says why', /Workflow designer role/.test(await toasts()), await toasts());
const fieldsAfter = await rows(`select id, field_name, is_required from public.form_fields where form_template_id = $1 order by order_index`, [tid]);
ok('Settings-only: the fields are unchanged in the database', JSON.stringify(fieldsBefore) === JSON.stringify(fieldsAfter));

// ---------------------------------------------------------------- read-only for somebody who cannot design
const count2 = await templateCount();
await page.goto(`${BASE}/builder?as=EMP-2847`);
await settle(3500);
ok('Read-only: opening the builder offers a list of workflows to look at, and makes no new form',
  (await page.locator('[data-testid="workflow-picker"]').count()) === 1 && /Choose a workflow to look at/.test(await text()) && (await templateCount()) === count2);
await page.locator('[data-testid="workflow-picker"] a', { hasText: FORM }).click();
await settle(3500);
ok('Read-only: the workflow opens with a banner saying it is view-only', /viewing this workflow/i.test(await page.locator('[data-testid="builder-access"]').innerText()));
await page.locator('.placed-field', { hasText: 'Asset tag' }).first().click();
await settle(500);
const lbl2 = page.locator('label', { hasText: 'Field Label' }).locator('input');
const editable2 = (await lbl2.count()) > 0 && await lbl2.isEditable();
ok('Read-only: field settings cannot be typed into', !editable2, `label input editable: ${editable2}`);
await page.goto(`${BASE}/builder/approvers?templateId=${tid}&as=EMP-2847`);
await settle(3500);
const sel = page.locator('[data-stage="0"] select[aria-label="Approver"]');
ok('Read-only: approvers cannot be changed', (await sel.count()) === 1 && !(await sel.isEnabled()), `approver select enabled: ${await sel.isEnabled().catch(() => 'n/a')}`);
await page.getByRole('button', { name: /Next/ }).click();
await page.waitForURL(/builder\/notifications/, { timeout: 15000 });
await settle(3000);
ok('Read-only: the last step offers Done, not Publish', (await page.getByRole('button', { name: /^Done$/ }).count()) === 1 && (await page.getByRole('button', { name: /Publish Form/ }).count()) === 0);
const rulesFinal = await rows(`select id, approver_user_id, label from public.approval_rules where form_template_id = $1 order by step_index, position`, [tid]);
ok('Read-only: walking through it changed nothing', JSON.stringify(rulesFinal.map((r) => [r.id, r.approver_user_id, r.label])) === JSON.stringify(rulesAfter.map((r) => [r.id, r.approver_user_id, r.label])));

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA BUILDER CHECKS PASSED');
process.exit(failures ? 1 : 0);
