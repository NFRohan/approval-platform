// ================================================================ QA ops B: trackers, dashboard, My Submissions, global search
import { inflateRawSync } from 'node:zlib';
const TOM = 'EMP-2847', SAM = 'EMP-1134', LENA = 'EMP-0830', KOFI = 'EMP-0831', PRIYA = 'EMP-0650';
const go = async (path, as, ms = 3000) => { await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}as=${as}`); await settle(ms); };
const quiet = async () => { await page.goto('about:blank'); await settle(800); };
let body;

// Who may see a request, worked out here from the tables (db/009_visibility.sql
// states the rule): raised it, on its chain, acted on it, standing in for an
// approver today, copied, told about it, a follow-up of one of those, or head
// of the requester's department. Oversight roles see everything.
const INVOLVED = `
  inv as (
    select s.id from public.form_submissions s where s.tenant_id = $1 and s.submitted_by = $2
    union select r.submission_id from public.approval_requests r where r.tenant_id = $1 and r.approver_user_id = $2 and r.submission_id is not null
    union select e.subject_id from public.approval_events e where e.tenant_id = $1 and e.actor_id = $2 and e.subject_type = 'form_submission'
    union select c.submission_id from public.submission_cc c where c.tenant_id = $1 and c.employee_id = $2
    union select n.entity_id from public.notifications n where n.tenant_id = $1 and n.recipient_id = $2 and n.entity_type = 'form_submission' and n.entity_id is not null
    union select r.submission_id from public.delegation_rules d
            join public.approval_requests r on r.tenant_id = d.tenant_id and r.approver_user_id = d.delegator_id and r.submission_id is not null
                                           and r.status in ('waiting', 'pending', 'clarification')
            join public.form_submissions s2 on s2.id = r.submission_id
           where d.tenant_id = $1 and d.delegate_id = $2 and (now() at time zone 'Asia/Dhaka')::date between d.start_date and d.end_date
             and (d.form_template_ids is null or s2.form_template_id = any (d.form_template_ids)))`;
const OVERSIGHT = ['EMP-0445', 'EMP-0650', 'EMP-0201', 'EMP-0312', 'EMP-0700', 'EMP-0830'];
// The requests a person's tracker should list: visible, not draft, not archived.
const visibleSubs = async (emp, extra = 'true') => rows(
  `with ${INVOLVED}
   select s.id, s.ref_number, s.status, s.priority from public.form_submissions s
     join public.form_templates t on t.id = s.form_template_id
     left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
    where s.tenant_id = $1 and s.status <> 'draft' and s.archived_at is null
      and ($3 or s.id in (select id from inv) or s.parent_submission_id in (select id from inv)
           or e.department in (select d.name from public.departments d where d.tenant_id = $1 and d.head_employee_id = $2))
      and ${extra}`, [tenant, emp, OVERSIGHT.includes(emp)]);
const canSee = async (emp, id) => !!(await one(
  `with ${INVOLVED}
   select 1 from public.form_submissions s left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
    where s.id = $3 and ($4 or s.id in (select id from inv) or s.parent_submission_id in (select id from inv)
          or e.department in (select d.name from public.departments d where d.tenant_id = $1 and d.head_employee_id = $2))`,
  [tenant, emp, id, OVERSIGHT.includes(emp)]));

// ---------------------------------------------------------------- set the scene (DB writes while the page is idle)
await quiet();
// A private HR request by Priya, nobody else on it.
await rows(`select set_config('app.employee_id', $1, false)`, [PRIYA]);
const leave = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Leave Application'`, [tenant]);
const priv = await one(`insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
                        values ($1, $2, $3, 'submitted', now() - interval '2 hours') returning id, ref_number`, [tenant, leave.id, PRIYA]);
await rows(`insert into public.submission_values (tenant_id, submission_id, field_name, value) values ($1, $2, 'reason', 'Zebracorn QA confidential surgery')`, [tenant, priv.id]);
await rows(`select set_config('app.employee_id', '', false)`);
// A request Tom has no part in, copied to him.
const ccSub = await one(
  `select s.id, s.ref_number from public.form_submissions s join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
    where s.tenant_id = $1 and s.status <> 'draft' and s.archived_at is null and e.department = 'Finance'
      and not exists (select 1 from public.approval_requests r where r.submission_id = s.id and r.approver_user_id = $2)
      and not exists (select 1 from public.notifications n where n.entity_id = s.id and n.recipient_id = $2)
    order by s.submitted_at desc limit 1`, [tenant, TOM]);
