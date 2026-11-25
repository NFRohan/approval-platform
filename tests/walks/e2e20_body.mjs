// ================================================================ who sees a request
const TOM = 'EMP-2847';
// This dataset is Tom's own; raise one he has no part in: an HR request
// by Priya Raman, with answers, nobody from Operations on it.
{
  // The walk shares the server's session, and a new request is stamped
  // with the session's employee: raise it as Priya, then let go.
  await rows(`select set_config('app.employee_id', 'EMP-0650', false)`);
  const tpl = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Leave Application'`, [tenant]);
  const s = await one(`insert into public.form_submissions (tenant_id, form_template_id, submitted_by, status, submitted_at)
                       values ($1, $2, 'EMP-0650', 'submitted', now() - interval '1 hour') returning id`, [tenant, tpl.id]);
  await rows(`insert into public.submission_values (tenant_id, submission_id, field_name, value) values ($1, $2, 'reason', 'Medical')`, [tenant, s.id]);
  await rows(`select set_config('app.employee_id', '', false)`);
}
const total = Number((await one(
  `select count(*)::int n from public.form_submissions where tenant_id = $1 and status <> 'draft' and archived_at is null`, [tenant])).n);
const stranger = await one(
  `select s.id, s.ref_number from public.form_submissions s
     join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
    where s.tenant_id = $1 and s.status <> 'draft' and s.archived_at is null and s.submitted_by <> $2 and e.department <> 'Operations'
      and not exists (select 1 from public.approval_requests r where r.submission_id = s.id and r.approver_user_id = $2)
      and not exists (select 1 from public.approval_events v where v.subject_id = s.id and v.actor_id = $2)
      and not exists (select 1 from public.submission_cc c where c.submission_id = s.id and c.employee_id = $2)
      and not exists (select 1 from public.notifications n where n.entity_id = s.id and n.recipient_id = $2)
    order by s.submitted_at desc limit 1`, [tenant, TOM]);
const mine = await one(`select ref_number from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status <> 'draft' and archived_at is null order by submitted_at desc limit 1`, [tenant, TOM]);

const countOf = (s) => Number((s.match(/(\d+) requests?\b/) ?? [])[1] ?? -1);

await page.goto(`${BASE}/trackers?as=${TOM}`);
await settle(4000);
let body = await text();
const tomCount = countOf(body);
ok('Tom\'s main tracker lists fewer than every request', tomCount > 0 && tomCount < total, `${tomCount} of ${total}`);
ok('...and his own are there', body.includes(mine.ref_number), mine.ref_number);
ok('...and a colleague\'s he has no part in is not', !body.includes(stranger.ref_number), stranger.ref_number);
await shot('s20-tom-tracker');

await page.goto(`${BASE}/status/${stranger.id}?as=${TOM}`);
await settle(3500);
body = await text();
ok('a colleague\'s status link reads as not found', /Submission not found/.test(body) && !body.includes(stranger.ref_number), body.slice(0, 200));

await page.goto(`${BASE}/certificate/${stranger.id}?as=${TOM}`);
await settle(3500);
body = await text();
ok('...its certificate too', /Certificate not found/.test(body), body.slice(0, 200));

await page.goto(`${BASE}/records/${stranger.id}?as=${TOM}`);
await settle(2500);
body = await text();
ok('...and its approval record', /No such request/.test(body), body.slice(0, 200));

await page.goto(`${BASE}/submissions?as=${TOM}`);
await settle(3000);
await page.getByPlaceholder(/Search submissions/).first().fill(stranger.ref_number);
await settle(2500);
body = await text();
// What is typed is in the box, not the page's text; a result would be.
// It says so, echoing what was typed; the reference appears nowhere else.
ok('searching its reference finds nothing', body.includes(`Nothing matches “${stranger.ref_number}”`)
   && body.split(stranger.ref_number).length === 2, body.slice(0, 300));
await page.keyboard.press('Escape');

// Oversight, for contrast: the compliance auditor sees every request.
await page.goto(`${BASE}/trackers?as=EMP-0830`);
await settle(4000);
body = await text();
ok('the compliance auditor\'s main tracker lists every request', countOf(body) === Math.min(total, 1000), `${countOf(body)} of ${total}`);

// The head of Operations sees Tom's, though not on the chain of all of them.
await page.goto(`${BASE}/trackers?as=EMP-1134`);
await settle(4000);
body = await text();
ok('the head of Operations sees Tom\'s latest request', body.includes(mine.ref_number), mine.ref_number);
// The record check's 404 is the answer it expects.
const errs = pageErrors.filter((e) => !/status of 404/.test(e));
ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `${failures} FAILED` : 'ALL VISIBILITY WALK CHECKS PASSED');
process.exit(failures ? 1 : 0);
