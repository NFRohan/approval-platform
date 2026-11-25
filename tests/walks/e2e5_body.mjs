
// ================================================================ Stage 5
import { writeFileSync } from 'node:fs';
const sidebar = async () => page.locator('aside').innerText();
const fetchHead = (href) => page.evaluate(async (h) => {
  const r = await fetch(h);
  const b = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, head: Array.from(b.slice(0, 4)).map((x) => String.fromCharCode(x)).join(''), size: b.length, type: r.headers.get('content-type') };
}, href);
const campaignId = async (name) => (await one(`select id from public.campaigns where tenant_id = $1 and name = $2`, [tenant, name])).id;

// ------------------------------------------------- the campaign tracker
await page.goto(BASE + '/?as=EMP-0416');
await settle(2500);
ok('the campaign manager is offered campaigns', (await sidebar()).includes('Campaigns'));
await page.goto(BASE + '/campaigns?as=EMP-0416');
await settle(3000);
ok('the tracker lists every campaign', (await page.locator('[data-testid="campaign-list"] a').count()) === 7);
const kpiText = await page.locator('[data-testid="campaign-kpis"]').innerText();
ok('...with what is live, its budget and spend, and what needs attention', /Live campaigns\s+3/.test(kpiText) && /At 95% or more\s+1/.test(kpiText), kpiText.replace(/\s+/g, ' '));
ok('...exceptional ones marked', (await page.locator('[data-testid="campaign-list"]').innerText()).includes('Exceptional'));
await shot('s5-campaigns');

const boishakhi = await campaignId('Boishakhi Cashback 2026');
await page.goto(`${BASE}/campaigns/${boishakhi}?as=EMP-0416`);
await settle(3000);
let t = await text();
ok('a campaign at 96% says so, and that its requester was told', /96(\.\d)?% of the budget is spent/.test(t) && /was told on/.test(t));
ok('...draws its spending against budget and the 95% line', (await page.locator('.recharts-surface').count()) === 1);
ok('...and its KPI, target against actual', /Beneficiaries[\s\S]*of[\s\S]*Transactions/.test(await page.locator('[data-testid="campaign-kpi"]').innerText()));
await shot('s5-campaign');

// Recording actuals takes it over budget: told again.
await page.locator('button[name="record-actuals"]').click();
await page.locator('input[name="actual-cost"]').fill('250000');
await page.locator('button[name="save-actuals"]').click();
await settle(3000);
ok('actuals are recorded', (await one(`select count(*)::int n from public.campaign_actuals where campaign_id = $1 and cost = 250000`, [boishakhi])).n === 1);
ok('...and going over budget tells the requester, by email too',
  (await one(`select count(*)::int n from public.email_outbox where tenant_id = $1 and kind = 'campaign.budget' and entity_id = $2`, [tenant, boishakhi])).n >= 1);

// Extending a live campaign: through approvals, then longer.
const merchant = await campaignId('Merchant QR Activation Drive');
const before = await one(`select ends_on, budget from public.campaigns where id = $1`, [merchant]);
await page.goto(`${BASE}/campaigns/${merchant}?as=EMP-0416`);
await settle(3000);
await page.locator('button[name="extend"]').click();
const newEnd = new Date(new Date(before.ends_on).getTime() + 20 * 86400000).toISOString().slice(0, 10);
await page.locator('input[name="extend-end"]').fill(newEnd);
await page.locator('input[name="extend-budget"]').fill('500000');
await page.locator('textarea[name="extend-case"]').fill('Merchants activating faster than planned; extend through the month end.');
await page.locator('button[name="send-extension"]').click();
await settle(3000);
const ext = await one(`select submission_id, status from public.campaign_extensions where campaign_id = $1`, [merchant]);
ok('an extension is asked for, and waits', ext?.status === 'pending' && /waiting for approval/.test(await text()));
ok('...keeping the modality', (await one(`select value from public.submission_values where submission_id = $1 and field_name = 'Modality'`, [ext.submission_id])).value === 'Discount');
for (let i = 0; i < 4; i++) {
  const next = await one(`select approver_user_id from public.approval_requests where submission_id = $1 and status = 'pending' limit 1`, [ext.submission_id]);
  if (!next) break;
  await approveAs(next.approver_user_id, ext.submission_id);
}
const after = await one(`select ends_on, budget from public.campaigns where id = $1`, [merchant]);
ok('once approved, the campaign runs longer with more budget',
  new Date(after.ends_on).toISOString().slice(0, 10) === newEnd && Number(after.budget) === Number(before.budget) + 500000,
  JSON.stringify(after));