await rows(`insert into public.submission_cc (tenant_id, submission_id, employee_id, added_by) values ($1, $2, $3, 'EMP-0600')`, [tenant, ccSub.id, TOM]);
// Tagged documents: one on Tom's own request, one on Priya's private one.
const tomSub = await one(`select id, ref_number from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status <> 'draft' and archived_at is null order by submitted_at desc limit 1`, [tenant, TOM]);
const pdf = Buffer.from('%PDF-1.4\n%QA\n');
await rows(`insert into public.attachments (tenant_id, submission_id, field_name, file_name, content_type, size_bytes, data, uploaded_by, tags, description)
            values ($1, $2, 'Receipt', 'qa-hotel-receipt.pdf', 'application/pdf', $3, $4, $5, array['qaroomreceipt'], 'Hotel receipt for the audit trip'),
                   ($1, $6, 'Note', 'qa-medical-note.pdf', 'application/pdf', $3, $4, $7, array['qasecretnote'], 'Doctor''s note')`,
  [tenant, tomSub.id, pdf.length, pdf, TOM, priv.id, PRIYA]);
// Notices that are not published.
await rows(`insert into public.notices (tenant_id, title, content, category, status, created_by) values ($1, 'QA withdrawn notice', 'Never published.', 'General', 'rejected', 'EMP-0201')`, [tenant]);

// ---------------------------------------------------------------- trackers: the main tracker per persona
const trackerRefs = async () => (await page.locator('[data-testid="tracker-rows"] tbody tr td:first-child').allInnerTexts()).filter((t) => t !== 'Nothing matches.');
const trackerCount = async () => Number((/(\d+) requests?\b/.exec(await page.locator('[data-testid="tracker-filters"]').locator('xpath=..').innerText()) ?? [])[1] ?? -1);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
for (const who of [TOM, SAM, KOFI, LENA]) {
  await quiet();
  const want = (await visibleSubs(who)).map((r) => r.ref_number ?? 'Open');
  await go('/trackers', who, 4000);
  const got = await trackerRefs();
  const missing = want.filter((r) => !got.includes(r)), extra = got.filter((r) => !want.includes(r));
  ok(`trackers: ${who}'s main tracker lists exactly the requests they may see (${want.length})`, sameSet(got, want) && (await trackerCount()) === want.length,
    `shown ${got.length}, expected ${want.length}; missing ${missing.slice(0, 5).join(',')} extra ${extra.slice(0, 5).join(',')}`);
}
// Tom's: Priya's private request and the copied one.
await go('/trackers', TOM, 4000);
body = await text();
ok('trackers: Tom does not see Priya\'s private HR request', !body.includes(priv.ref_number), priv.ref_number);
ok('trackers: ...but does see the request he was copied on', body.includes(ccSub.ref_number), ccSub.ref_number);
await quiet();
const tomOverdue = (await visibleSubs(TOM, `exists (select 1 from public.approval_requests r where r.submission_id = s.id and r.status = 'pending' and r.deadline_at < now())`)).length;
await go('/trackers', TOM, 4000);
ok('trackers: the overdue count is right for Tom', new RegExp(`\\b${tomOverdue} overdue`).test(await text()), `expected ${tomOverdue} overdue`);

// ---------------------------------------------------------------- trackers: filters (as the auditor, who sees every request)
const ALL = `s.tenant_id = $1 and s.status <> 'draft' and s.archived_at is null`;
const dbCount = async (where) => (await one(
  `select count(*)::int n from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
     left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by where ${ALL} and ${where}`, [tenant])).n;
