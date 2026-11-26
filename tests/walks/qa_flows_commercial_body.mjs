// ================================================================ QA flows 3: the commercial chain, through the UI
// Mitu asks for a campaign on the exceptional route with Tanvir as her
// Business Finance reviewer; the CXO, Tanvir and her head approve; the
// NFA is started for her preloaded; approved, it becomes a tracked
// campaign; spend past 95% tells her; she extends it. Then a partner's
// mail becomes an MNO ticket, its NFA, SO configuration and a UAT reply.
const go = async (path, who, ms = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${who}`); await settle(ms); };
const blank = async () => { await page.goto('about:blank'); await settle(800); };
const openStep = async (sub, who) => (await one(
  `select id from public.approval_requests where submission_id = $1 and approver_user_id = $2 and status in ('pending', 'clarification')
    order by step_index, lane, lane_step limit 1`, [sub, who]))?.id;
const status = async (id) => (await one(`select status from public.approval_requests where id = $1`, [id]))?.status;
const subStatus = async (sub) => (await one(`select status from public.form_submissions where id = $1`, [sub]))?.status;
const told = async (who, kind, entity) => (await one(
  `select count(*)::int n from public.notifications where recipient_id = $1 and kind = $2 and entity_id = $3`, [who, kind, entity])).n;
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
async function queueRow(who, sub) {
  const id = await openStep(sub, who);
  await go('/approvals', who, 3000);
  return { id, row: page.locator(`#approval-${id}`) };
}
async function approveIn(who, sub, label) {
  const { id, row } = await queueRow(who, sub);
  if (!id || !(await row.count())) { ok(`${label}: in ${who}'s queue`, false, `step ${id}`); return false; }
  await row.getByRole('button', { name: /^Approve$/ }).click();
  await settle(2500);
  const st = await status(id);
  ok(`${label}: ${who} approves from the queue`, st === 'approved', `${st}; ${(await text()).slice(0, 200)}`);
  return st === 'approved';
}
// Whoever is next, until nobody is: each from their own queue.
async function approveRest(sub, label, max = 6) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    const next = (await live(sub)).split(',').filter(Boolean)[0];
    if (!next) break;
    seen.push(next);
    if (!(await approveIn(next, sub, `${label} (${i + 1})`))) break;
  }
  return seen;
}
async function nextTo(re, max = 5) {
  for (let i = 0; i < max && !(await re()); i++) {
    await page.getByRole('button', { name: /^Next/ }).first().click().catch(() => {});
    await settle(800);
  }
}
const whoPanel = async () => { const b = await text(); return b.slice(b.search(/Who will approve/i)); };

// ================================================================ the campaign request
const reqForm = await formId('Campaign Request');
await go(`/forms/${reqForm}`, 'EMP-0416', 3000);
await nextTo(async () => (await page.locator('[data-reviewer]').count()) > 0);
await (await field('Campaign name')).locator('input').fill('Winter Wallet Cashback QA');
await (await field('Audience')).locator('select').selectOption('Customer');
await (await field('Approval route')).locator('select').selectOption('Regular');
await (await field('Budget')).locator('input').fill('800000');
await (await field('Business case')).locator('textarea').fill('Wallet top-ups dip in winter; a 5% cashback lifts them.');
await page.locator('[data-reviewer="EMP-0411"] input').check();
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(3500);
let who = await whoPanel();
ok('campaign review (regular): no CXO first — Business Finance (Tanvir) then the head',
  // Hana Kim is the COO and also the Commercial department's head, so she
  // is on the regular route — second, as the head, never first.
  !/Exceptional approval/.test(who) && who.includes('Tanvir Hasan')
  && (!who.includes('Hana Kim') || who.indexOf('Tanvir Hasan') < who.indexOf('Hana Kim')), who.slice(0, 400));
await page.getByRole('button', { name: /^Back/ }).first().click();
await settle(900);
await (await field('Approval route')).locator('select').selectOption('Exceptional');
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(3500);
who = await whoPanel();
ok('campaign review (exceptional): the CXO approves first, then Tanvir',
  /Exceptional approval/.test(who) && who.includes('Hana Kim') && who.indexOf('Hana Kim') < who.indexOf('Tanvir Hasan'), who.slice(0, 400));