// ------------------------------------------------- the reviewer the requester picks
const campaignReq = await formId('Campaign Request');
await page.goto(`${BASE}/forms/${campaignReq}?as=EMP-0416`);
await settle(2500);
for (let i = 0; i < 4 && !(await page.locator('select').count()); i++) {
  await page.getByRole('button', { name: /Next|Continue/ }).first().click().catch(() => {});
  await settle(600);
}
ok('Business Finance reviewers are listed, the one on leave unavailable',
  (await page.locator('[data-reviewer="EMP-0412"] input').isDisabled()) && /On leave until/.test(await page.locator('[data-reviewer="EMP-0412"]').innerText()));
await (await field('Campaign name')).locator('input').fill('Winter Remittance Bonus');
await (await field('Audience')).locator('select').selectOption('Customer');
await (await field('Approval route')).locator('select').selectOption('Regular');
await (await field('Budget')).locator('input').fill('900000');
await (await field('Business case')).locator('textarea').fill('Remittance peaks in winter; a bonus lifts share.');
await page.locator('[data-reviewer="EMP-0411"] input').check();
await page.getByRole('button', { name: /Next|Continue/ }).first().click();
await settle(2500);
ok('the review shows the chosen reviewer', (await text()).includes('Tanvir Hasan'));
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(2000);
const reqSub = page.url().split('/status/')[1].split('?')[0];
ok('Business Finance review goes to the reviewer chosen',
  (await one(`select approver_user_id from public.approval_requests where submission_id = $1 and stage_label = 'Business finance review'`, [reqSub])).approver_user_id === 'EMP-0411');
ok('...and the whole team is copied',
  (await rows(`select employee_id from public.submission_cc where submission_id = $1 order by 1`, [reqSub])).map((r) => r.employee_id).join(',') === 'EMP-0410,EMP-0411,EMP-0412');