const days = await one(`select ((now() at time zone 'Asia/Dhaka')::date - 45)::text a, ((now() at time zone 'Asia/Dhaka')::date - 10)::text b`);
const FILTERS = [
  ['form = Leave Application', async () => page.locator('select[aria-label="Form"]').selectOption('Leave Application'), `t.name = 'Leave Application'`],
  ['status = Open', async () => page.locator('[data-testid="tracker-filters"] select[aria-label="Status"]').selectOption('open'), `s.status in ('submitted','in_progress','on_hold')`],
  ['status = Rejected', async () => page.locator('[data-testid="tracker-filters"] select[aria-label="Status"]').selectOption('rejected'), `s.status = 'rejected'`],
  ['department = Finance', async () => page.locator('[data-testid="tracker-filters"] select[aria-label="Department"]').selectOption('Finance'), `e.department = 'Finance'`],
  ['priority = Urgent', async () => page.locator('select[aria-label="Priority"]').selectOption('urgent'), `s.priority = 'urgent'`],
  [`raised between ${days.a} and ${days.b}`, async () => { await page.locator('input[aria-label="From"]').fill(days.a); await settle(1200); await page.locator('input[aria-label="To"]').fill(days.b); },
    `(s.submitted_at at time zone 'Asia/Dhaka')::date between '${days.a}' and '${days.b}'`],
  ['overdue only', async () => page.getByLabel('Overdue only').check(), `exists (select 1 from public.approval_requests r where r.submission_id = s.id and r.status = 'pending' and r.deadline_at < now())`],
  ['flagged only', async () => page.getByLabel('Flagged only').check(), `s.flag is not null`],
  ['search "Bexley"', async () => page.locator('input[aria-label="Search the tracker"]').fill('Bexley'), `concat_ws(' ', s.ref_number, s.legacy_ref, t.name, e.name, s.submitted_by) ilike '%Bexley%'`],
];
for (const [label, apply, where] of FILTERS) {
  await quiet();
  const want = await dbCount(where);
  await go('/trackers', LENA, 3500);
  const before = await trackerCount();
  await apply();
  await settle(2500);
  const got = await trackerCount();
  ok(`trackers: filter ${label} shows what the database holds (${want})`, got === want && (want === before || got !== before), `${before} → ${got}, expected ${want}`);
}
// Two at once.
await quiet();
let want2 = await dbCount(`s.status in ('submitted','in_progress','on_hold') and e.department = 'Operations'`);
await go('/trackers', LENA, 3500);
await page.locator('[data-testid="tracker-filters"] select[aria-label="Status"]').selectOption('open');
await settle(1500);
await page.locator('[data-testid="tracker-filters"] select[aria-label="Department"]').selectOption('Operations');
await settle(2500);
ok('trackers: filters combine (open AND Operations)', (await trackerCount()) === want2, `${await trackerCount()} vs ${want2}`);

// ---------------------------------------------------------------- trackers: a view kept and shared
async function keepView(who, name, shared, setFilter) {
  await go('/trackers', who, 3500);
  await setFilter();
  await settle(1500);
  await page.getByRole('button', { name: /New tracker from this view/ }).click();
  await page.getByLabel('Tracker name').fill(name);
  await page.getByLabel('Shared with').selectOption(shared);
  await page.getByRole('button', { name: /^Save$/ }).click();
  await settle(2500);
}
await keepView(TOM, 'QA Tom private', 'me', () => page.locator('select[aria-label="Priority"]').selectOption('high'));
await keepView(SAM, 'QA Ops open', 'department', () => page.locator('[data-testid="tracker-filters"] select[aria-label="Status"]').selectOption('open'));
await keepView(KOFI, 'QA for everyone', 'everyone', () => page.getByLabel('Overdue only').check());
await quiet();
const kept = Object.fromEntries((await rows(`select name, owner_id, shared_with, department, filters from public.trackers where tenant_id = $1 and name like 'QA %'`, [tenant])).map((t) => [t.name, t]));
ok('trackers: three views kept, each with its owner, sharing and filters',
  kept['QA Tom private']?.owner_id === TOM && kept['QA Tom private']?.shared_with === 'me' && kept['QA Tom private']?.filters?.priority === 'high'
  && kept['QA Ops open']?.shared_with === 'department' && kept['QA Ops open']?.department === 'Operations' && kept['QA Ops open']?.filters?.statuses?.length === 3
  && kept['QA for everyone']?.shared_with === 'everyone' && kept['QA for everyone']?.filters?.overdue === true, JSON.stringify(kept));
const listOf = async (who) => { await go('/trackers', who, 3000); return (await page.locator('[data-testid="tracker-list"] button').allInnerTexts()).join(' | '); };
let l = await listOf(TOM);
ok('trackers: Tom sees his own, his department\'s and everyone\'s', l.includes('QA Tom private') && l.includes('QA Ops open') && l.includes('QA for everyone'), l);
l = await listOf(SAM);
ok('trackers: Sam (same department) sees the department one but not Tom\'s private one', l.includes('QA Ops open') && l.includes('QA for everyone') && !l.includes('QA Tom private'), l);
l = await listOf(KOFI);
ok('trackers: Kofi (Compliance) sees only the one shared with everyone', l.includes('QA for everyone') && !l.includes('QA Ops open') && !l.includes('QA Tom private'), l);
// A shared tracker shows each viewer only what they may see.
await quiet();
const tomOpen = (await visibleSubs(TOM, `s.status in ('submitted','in_progress','on_hold')`)).length;
const samOpen = (await visibleSubs(SAM, `s.status in ('submitted','in_progress','on_hold')`)).length;
await go('/trackers', TOM, 3000);
await page.locator('[data-testid="tracker-list"] button', { hasText: 'QA Ops open' }).click();
await settle(2500);
const tomSees = await trackerCount();
await go('/trackers', SAM, 3000);
await page.locator('[data-testid="tracker-list"] button', { hasText: 'QA Ops open' }).click();
await settle(2500);
const samSees = await trackerCount();
ok('trackers: the department tracker shows Tom and Sam each only what they may see', tomSees === tomOpen && samSees === samOpen, `Tom ${tomSees}/${tomOpen}, Sam ${samSees}/${samOpen}`);