await shot('qa-campaign-review');
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 }).catch(() => {});
await settle(2500);
const reqSub = page.url().includes('/status/') ? page.url().split('/status/')[1].split('?')[0] : null;
ok('campaign request: submitted', !!reqSub, page.url());
const reqChain = await rows(`select id, approver_user_id a, stage_label st, remind_hours rh, status from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [reqSub]);
ok('campaign request: CXO (exceptional) > Tanvir (BF review) > head of department',
  reqChain[0]?.a === 'EMP-0800' && reqChain[0]?.st === 'Exceptional approval' && reqChain[1]?.a === 'EMP-0411' && reqChain[1]?.st === 'Business finance review' && reqChain.length === 3,
  reqChain.map((c) => `${c.a}:${c.st}`).join(' > '));
ok('campaign request: flagged exceptional', (await one(`select flag from public.form_submissions where id = $1`, [reqSub]))?.flag === 'Exceptional');
ok('campaign request: the BF review reminds every 12 hours', reqChain[1]?.rh === 12, String(reqChain[1]?.rh));
ok('campaign request: the Business Finance team is copied', (await rows(`select employee_id from public.submission_cc where submission_id = $1 order by 1`, [reqSub])).map((r) => r.employee_id).includes('EMP-0410'));
let q = await queueRow('EMP-0800', reqSub);
ok('campaign request: Hana\'s queue marks it Exceptional', /Exceptional/.test(await q.row.innerText().catch(() => '')));

// Three days pass with the CXO; then she approves. The BF reviewer's two
// working days start when it reaches him, not when it was raised.
await blank();
await db.query(`update public.approval_requests set created_at = created_at - interval '3 days', deadline_at = deadline_at - interval '3 days',
                  opened_at = opened_at - interval '3 days' where submission_id = $1`, [reqSub]);
await db.query(`update public.form_submissions set submitted_at = submitted_at - interval '3 days' where id = $1`, [reqSub]);
await approveIn('EMP-0800', reqSub, 'campaign request: CXO (Hana)');
const bf = await one(`select id, status, deadline_at, opened_at, app.add_working_days(opened_at, 2, tenant_id) want,
                        deadline_at > now() not_due from public.approval_requests where submission_id = $1 and stage_label = 'Business finance review'`, [reqSub]);
ok('BF review: opens with Tanvir', bf?.status === 'pending', JSON.stringify(bf));
ok('BF review: Tanvir gets two working days from when it reached him',
  bf && bf.not_due && Math.abs(new Date(bf.deadline_at) - new Date(bf.want)) < 3600000,
  `deadline ${bf?.deadline_at?.toISOString?.()} vs opened+2 working days ${bf?.want?.toISOString?.()} — the deadline was fixed when the request was raised`);
q = await queueRow('EMP-0411', reqSub);
ok('BF review: it is not marked overdue the moment it reaches him', (await q.row.count()) === 1 && !/Overdue/.test(await q.row.innerText()), (await q.row.innerText().catch(() => '')).slice(0, 300));

// Half a day later the reminder round runs: Tanvir is reminded, once.
await blank();
await db.query(`update public.approval_requests set opened_at = now() - interval '13 hours' where id = $1`, [bf.id]);
process.env.CRON_SECRET = 'qa-flows-cron-secret-0123456789';
const cron = async () => (await server.fetch(new Request(`${BASE}/cron/reminders`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))).status;
const c1 = await cron();
const rem = await rows(`select body from public.notifications where recipient_id = 'EMP-0411' and kind = 'approval.reminder' and entity_id = $1`, [reqSub]);
ok('BF review: 12 hours on, Tanvir is reminded, and told it comes every 12 hours', c1 === 200 && rem.length === 1 && /every 12 hours/.test(rem[0].body), `${c1} ${JSON.stringify(rem)}`);
await cron();
ok('BF review: ...and not again until another 12 hours have passed',
  (await one(`select count(*)::int n from public.notifications where recipient_id = 'EMP-0411' and kind = 'approval.reminder' and entity_id = $1`, [reqSub])).n === 1);

await approveIn('EMP-0411', reqSub, 'BF review: Tanvir');
const rest = await approveRest(reqSub, 'campaign request: head of department');
ok('campaign request: approved once the head has', (await subStatus(reqSub)) === 'completed', `${await subStatus(reqSub)} after ${rest.join(',')}`);

// ---------------------------------------------------------------- the NFA, started for her
const nfaDraft = await one(`select s.id, s.status, s.submitted_by, t.name from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
  where s.parent_submission_id = $1`, [reqSub]);
ok('NFA: a Campaign NFA draft is started for Mitu', nfaDraft?.name === 'Campaign NFA' && nfaDraft.status === 'draft' && nfaDraft.submitted_by === 'EMP-0416', JSON.stringify(nfaDraft));
ok('NFA: Mitu is told it is ready', (await told('EMP-0416', 'request.followup', nfaDraft?.id)) === 1);
await go(`/status/${nfaDraft.id}`, 'EMP-0416', 3500);
ok('NFA: its page says it was started with the details filled in', /This is still a draft/.test(await text()) && /started for you with the details already filled in/.test(await text()));
await page.getByText('This is still a draft').click();
await settle(3500);
await nextTo(async () => (await page.getByText('Campaign name', { exact: true }).count()) > 0 && (await page.getByText('Modality', { exact: true }).count()) > 0);
ok('NFA: preloaded with the campaign name and audience from the request',
  (await (await field('Campaign name')).locator('input').inputValue()) === 'Winter Wallet Cashback QA'
  && (await (await field('Audience')).locator('select').inputValue()) === 'Customer');
await (await field('Modality')).locator('select').selectOption('Cashback');
await (await field('Start date')).locator('input[data-date]').fill(iso(-3));
await (await field('End date')).locator('input[data-date]').fill(iso(27));
await (await field('Beneficiary count')).locator('input').fill('50000');
await (await field('Transaction count')).locator('input').fill('120000');
await (await field('Transaction volume')).locator('input').fill('60000000');
await (await field('bKash cost')).locator('input').fill('800000');
await (await field('Total cost')).locator('input').fill('800000');
await (await field('Wallet')).locator('label', { hasText: /^Customer$/ }).locator('input').check();
await (await field('Wallet-wise budget')).locator('textarea').fill('Customer: 800,000');
await (await field('Cost center')).locator('input').fill('CC-4410');
await (await field('GL code')).locator('input').fill('5120-01');
await (await field('Product')).locator('input').fill('Add Money');
await (await field('Campaign beneficiary')).locator('input').fill('Customers');
await nextTo(async () => (await page.getByRole('button', { name: /Confirm & Submit/ }).count()) > 0);
await settle(2500);
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 }).catch(() => {});
await settle(2500);
ok('NFA: Mitu submits the same draft, not a second request', (await subStatus(nfaDraft.id)) !== 'draft'
  && (await one(`select count(*)::int n from public.form_submissions where parent_submission_id = $1`, [reqSub])).n === 1, await subStatus(nfaDraft.id));
const nfaApprovers = await approveRest(nfaDraft.id, 'NFA');
ok('NFA: 800,000 needs the line manager and Finance only', nfaApprovers.includes('EMP-0312') && !nfaApprovers.includes('EMP-0600'), nfaApprovers.join(','));
ok('NFA: approved', (await subStatus(nfaDraft.id)) === 'completed');

// ---------------------------------------------------------------- the campaign
const camp = await one(`select id, status, budget, kpi, wallets, exceptional, reviewer_id, requester_id, request_id from public.campaigns where submission_id = $1`, [nfaDraft.id]);
ok('campaign: created from the NFA, live, with its budget and KPIs',
  camp && camp.status === 'ongoing' && Number(camp.budget) === 800000 && camp.kpi?.beneficiaries === 50000 && camp.kpi?.transactions === 120000, JSON.stringify(camp));
ok('campaign: it remembers the exceptional route, the request and Tanvir as reviewer',
  camp?.exceptional === true && camp.request_id === reqSub && camp.reviewer_id === 'EMP-0411', JSON.stringify(camp));
ok('campaign: Mitu is told it is tracked', (await told('EMP-0416', 'campaign.created', camp?.id)) === 1);
await go(`/campaigns/${camp.id}`, 'EMP-0416', 3500);
let t = await text();
ok('campaign page: name, live status, KPI target', (await page.locator('[data-testid="campaign-name"]').innerText()) === 'Winter Wallet Cashback QA'
  && /Beneficiaries/.test(await page.locator('[data-testid="campaign-kpi"]').innerText()), t.slice(0, 300));

// Actuals: 62.5% says nothing; 96% tells her.
async function actuals(cost) {
  await go(`/campaigns/${camp.id}`, 'EMP-0416', 3500);
  await page.locator('button[name="record-actuals"]').click();
  await settle(600);
  await page.locator('input[name="actual-cost"]').fill(String(cost));
  await page.locator('button[name="save-actuals"]').click();
  await settle(3000);
}
await actuals(500000);
ok('actuals: 500,000 of 800,000 recorded, nobody alerted yet', (await told('EMP-0416', 'campaign.budget', camp.id)) === 0
  && (await one(`select coalesce(sum(cost), 0)::int s from public.campaign_actuals where campaign_id = $1`, [camp.id])).s === 500000);
await actuals(270000);
const alert = await rows(`select title from public.notifications where recipient_id = 'EMP-0416' and kind = 'campaign.budget' and entity_id = $1`, [camp.id]);
ok('actuals: past 95% Mitu is alerted', alert.length === 1 && /Budget at 96\.\d%/.test(alert[0].title), JSON.stringify(alert));
ok('actuals: ...and Tanvir, who reviewed it', (await told('EMP-0411', 'campaign.budget', camp.id)) === 1);
ok('actuals: ...by email too', (await one(`select count(*)::int n from public.email_outbox where tenant_id = $1 and kind = 'campaign.budget' and entity_id = $2`, [tenant, camp.id])).n >= 1);
await go(`/campaigns/${camp.id}`, 'EMP-0416', 3500);
t = await text();
ok('campaign page: says 96% is spent and that Mitu was told', /96(\.\d)?% of the budget is spent/.test(t) && /Mitu Rahman was told on/.test(t), t.slice(0, 600));
await page.getByRole('button', { name: /^Notifications/ }).click();
await settle(1500);
ok('actuals: Mitu sees the alert in her notifications', /Budget at 96/.test(await text()));
await page.keyboard.press('Escape');
await shot('qa-campaign-96');

// ---------------------------------------------------------------- the extension
const before = await one(`select ends_on, budget from public.campaigns where id = $1`, [camp.id]);
const newEnd = new Date(new Date(before.ends_on).getTime() + 21 * 86400000 + 12 * 3600000).toISOString().slice(0, 10);
await go(`/campaigns/${camp.id}`, 'EMP-0416', 3500);
await page.locator('button[name="extend"]').click();
await settle(800);
await page.locator('input[name="extend-end"]').fill(newEnd);
await page.locator('input[name="extend-budget"]').fill('300000');
await page.locator('select:has(option:text-is("Exceptional"))').last().selectOption('Exceptional');
await page.locator('textarea[name="extend-case"]').fill('Running ahead of target; three more weeks and 300,000 more.');
await page.locator('button[name="send-extension"]').click();
await settle(3000);
const ext = await one(`select submission_id, status from public.campaign_extensions where campaign_id = $1`, [camp.id]);
ok('extension: asked for, waiting for approval', ext?.status === 'pending' && /waiting for approval/.test(await text()), JSON.stringify(ext));
ok('extension: on the exceptional route, the CXO first', (await live(ext.submission_id)) === 'EMP-0800', await live(ext.submission_id));
ok('extension: keeps the modality', (await one(`select value from public.submission_values where submission_id = $1 and field_name = 'Modality'`, [ext.submission_id]))?.value === 'Cashback');
const extBy = await approveRest(ext.submission_id, 'extension');
const after = await one(`select ends_on, budget, alerted from public.campaigns where id = $1`, [camp.id]);
ok('extension: approved by CXO, Business Finance and the head', extBy[0] === 'EMP-0800' && extBy.includes('EMP-0410'), extBy.join(','));
ok('extension: the campaign runs longer with more budget',
  new Date(after.ends_on).getTime() - new Date(before.ends_on).getTime() > 20 * 86400000 && Number(after.budget) === 1100000, JSON.stringify(after));
ok('extension: Mitu is told', (await told('EMP-0416', 'campaign.extended', camp.id)) === 1);

// ================================================================ MNO: partner mail to ticket to NFA
await go('/admin/email', 'EMP-0445', 3000);
await page.getByRole('tab', { name: 'Inbound' }).click();
await settle(2000);
await page.getByRole('button', { name: /A partner's request/ }).click();
await page.locator('button[name="send-inbound"]').click();
await settle(3500);
const ticket = await one(`select s.id, s.ref_number, s.submitted_by from public.inbound_mail m join public.form_submissions s on s.id = m.submission_id
   where m.tenant_id = $1 and m.outcome = 'ticket' order by m.received_at desc limit 1`, [tenant]);
ok('MNO: the partner\'s mail becomes a ticket raised for Shahriar, with the telecom team', ticket?.submitted_by === 'EMP-0415' && (await live(ticket.id)) === 'EMP-0520', JSON.stringify(ticket));
ok('MNO: the inbound log shows it raised', /Ticket raised/.test(await page.locator('[data-testid="inbound-log"]').innerText()) && (await page.locator('[data-testid="inbound-log"]').innerText()).includes(ticket?.ref_number));
await approveIn('EMP-0520', ticket.id, 'MNO: telecom check (Omar)');
const mnoDraft = await one(`select s.id, s.status, s.submitted_by, t.name from public.form_submissions s join public.form_templates t on t.id = s.form_template_id where s.parent_submission_id = $1`, [ticket.id]);
ok('MNO: approval opens the MNO NFA draft for Shahriar', mnoDraft?.name === 'MNO Campaign NFA' && mnoDraft.status === 'draft' && mnoDraft.submitted_by === 'EMP-0415', JSON.stringify(mnoDraft));
ok('MNO: Shahriar is told', (await told('EMP-0415', 'request.followup', mnoDraft?.id)) === 1);
await go(`/status/${mnoDraft.id}`, 'EMP-0415', 3500);
await page.getByText('This is still a draft').click();
await settle(3500);
await nextTo(async () => (await page.getByText('NFA type', { exact: true }).count()) > 0);
ok('MNO NFA: preloaded with the partner, subject and request',
  (await (await field('Partner')).locator('input').inputValue()) === 'grameenphone.com'
  && /Eid data bundle cashback/.test(await (await field('Subject')).locator('input').inputValue())
  && /joint campaign/.test(await (await field('Request details')).locator('textarea').inputValue()));
await (await field('NFA type')).locator('select').selectOption('Information only');
await (await field('Total cost')).locator('input').fill('450000');
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(3500);
who = await whoPanel();
ok('MNO NFA review: "Information only" has no SO configuration step', !/SO configuration/.test(who) && who.includes('Nusrat Jahan'), who.slice(0, 400));
await page.getByRole('button', { name: /^Back/ }).first().click();
await settle(900);
await (await field('NFA type')).locator('select').selectOption('Requires SO configuration');
await page.getByRole('button', { name: /^Next/ }).first().click();
await settle(3500);
who = await whoPanel();
ok('MNO NFA review: "Requires SO configuration" adds SO configuration (Omar) last', /SO configuration/.test(who) && who.lastIndexOf('Omar Reyes') > who.indexOf('Nusrat Jahan'), who.slice(0, 500));
await page.getByRole('button', { name: /Confirm & Submit/ }).click();
await page.waitForURL(/\/status\//, { timeout: 20000 }).catch(() => {});
await settle(2500);
const mnoChain = await rows(`select approver_user_id a, stage_label st from public.approval_requests where submission_id = $1 order by step_index, lane, lane_step`, [mnoDraft.id]);
ok('MNO NFA: head of department > Business Finance > SO configuration', mnoChain.map((c) => c.st).join(' > ') === 'Head of department > Business finance review > SO configuration'
  && mnoChain[2]?.a === 'EMP-0520', mnoChain.map((c) => `${c.a}:${c.st}`).join(' > '));
await approveIn((await live(mnoDraft.id)).split(',')[0], mnoDraft.id, 'MNO NFA: head of department');
await approveIn('EMP-0410', mnoDraft.id, 'MNO NFA: Business Finance (Nusrat)');
ok('MNO NFA: now with SO for configuration', (await live(mnoDraft.id)) === 'EMP-0520', await live(mnoDraft.id));

// SO mails the UAT result back, quoting the NFA.
const nfaRef = (await one(`select ref_number from public.form_submissions where id = $1`, [mnoDraft.id])).ref_number;
await go('/admin/email', 'EMP-0445', 3000);
await page.getByRole('tab', { name: 'Inbound' }).click();
await settle(2000);
await page.locator('input[name="inbound-from"]').fill('so.configuration@bkash.example');
await page.locator('input[name="inbound-subject"]').fill(`UAT passed — ${nfaRef}`);
await page.locator('textarea[name="inbound-body"]').fill('UAT for the Eid bundle cashback configuration is complete. All 14 test cases passed.');
await page.locator('button[name="send-inbound"]').click();
await settle(3000);
ok('MNO UAT: the reply lands as a note on the NFA, not a new ticket',
  (await one(`select count(*)::int n from public.ticket_notes where submission_id = $1 and body like '%UAT passed%'`, [mnoDraft.id])).n === 1
  && (await one(`select outcome from public.inbound_mail where tenant_id = $1 order by received_at desc limit 1`, [tenant]))?.outcome === 'note');
ok('MNO UAT: Omar, holding SO configuration, is told', (await told('EMP-0520', 'note.added', mnoDraft.id)) >= 1);
await go(`/status/${mnoDraft.id}`, 'EMP-0415', 3500);
ok('MNO UAT: Shahriar sees it on his NFA', /All 14 test cases passed/.test(await text()));
await approveIn('EMP-0520', mnoDraft.id, 'MNO NFA: SO configuration (Omar)');
ok('MNO NFA: approved end to end', (await subStatus(mnoDraft.id)) === 'completed' && (await told('EMP-0415', 'request.completed', mnoDraft.id)) === 1);

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL COMMERCIAL QA CHECKS PASSED');
process.exit(failures ? 1 : 0);