// ------------------------------------------------- an NFA from Word, to a campaign
const nfa = await formId('Campaign NFA');
const sample = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/samples/campaign-nfa')).arrayBuffer())));
const samplePath = new URL('./sample-nfa.docx', import.meta.url).pathname.replace(/^\//, '');
writeFileSync(samplePath, Buffer.from(sample));
await page.goto(`${BASE}/forms/${nfa}?as=EMP-0416`);
await settle(2500);
// In memory: an intercepted upload of a file from disk arrives empty in this harness.
await page.locator('input[aria-label="Word document"]').setInputFiles({ name: 'sample-nfa.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(sample) });
await settle(3000);
const found = await page.locator('[data-testid="word-found"]').innerText();
ok('a Word NFA is read, and both its business cases found', /2 business cases/.test(found) && found.includes('Winter Cashback 2026'), found.slice(0, 120));
await shot('s5-word');
await page.locator('button[name="word-apply"]').click();
await settle(800);
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(900);
ok('...and fills the form', (await (await field('Campaign name')).locator('input').inputValue()) === 'Winter Cashback 2026'
  && (await (await field('Total cost')).locator('input').inputValue()).replace(/\D/g, '') === '3800000');
await page.getByRole('button', { name: /^Back/ }).first().click();
await settle(900);
// In memory: an intercepted upload of a file from disk arrives empty in this harness.
await page.locator('input[aria-label="Word document"]').setInputFiles({ name: 'sample-nfa.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(sample) });
await settle(3000);
await page.locator('button[name="word-drafts"]').click();
await settle(3000);
const drafts = await rows(`select s.id, s.ref_number from public.form_submissions s where s.tenant_id = $1 and s.form_template_id = $2 and s.status = 'draft' and s.submitted_by = 'EMP-0416' order by s.submitted_at`, [tenant, nfa]);
ok('...or makes a draft for each business case, linked', drafts.length >= 2
  && (await one(`select count(*)::int n from public.submission_links where from_id = $1 or to_id = $1`, [drafts[drafts.length - 1].id])).n >= 1);
const agentDraft = (await one(`select s.id from public.form_submissions s join public.submission_values v on v.submission_id = s.id
   where s.tenant_id = $1 and v.field_name = 'Campaign name' and v.value = 'Winter Agent Cash-in Boost' and s.status = 'draft'`, [tenant])).id;
ok('...each draft holding its own case', (await one(`select value from public.submission_values where submission_id = $1 and field_name = 'Total cost'`, [agentDraft])).value === '1200000');

// Submit the agent case and approve it: a campaign appears.
await page.goto(`${BASE}/forms/${nfa}?draft=${agentDraft}&as=EMP-0416`);
await settle(3000);
for (let i = 0; i < 6; i++) {
  const next = page.getByRole('button', { name: /Next|Continue/ }).first();
  if (!(await next.count())) break;
  await next.click().catch(() => {});
  await settle(900);
  if (await page.getByRole('button', { name: /Confirm & Submit/ }).count()) break;
}
if (!(await page.getByRole('button', { name: /Confirm & Submit/ }).count())) console.log('DEBUG draft page:', (await text()).slice(0, 1800).replace(/\s+/g, ' '));
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 });
await settle(2000);
for (let i = 0; i < 6; i++) {
  const next = await one(`select approver_user_id from public.approval_requests where submission_id = $1 and status = 'pending' limit 1`, [agentDraft]);
  if (!next) break;
  await approveAs(next.approver_user_id, agentDraft);
}
const made = await one(`select id, status, budget, kpi, wallets from public.campaigns where submission_id = $1`, [agentDraft]);
ok('an approved NFA becomes a tracked campaign, as the Word document said',
  made && Number(made.budget) === 1200000 && made.kpi.transactions === 75000 && made.wallets[0]?.wallet === 'Agent', JSON.stringify(made));
await page.goto(`${BASE}/status/${agentDraft}?as=EMP-0416`);
await settle(2500);
ok('...and its request links to it', (await page.getByRole('link', { name: /Open the campaign/ }).count()) === 1);
const sheet = await fetchHead(`/topsheet/${agentDraft}`);
ok('the payment top sheet prints', sheet.status === 200 && sheet.head === '%PDF', JSON.stringify(sheet));

// ------------------------------------------------- mail to ticket
await page.goto(BASE + '/admin/email?as=EMP-0445');
await settle(2500);
await page.getByRole('tab', { name: 'Inbound' }).click();
await settle(2000);
await page.getByRole('button', { name: /A partner's request/ }).click();
await page.locator('button[name="send-inbound"]').click();
await settle(3500);
const ticket = await one(`select s.id, s.ref_number, s.submitted_by from public.inbound_mail m join public.form_submissions s on s.id = m.submission_id
   where m.tenant_id = $1 and m.outcome = 'ticket' order by m.received_at desc limit 1`, [tenant]);
ok('a partner\'s email becomes a ticket for the telecom team', ticket?.submitted_by === 'EMP-0415'
  && (await live(ticket.id)) === 'EMP-0520', JSON.stringify(ticket));
await approveAs('EMP-0520', ticket.id);
const nfaDraft = await one(`select s.status, s.submitted_by from public.form_submissions s where s.parent_submission_id = $1`, [ticket.id]);
ok('...approving it starts the NFA for the point of contact, preloaded', nfaDraft?.status === 'draft' && nfaDraft.submitted_by === 'EMP-0415'
  && (await one(`select value from public.submission_values v join public.form_submissions s on s.id = v.submission_id where s.parent_submission_id = $1 and v.field_name = 'Partner'`, [ticket.id]))?.value === 'grameenphone.com');
await page.goto(BASE + '/admin/email?as=EMP-0445');
await settle(2500);
await page.getByRole('tab', { name: 'Inbound' }).click();
await settle(2000);
await page.getByRole('button', { name: new RegExp(`A UAT result for ${ticket.ref_number}`) }).click();
await page.locator('button[name="send-inbound"]').click();
await settle(3000);
ok('a UAT result mailed back lands on the ticket',
  (await one(`select count(*)::int n from public.ticket_notes where submission_id = $1 and body like '%UAT passed%'`, [ticket.id])).n === 1);
ok('...and the log shows both', /Ticket raised[\s\S]*Added to ticket|Added to ticket[\s\S]*Ticket raised/.test(await page.locator('[data-testid="inbound-log"]').innerText()));
await shot('s5-inbound');

// ------------------------------------------------- forms by keyword and class
await page.goto(BASE + '/forms?as=EMP-0445');
await settle(2500);
await page.locator('input[aria-label="Find a form"]').fill('capex');
await settle(600);
t = await text();
ok('a form is found by its keyword', t.includes('Capital Expenditure Request') && t.includes('Budgetary'));

// ------------------------------------------------- divisions
await page.goto(BASE + '/admin/people?as=EMP-0650');
await settle(3000);
await page.locator('[data-division="Business Finance"]').getByRole('button', { name: /Merge/ }).click();
await page.locator('select[name="merge-into"]').selectOption('Finance');
await page.locator('button[name="confirm-merge"]').click();
await settle(3000);
ok('merging a division moves its people and what is offered to it',
  (await one(`select count(*)::int n from public.employees where tenant_id = $1 and department = 'Business Finance'`, [tenant])).n === 0
  && !(await one(`select 1 x from public.departments where tenant_id = $1 and name = 'Business Finance'`, [tenant]))
  && (await one(`select audience_departments a from public.form_templates where tenant_id = $1 and name = 'Campaign Extension'`, [tenant])).a.includes('Finance'));

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL STAGE 5 E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