// ---------------------------------------------------------------- trackers: reminder and Excel
await go('/trackers', TOM, 4000);
const firstRef = (await trackerRefs())[0];
await page.locator('[data-testid="tracker-rows"] tbody tr').first().getByRole('button', { name: /Remind me/ }).click();
await page.getByLabel('Reminder note').fill('QA chase the approver');
await page.getByRole('button', { name: /^Set$/ }).click();
await settle(2500);
ok('trackers: Tom sets a reminder for today on a row, and the tracker counts it', /1 with your reminder/.test(await text()));
await quiet();
const rem = await one(`select x.submission_id, x.remind_on::text d, x.note, (now() at time zone 'Asia/Dhaka')::date::text today from public.tracker_reminders x
                        join public.form_submissions s on s.id = x.submission_id where x.tenant_id = $1 and x.employee_id = $2 and x.sent_at is null`, [tenant, TOM]);
ok('trackers: ...stored for Tom, today, with the note', rem?.d === rem?.today && rem?.note === 'QA chase the approver', JSON.stringify(rem));

await go('/trackers', TOM, 4000);
const onScreen = await trackerRefs();
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /Excel/ }).click()]);
const file = await (await import('node:fs/promises')).readFile(await dl.path());
// Read the workbook: the central directory, then every XML part, inflated.
function unzipText(buf) {
  let e = buf.length - 22; while (e > 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); let out = '';
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + size);
    if (name.endsWith('.xml')) out += (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nl + xl + cl;
  }
  return out;
}
const xml = unzipText(file);
ok('trackers: Excel export is a workbook named after the tracker', dl.suggestedFilename().startsWith('main-tracker') && dl.suggestedFilename().endsWith('.xlsx') && file.subarray(0, 2).toString() === 'PK', dl.suggestedFilename());
ok('trackers: ...holding every request on screen and none Tom may not see', onScreen.every((r) => xml.includes(r)) && !xml.includes(priv.ref_number),
  `${onScreen.filter((r) => !xml.includes(r)).length} of ${onScreen.length} missing`);

// ---------------------------------------------------------------- dashboard: the four cards, for three people
const card = (label) => page.evaluate((l) => {
  // The stat card, not a panel further down with the same heading.
  for (const s of document.querySelectorAll('span')) {
    if (s.textContent.trim() !== l) continue;
    const v = s.closest('.rounded-xl')?.querySelector('.font-bold')?.textContent.trim();
    if (v && /^\d+$/.test(v)) return Number(v);
  }
  return NaN;
}, label);
for (const who of [TOM, SAM, KOFI]) {
  await quiet();
  const e = await one(`select department from public.employees where tenant_id = $1 and employee_id = $2`, [tenant, who]);
  const pending = (await one(`select count(*)::int n from public.approval_requests where tenant_id = $1 and approver_user_id = $2 and status = 'pending'`, [tenant, who])).n;
  const active = (await one(`select count(*)::int n from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status in ('submitted','in_progress','on_hold')`, [tenant, who])).n;
  // Completed this month: decided (its last step, or closed) since the 1st, Dhaka time.
  const done = await one(
    `select count(*) filter (where coalesce(st.last_acted_at, s.closed_at) >= (date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka'))::int decided,
            count(*) filter (where s.submitted_at >= (date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka'))::int raised
       from public.form_submissions s left join public.submission_stats st on st.submission_id = s.id
      where s.tenant_id = $1 and s.submitted_by = $2 and s.status = 'completed'`, [tenant, who]);
  // Forms offered to them: published, and open to everyone or to their department.
  const forms = (await one(`select count(*)::int n from public.form_templates where tenant_id = $1 and status = 'published'
                              and (coalesce(cardinality(audience_departments), 0) = 0 and coalesce(cardinality(audience_roles), 0) = 0
                                   or $2 = any (coalesce(audience_departments, '{}')))`, [tenant, e.department])).n;
  await go('/', who, 4000);
  ok(`dashboard ${who}: Pending Approvals = ${pending}`, (await card('Pending Approvals')) === pending, String(await card('Pending Approvals')));
  ok(`dashboard ${who}: My Active Submissions = ${active}`, (await card('My Active Submissions')) === active, String(await card('My Active Submissions')));
  ok(`dashboard ${who}: Completed This Month = ${done.decided} (requests decided this month)`, (await card('Completed This Month')) === done.decided,
    `card ${await card('Completed This Month')}; decided this month ${done.decided}, raised this month and since completed ${done.raised}`);
  ok(`dashboard ${who}: Forms I Can Submit = ${forms} (forms offered to ${e.department})`, (await card('Forms I Can Submit')) === forms,
    `card ${await card('Forms I Can Submit')} — every published form is counted, including ones only another department may raise`);
}

