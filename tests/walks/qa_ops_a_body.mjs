// ================================================================ QA ops A: notices, movement orders, approval history, activity log
const TOM = 'EMP-2847', SAM = 'EMP-1134', FARAH = 'EMP-0445', LENA = 'EMP-0830', KOFI = 'EMP-0831', NADIA = 'EMP-0201', IVAN = 'EMP-9001';
const go = async (path, as, ms = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${as}`); await settle(ms); };
const quiet = async () => { await page.goto('about:blank'); await settle(800); };
let body;

// ---------------------------------------------------------------- notices
await go('/notices', TOM);
body = await text();
ok('notices: Tom sees the published notice on the board', body.includes('Quarterly all-hands'), body.slice(0, 300));
ok('notices: ...but not a notice still waiting for approval', !body.includes('Updated expense policy'));
ok('notices: ...and is not offered "New Notice"', (await page.getByRole('link', { name: /New Notice/ }).count()) === 0);

// Somebody who may not post notices opens the page by its address.
// Notices are posted by leadership (decided 26 Nov): the page says so and
// offers no form; the database refuses a post anyway.
await go('/notices/new', TOM);
ok('notices: the page tells somebody who may not post who does, and offers no form',
  /Notices are posted by HR and leadership/.test(await text()) && (await page.getByPlaceholder('e.g. Office closed for public holiday').count()) === 0);
await quiet();
const rogue = await one(`select id, status, created_by from public.notices where tenant_id = $1 and title = 'QA unauthorised notice'`, [tenant]);
ok('notices: someone not allowed to post notices cannot create one by opening /notices/new', !rogue,
  `a notice was created by ${rogue?.created_by} with status ${rogue?.status}`);
if (rogue) {
  // Out of the way of the checks below (approver queues, counts).
  await rows(`delete from public.approval_requests where subject_type = 'notice' and subject_id = $1`, [rogue.id]).catch(() => {});
  await rows(`delete from public.notices where id = $1`, [rogue.id]).catch(() => {});
}

// An allowed author (HR) raises one.
async function raiseNotice(title, category, content) {
  await go('/notices/new', NADIA);
  await page.getByPlaceholder('e.g. Office closed for public holiday').fill(title);
  await page.locator('label', { hasText: 'Category' }).locator('select').selectOption(category);
  await page.locator('textarea').first().fill(content);
  await page.getByRole('button', { name: 'Submit for Approval' }).click();
  await page.waitForURL(/\/notices\/[0-9a-f-]{36}/, { timeout: 15000 });
  await settle(2500);
}
await go('/notices', NADIA);
ok('notices: an allowed author is offered "New Notice"', (await page.getByRole('link', { name: /New Notice/ }).count()) === 1);
await raiseNotice('QA canteen reopening', 'Event', 'The canteen reopens on Monday with a new menu.');
body = await text();
ok('notices: the author lands on the new notice, with no comments box yet', body.includes('QA canteen reopening') && body.includes('Posted by Nadia Okonjo') && !/Comments/.test(body), body.slice(0, 300));
await quiet();
const n1 = await one(`select id, status, current_approver_id, created_by from public.notices where tenant_id = $1 and title = 'QA canteen reopening'`, [tenant]);
const n1Steps = await rows(`select approver_user_id, status from public.approval_requests where subject_type = 'notice' and subject_id = $1 order by step_index, lane, lane_step`, [n1.id]);
ok('notices: it is pending, with the first approver of the notice rule holding it',
  n1.status === 'pending' && n1.created_by === NADIA && n1Steps.length >= 2 && n1Steps[0].status === 'pending' && n1.current_approver_id === n1Steps[0].approver_user_id,
  JSON.stringify({ n1, n1Steps }));
ok('notices: ...the chain ends with the administrator', n1Steps.at(-1)?.approver_user_id === FARAH, JSON.stringify(n1Steps));
ok('notices: the creation is on the activity log', !!(await one(`select 1 from public.activity_log where tenant_id = $1 and entity_type = 'notice' and entity_id = $2 and action = 'created' and actor_id = $3`, [tenant, n1.id, NADIA])));

await go('/notices', TOM);
ok('notices: a pending notice is not on the board yet', !(await text()).includes('QA canteen reopening'));

// Each approver in turn, from the board's "Pending your approval".
const approvedBy = [];
for (let i = 0; i < 4; i++) {
  await quiet();
  const cur = await one(`select status, current_approver_id from public.notices where id = $1`, [n1.id]);
  if (cur.status !== 'pending') break;
  await go('/notices', cur.current_approver_id);
  body = await text();
  ok(`notices: ${cur.current_approver_id} sees it under "Pending Your Approval"`, /Pending Your Approval/i.test(body) && body.includes('QA canteen reopening'), body.slice(0, 300));
  await page.getByRole('link', { name: /QA canteen reopening/ }).first().click();
  await settle(2500);
  await page.getByRole('button', { name: /^Approve$/ }).click();
  await settle(3000);
  approvedBy.push(cur.current_approver_id);
}
await quiet();
const n1b = await one(`select status, current_approver_id from public.notices where id = $1`, [n1.id]);
ok('notices: once every approver approves, it is published', n1b.status === 'published' && approvedBy.length === n1Steps.length,
  JSON.stringify({ n1b, approvedBy }));
ok('notices: ...and the publishing is on the activity log', !!(await one(`select 1 from public.activity_log where tenant_id = $1 and entity_id = $2 and action = 'published'`, [tenant, n1.id])));

await go('/notices', TOM);
body = await text();
ok('notices: the published notice is on the board for everyone', body.includes('QA canteen reopening'));
await page.getByRole('button', { name: 'Event', exact: true }).click();
await settle(600);
body = await text();
ok('notices: the category filter narrows the board', body.includes('QA canteen reopening') && !body.includes('Quarterly all-hands'));
await page.getByRole('link', { name: /QA canteen reopening/ }).first().click();
await settle(2500);
await page.getByPlaceholder('Ask a question or leave a comment…').fill('Will there be vegetarian options?');
await page.getByRole('button', { name: 'Post' }).click();
await settle(2500);
body = await text();
ok('notices: a reader comments, and the comment shows with their name', body.includes('Will there be vegetarian options?') && body.includes('Tom Bexley'));
await quiet();
ok('notices: ...and it is stored once, as Tom', (await one(`select count(*)::int n from public.notice_comments where notice_id = $1 and author_id = $2 and text = 'Will there be vegetarian options?'`, [n1.id, TOM])).n === 1);

// A rejected one.
await raiseNotice('QA parking changes', 'General', 'Level B2 parking is closed for resurfacing.');
await quiet();
const n2 = await one(`select id, current_approver_id from public.notices where tenant_id = $1 and title = 'QA parking changes'`, [tenant]);
const rejecter = n2.current_approver_id;
await go(`/notices/${n2.id}`, rejecter);
await page.getByRole('button', { name: /^Reject$/ }).click();
await settle(500);
await page.getByPlaceholder(/Explain why this notice is being rejected/).fill('Facilities will announce this themselves.');
await page.getByRole('button', { name: 'Confirm' }).click();
await settle(3000);
await quiet();
const n2b = await one(`select status, current_approver_id from public.notices where id = $1`, [n2.id]);
ok('notices: an approver rejects a notice with a reason', n2b.status === 'rejected', JSON.stringify(n2b));
ok('notices: ...the later approver is never asked', (await one(`select count(*)::int n from public.approval_requests where subject_type = 'notice' and subject_id = $1 and status = 'pending'`, [n2.id])).n === 0);
await go('/notices', TOM);
ok('notices: a rejected notice is not published on the board', !(await text()).includes('QA parking changes'));
await go(`/notices/${n2.id}`, FARAH);
body = await text();
ok('notices: nobody is offered Approve on a rejected notice, and it takes no comments', !(await page.getByRole('button', { name: /^Approve$/ }).count()) && !/Ask a question/.test(body));

// ---------------------------------------------------------------- approval history (Sam decided notices above)
const histCount = async () => page.locator('.space-y-3 > div').count();
await quiet();
const samDecided = (await one(`select count(*)::int n from public.approval_requests where tenant_id = $1 and approver_user_id = $2 and status in ('approved','rejected','clarification')`, [tenant, SAM])).n;
await go('/approvals/history', SAM, 3500);
const samShown = await histCount();
ok('history: Sam\'s approval history lists every step he decided', samShown === samDecided, `${samShown} shown, ${samDecided} in the database`);
// The notice approver (the author's line manager) approved one notice and rejected another.
await quiet();
const noticeApprover = approvedBy[0];
const naDecided = (await one(`select count(*)::int n from public.approval_requests where tenant_id = $1 and approver_user_id = $2 and status in ('approved','rejected','clarification')`, [tenant, noticeApprover])).n;
await go('/approvals/history', noticeApprover, 3500);
body = await text();
ok(`history: ${noticeApprover}'s history lists every step decided, the two notices included`, (await histCount()) === naDecided, `${await histCount()} vs ${naDecided}`);
ok('history: ...a notice decided there is named by its title, not as an anonymous "Submission"',
  body.includes('QA canteen reopening') && body.includes('QA parking changes'), body.slice(body.indexOf('Approval History'), body.indexOf('Approval History') + 500));
await quiet();
const tomDecided = (await one(`select count(*)::int n from public.approval_requests where tenant_id = $1 and approver_user_id = $2 and status in ('approved','rejected','clarification')`, [tenant, TOM])).n;
await go('/approvals/history', TOM, 3500);
ok('history: Tom\'s history matches what he decided', tomDecided === 0 ? /No approval history yet/.test(await text()) : (await histCount()) === tomDecided, `db ${tomDecided}`);

// ---------------------------------------------------------------- movement orders
const tabCount = async (label) => Number((/\((\d+)\)/.exec(await page.getByRole('button', { name: new RegExp('^' + label + '\\s*\\(') }).first().innerText()) ?? [])[1] ?? -1);
const STATUSES = ['submitted', 'approved', 'in_transit', 'completed', 'on_hold', 'rejected'];
const LABEL = { submitted: 'Submitted', approved: 'Approved', in_transit: 'In Transit', completed: 'Completed', on_hold: 'On Hold', rejected: 'Rejected' };
const stock = async (item, venue) => (await one(
  `select coalesce(sum(s.quantity), 0)::int q, coalesce(sum(s.reserved_quantity), 0)::int r from public.item_stock s
     join public.items i on i.id = s.item_id join public.venues v on v.id = s.venue_id
    where s.tenant_id = $1 and i.name = $2 and v.name = $3`, [tenant, item, venue]));

async function newOrder(itemLabel, qty, from, to, why) {
  await go('/movement-orders', TOM);
  await page.getByRole('button', { name: /New Request/ }).click();
  await settle(1500);
  await page.locator('label', { hasText: /^Item/ }).locator('select').selectOption({ label: itemLabel });
  await page.locator('label', { hasText: /^Quantity/ }).locator('input').fill(String(qty));
  await page.locator('label', { hasText: /^Source/ }).locator('select').selectOption({ label: from });
  await settle(400);
  await page.locator('label', { hasText: /^Destination/ }).locator('select').selectOption({ label: to });
  await page.locator('label', { hasText: /^Justification/ }).locator('textarea').fill(why);
  await settle(800);
  await page.getByRole('button', { name: 'Submit Request' }).click();
  await settle(3000);
}

await go('/movement-orders', TOM);
body = await text();
ok('movement: Tom sees only his own orders (none yet), not other people\'s', /No movement orders yet/.test(body) && !body.includes('MO-1042') && !body.includes('MO-1041'), body.slice(0, 300));

await quiet();
const chairBefore = await stock('Desk chair', 'Main Store');
const chairSouthBefore = await stock('Desk chair', 'South Wing');
await newOrder('Desk chair (Furniture)', 3, 'Main Store – Basement', 'South Wing – 2nd Floor', 'QA desks for the new pod');
await quiet();
const mo1 = await one(`select id, ref_number, status, requester_id from public.movement_orders where tenant_id = $1 and justification = 'QA desks for the new pod'`, [tenant]);
ok('movement: Tom raises an order, submitted in his name', mo1?.status === 'submitted' && mo1?.requester_id === TOM, JSON.stringify(mo1));
ok('movement: ...and the stock it needs is reserved', (await stock('Desk chair', 'Main Store')).r === chairBefore.r + 3, JSON.stringify({ chairBefore, now: await stock('Desk chair', 'Main Store') }));
await go('/movement-orders', TOM);
ok('movement: Tom\'s list shows it, counted under All and Submitted', (await text()).includes(mo1.ref_number) && (await tabCount('All')) === 1 && (await tabCount('Submitted')) === 1);

// The administrator's view: every order, counted by status.
const moCounts = async () => Object.fromEntries((await rows(`select status, count(*)::int n from public.movement_orders where tenant_id = $1 group by status`, [tenant])).map((r) => [r.status, r.n]));
await quiet();
let c = await moCounts();
await go('/movement-orders', FARAH);
const allShown = await tabCount('All');
const byTab = {};
for (const s of STATUSES) byTab[s] = await tabCount(LABEL[s]);
ok('movement: the administrator sees every order (All = database)', allShown === Object.values(c).reduce((a, b) => a + b, 0), `${allShown} vs ${JSON.stringify(c)}`);
ok('movement: ...and each status tab counts what the database holds', STATUSES.every((s) => byTab[s] === (c[s] ?? 0)), `${JSON.stringify(byTab)} vs ${JSON.stringify(c)}`);
await page.getByRole('button', { name: /^Submitted\s*\(/ }).click();
await settle(600);
body = await text();
ok('movement: the Submitted filter shows submitted orders only', body.includes(mo1.ref_number) && body.includes('MO-1042') && !body.includes('MO-1039') && !body.includes('MO-1041'));

// Approve and assign a mover.
await page.locator('button', { hasText: mo1.ref_number }).first().click();
await settle(2500);
await page.getByPlaceholder('e.g. EMP-9001').fill(IVAN);
await page.getByPlaceholder('Notes for requester…').fill('Ivan will move them on Tuesday');
await page.getByRole('button', { name: /Approve & Assign Mover/ }).click();
await settle(3000);
await quiet();
const mo1b = await one(`select status, assigned_mover_id, admin_comment from public.movement_orders where id = $1`, [mo1.id]);
ok('movement: the administrator approves it and assigns a mover', mo1b.status === 'approved' && mo1b.assigned_mover_id === IVAN, JSON.stringify(mo1b));
const chairAfter = await stock('Desk chair', 'Main Store');
ok('movement: ...the chairs leave Main Store and the reservation is released', chairAfter.q === chairBefore.q - 3 && chairAfter.r === chairBefore.r, JSON.stringify({ chairBefore, chairAfter }));
ok('movement: ...and arrive at South Wing', (await stock('Desk chair', 'South Wing')).q === chairSouthBefore.q + 3);
ok('movement: ...the approval is on the activity log', !!(await one(`select 1 from public.activity_log where tenant_id = $1 and entity_type = 'movement_order' and entity_id = $2 and action = 'approved'`, [tenant, mo1.id])));

// The mover assigned to it.
await go('/movement-orders', IVAN);
body = await text();
const ivanSees = body.includes(mo1.ref_number);
ok('movement: the assigned mover sees the order assigned to him', ivanSees, body.slice(0, 300));
if (ivanSees) {
  await page.locator('button', { hasText: mo1.ref_number }).first().click();
  await settle(1500);
  ok('movement: ...and is offered Mark In Transit', (await page.getByRole('button', { name: /Mark In Transit/ }).count()) === 1);
}

// The administrator moves it on: in transit, then delivered.
await go('/movement-orders', FARAH);
await page.locator('button', { hasText: mo1.ref_number }).first().click();
await settle(1500);
await page.getByRole('button', { name: /Mark In Transit/ }).click();
await settle(2500);
await quiet();
ok('movement: approved → in transit', (await one(`select status from public.movement_orders where id = $1`, [mo1.id])).status === 'in_transit');
await go('/movement-orders', FARAH);
await page.locator('button', { hasText: mo1.ref_number }).first().click();
await settle(1500);
await page.getByRole('button', { name: /Mark Delivered/ }).click();
await settle(2500);
await quiet();
ok('movement: in transit → completed', (await one(`select status from public.movement_orders where id = $1`, [mo1.id])).status === 'completed');
await go('/movement-orders', TOM);
await page.locator('button', { hasText: mo1.ref_number }).first().click();
await settle(1200);
body = await text();
ok('movement: Tom sees it Completed, with the mover and the administrator\'s note', (await tabCount('Completed')) === 1 && body.includes('Ivan Petrov') && body.includes('Ivan will move them on Tuesday'), body.slice(0, 500));

// A rejected one.
await quiet();
const dockBefore = await stock('Laptop dock', 'Main Store');
await newOrder('Laptop dock (IT Equipment)', 2, 'Main Store – Basement', 'North Wing – 4th Floor', 'QA docks nobody asked for');
await quiet();
const mo2 = await one(`select id, ref_number from public.movement_orders where tenant_id = $1 and justification = 'QA docks nobody asked for'`, [tenant]);
ok('movement: a second order reserves its stock', (await stock('Laptop dock', 'Main Store')).r === dockBefore.r + 2);
await go('/movement-orders', FARAH);
await page.locator('button', { hasText: mo2.ref_number }).first().click();
await settle(2500);
await page.getByPlaceholder('Notes for requester…').fill('North Wing already has docks');
await page.getByRole('button', { name: /^Reject$/ }).click();
await settle(3000);
await quiet();
const mo2b = await one(`select status, admin_comment from public.movement_orders where id = $1`, [mo2.id]);
ok('movement: the administrator rejects it, with a comment', mo2b.status === 'rejected' && mo2b.admin_comment === 'North Wing already has docks', JSON.stringify(mo2b));
const dockAfter = await stock('Laptop dock', 'Main Store');
ok('movement: ...its reservation is released and nothing moves', dockAfter.r === dockBefore.r && dockAfter.q === dockBefore.q, JSON.stringify({ dockBefore, dockAfter }));
await go('/movement-orders', TOM);
await page.getByRole('button', { name: /^Rejected\s*\(/ }).click();
await settle(600);
body = await text();
ok('movement: Tom\'s Rejected filter shows it, and only it', body.includes(mo2.ref_number) && !body.includes(mo1.ref_number) && (await tabCount('Rejected')) === 1);

// One put on hold for clarification.
await newOrder('Monitor, 27 inch (IT Equipment)', 1, 'Main Store – Basement', 'North Wing – 4th Floor', 'QA one monitor, maybe');
await quiet();
const mo3 = await one(`select id, ref_number from public.movement_orders where tenant_id = $1 and justification = 'QA one monitor, maybe'`, [tenant]);
await go('/movement-orders', FARAH);
await page.locator('button', { hasText: mo3.ref_number }).first().click();
await settle(2500);
await page.getByRole('button', { name: /^Clarify$/ }).click();
await settle(2500);
await quiet();
ok('movement: Clarify puts an order on hold', (await one(`select status from public.movement_orders where id = $1`, [mo3.id])).status === 'on_hold');
await go('/movement-orders', TOM);
const tomAll = await tabCount('All');
let tomTabs = 0;
for (const s of STATUSES) tomTabs += await tabCount(LABEL[s]);
ok('movement: every order can be reached from a status filter (the tabs add up to All)', tomTabs === tomAll,
  `All (${tomAll}) but the status tabs add up to ${tomTabs} — an on-hold order has no tab`);
await quiet();
c = await moCounts();
await go('/movement-orders', FARAH);
ok('movement: the administrator\'s counts still match the database after the changes',
  (await tabCount('Completed')) === (c.completed ?? 0) && (await tabCount('Rejected')) === (c.rejected ?? 0) && (await tabCount('All')) === Object.values(c).reduce((a, b) => a + b, 0),
  JSON.stringify(c));

// ---------------------------------------------------------------- activity log
const actRows = async () => page.locator('.rounded-xl.bg-white.overflow-hidden > div').count();
const activityText = async () => (await page.locator('.rounded-xl.bg-white.overflow-hidden').count()) ? page.locator('.rounded-xl.bg-white.overflow-hidden').innerText() : '';
await quiet();
const lenaTop = await rows(`select entity_type, actor_id from public.activity_log where tenant_id = $1 order by created_at desc limit 200`, [tenant]);
await go('/activity', LENA, 3500);
ok('activity: the auditor sees the latest 200 entries', (await actRows()) === lenaTop.length, `${await actRows()} vs ${lenaTop.length}`);
await page.getByRole('button', { name: /^notices$/i }).click();
await settle(600);
let shown = await actRows();
const noticeTop = lenaTop.filter((r) => r.entity_type === 'notice').length;
ok('activity: filtered to notices, it shows only notice entries (as many as the database has)', shown === noticeTop && /notice/.test(await activityText()) && !/form submission/.test(await activityText()), `${shown} vs ${noticeTop}`);
await page.getByRole('button', { name: /^movement orders$/i }).last().click();  // the filter chip, not the sidebar
await settle(600);
shown = await actRows();
ok('activity: filtered to movement orders, likewise', shown === lenaTop.filter((r) => r.entity_type === 'movement_order').length && shown >= 4, String(shown));

// By person: everything one person did, wherever it sits in the log.
await quiet();
const actor = await one(
  `select a.actor_id, count(*)::int total from public.activity_log a where a.tenant_id = $1 and a.actor_id is not null
    group by a.actor_id having count(*) <= 150 order by count(*) desc limit 1`, [tenant]);
await go(`/activity?actor=${actor.actor_id}`, LENA, 3500);
shown = await actRows();
body = await text();
ok(`activity: filtered to one person (${actor.actor_id}), it lists everything they did`, shown === actor.total, `${shown} shown, ${actor.total} in the database — only the newest 200 entries of the whole log are filtered`);
ok('activity: ...and says whose activity it is showing', /Showing only what/.test(body));

// Tom reads only what he may: entries about requests he cannot see are not his to read.
await quiet();
const tomCanSee = (await one(
  `with inv as (
     select s.id from public.form_submissions s where s.tenant_id = $1 and s.submitted_by = $2
     union select r.submission_id from public.approval_requests r where r.tenant_id = $1 and r.approver_user_id = $2 and r.submission_id is not null
     union select e.subject_id from public.approval_events e where e.tenant_id = $1 and e.actor_id = $2 and e.subject_type = 'form_submission'
     union select c.submission_id from public.submission_cc c where c.tenant_id = $1 and c.employee_id = $2
     union select n.entity_id from public.notifications n where n.tenant_id = $1 and n.recipient_id = $2 and n.entity_type = 'form_submission' and n.entity_id is not null),
   vis as (
     select s.id from public.form_submissions s left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
      where s.tenant_id = $1 and (s.id in (select id from inv) or s.parent_submission_id in (select id from inv)
            or e.department in (select d.name from public.departments d where d.tenant_id = $1 and d.head_employee_id = $2)))
   select count(*)::int n from (select 1 from public.activity_log a where a.tenant_id = $1
     and (a.entity_type is distinct from 'form_submission' or a.entity_id in (select id from vis)) order by a.created_at desc limit 200) x`, [tenant, TOM])).n;
await go('/activity', TOM, 3500);
ok('activity: Tom\'s log holds only entries about what he may see', (await actRows()) === tomCanSee, `${await actRows()} vs ${tomCanSee}`);

// The audit centre: audit roles only.
await go('/admin/audit', TOM);
ok('audit: Tom (no audit role) is refused the audit centre', /needs the audit\.view permission/.test(await text()));
await go('/admin/audit', KOFI);
ok('audit: a compliance officer without the auditor role is refused too', /needs the audit\.view permission/.test(await text()));
await go('/admin/audit', LENA, 3500);
body = await text();
ok('audit: the compliance auditor opens the audit trail', /Audit centre/i.test(body) && (await page.getByRole('tab', { name: 'Trail' }).count()) === 1 && !/needs the/.test(body), body.slice(0, 200));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA OPS A CHECKS PASSED');
process.exit(failures ? 1 : 0);