// ---------------------------------------------------------------- My Submissions
const subRows = async () => page.locator('.space-y-3 > div').count();
await quiet();
const mine = await rows(`select id, ref_number, status, (submitted_at at time zone 'Asia/Dhaka')::date::text d, archived_at is not null arch from public.form_submissions where tenant_id = $1 and submitted_by = $2`, [tenant, TOM]);
const liveMine = mine.filter((r) => !r.arch);
await go('/submissions', TOM, 3500);
ok('submissions: "Raised by me" lists every one of Tom\'s requests not archived', (await subRows()) === liveMine.length, `${await subRows()} vs ${liveMine.length}`);
ok('submissions: ...and none of anybody else\'s', !(await text()).includes(ccSub.ref_number));
await page.locator('select[aria-label="Status"]').selectOption('completed');
await settle(800);
ok('submissions: the status filter narrows to completed', (await subRows()) === liveMine.filter((r) => r.status === 'completed').length);
await page.locator('select[aria-label="Status"]').selectOption('');
const someRef = liveMine.find((r) => r.ref_number)?.ref_number;
await page.getByLabel('Search submissions', { exact: true }).fill(someRef);
await settle(800);
ok('submissions: searching a reference finds exactly that request', (await subRows()) === 1 && (await text()).includes(someRef), someRef);
await page.getByLabel('Search submissions', { exact: true }).fill('');
await page.getByLabel('From date').fill(days.a);
await page.getByLabel('To date').fill(days.b);
await settle(800);
const inRange = liveMine.filter((r) => r.d >= days.a && r.d <= days.b).length;
ok(`submissions: the date range narrows to what was raised between ${days.a} and ${days.b}`, inRange === 0 ? /Nothing matches/.test(await text()) : (await subRows()) === inRange, `${await subRows()} vs ${inRange}`);
// The date range stays across the tabs; clear it first.
await page.getByLabel('From date').fill('');
await page.getByLabel('To date').fill('');
await page.getByRole('tab', { name: /Copied to me/ }).click();
await settle(2500);
body = await text();
ok('submissions: "Copied to me" lists the request Tom was copied on', (await subRows()) === 1 && body.includes(ccSub.ref_number), body.slice(0, 300));
const archived = mine.filter((r) => r.arch).length;
await page.getByRole('tab', { name: /Archived/ }).click();
await settle(2500);
ok(`submissions: the archive tab lists Tom's ${archived} archived requests`, archived === 0 ? /Nothing has been archived/.test(await text()) : (await subRows()) === archived,
  `${await subRows()} vs ${archived}`);

// ---------------------------------------------------------------- global search
const searchBox = () => page.getByPlaceholder('Search submissions, forms, people…');
async function search(who, q, path = '/') {
  if (who) await go(path, who, 2500);
  await searchBox().fill('');
  await searchBox().fill(q);
  await settle(2500);
  return searchBox().locator('xpath=ancestor::div[contains(@class,"relative")][1]').innerText();
}
let r = await search(TOM, tomSub.ref_number);
ok('search: Tom finds his request by its reference', /SUBMISSIONS/i.test(r) && r.includes(tomSub.ref_number), r);
r = await search(null, 'Regional supplier audit');
ok('search: ...and by the text of an answer', /SUBMISSIONS/i.test(r) && /Regional supplier audit/.test(r), r);
r = await search(null, 'Gate Pass');
ok('search: a form by its name', /FORMS/i.test(r) && r.includes('Gate Pass'), r);
r = await search(null, 'capex');
ok('search: a form by a keyword', r.includes('Capital Expenditure Request') && /keyword: capex/.test(r), r);
r = await search(null, 'all-hands');
ok('search: a notice by its title', /NOTICES/i.test(r) && r.includes('Quarterly all-hands'), r);
r = await search(null, 'qaroomreceipt');
ok('search: a document by its tag', /DOCUMENTS/i.test(r) && r.includes('qa-hotel-receipt.pdf'), r);
r = await search(null, 'Lindqvist');
ok('search: a person by name', /PEOPLE/i.test(r) && r.includes('Sam Lindqvist'), r);
await page.getByRole('button', { name: /Sam Lindqvist/ }).click();
await settle(2500);
ok('search: ...choosing them opens their activity', /\/activity/.test(page.url()) && page.url().includes('actor=EMP-1134') && /Showing only what/.test(await text()), page.url());
// What Tom may not see.
r = await search(TOM, priv.ref_number);
// "Nothing matches “ref”" echoes what was typed; a result would be under SUBMISSIONS.
ok('search: Tom does not find Priya\'s private request by its reference', !/SUBMISSIONS/i.test(r), r);
r = await search(null, 'Zebracorn');
ok('search: ...nor by the text of its answers', /Nothing matches/.test(r) && !/SUBMISSIONS/i.test(r), r);
r = await search(null, 'qasecretnote');
ok('search: ...nor its documents by tag', /Nothing matches/.test(r) && !r.includes('qa-medical-note.pdf'), r);
r = await search(null, 'QA withdrawn');
ok('search: a rejected notice is not offered as a notice to read', !r.includes('QA withdrawn notice'), r);
r = await search(null, 'Updated expense policy');
ok('search: ...nor one still waiting for approval', !/NOTICES/i.test(r), r);
r = await search(null, 'MNO Campaign');
ok('search: Tom (Operations) is not offered forms only Commercial may raise', !r.includes('MNO Campaign NFA') && !r.includes('MNO Campaign Request'), r);
await quiet();
const kofiMay = await canSee(KOFI, tomSub.id);
r = await search(KOFI, tomSub.ref_number);
ok(`search: Kofi finds Tom's request by reference only if he may see it (${kofiMay ? 'may' : 'may not'})`, /SUBMISSIONS/i.test(r) === kofiMay, r);
await quiet();
const supplierSubs = await rows(
  `select s.id from public.submission_values v join public.form_submissions s on s.id = v.submission_id where v.tenant_id = $1 and v.value ilike '%Regional supplier audit%'`, [tenant]);
let kofiAny = false; for (const x of supplierSubs) kofiAny ||= await canSee(KOFI, x.id);
await go('/', KOFI, 2500);
r = await search(null, 'Regional supplier audit');
ok(`search: ...and finds answer text only in requests he may see (${kofiAny ? 'may' : 'may not'})`, /SUBMISSIONS/i.test(r) === kofiAny, r);
r = await search(LENA, 'Zebracorn');
ok('search: the auditor (oversight) does find Priya\'s request by its answer', /Zebracorn/.test(r), r);

// ---------------------------------------------------------------- the daily round sends Tom's tracker reminder
await quiet();
process.env.CRON_SECRET ??= 'qa-ops-cron-secret-0123456789abcdef';
const res = await server.fetch(new Request(BASE + '/cron/daily', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } }));
const round = await res.json().catch(() => ({}));
ok('reminders: the daily round runs', res.status === 200 && round.tenants >= 1, JSON.stringify(round).slice(0, 300));
const note = await one(`select title, body from public.notifications where tenant_id = $1 and recipient_id = $2 and kind = 'tracker.reminder' and entity_id = $3`, [tenant, TOM, rem?.submission_id]);
ok('reminders: ...Tom is reminded about the request, with his note', !!note && note.body === 'QA chase the approver' && /^Reminder:/.test(note.title), JSON.stringify(note));
ok('reminders: ...and the reminder is marked sent, so it is sent once', !!(await one(`select 1 from public.tracker_reminders where tenant_id = $1 and employee_id = $2 and sent_at is not null`, [tenant, TOM])));
await go('/trackers', TOM, 4000);
ok('reminders: once sent it no longer shows as pending on the tracker', /0 with your reminder/.test(await text()));
void firstRef;

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL QA OPS B CHECKS PASSED');
process.exit(failures ? 1 : 0);
