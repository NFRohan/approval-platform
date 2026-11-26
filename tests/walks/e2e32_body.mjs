// ================================================================ the 27 Nov gaps, as people use them
// Documents page (§2.1 r8, ABC), tracker date and answer search (ABC),
// report schedules (§2.1 r8, §2.2 BO-4), two-step sign-in policy (§2.1
// r10) and team watchers (§3.3 1.3).

await page.goto('about:blank'); await settle(1000);
const LENA = 'EMP-0830', FARAH = 'EMP-0445';

// ---------------------------------------------------------------- documents
// Twelve tagged documents on a request Farhana raised, so there is a list.
const mine = (await one(`select id from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status <> 'draft' limit 1`, [tenant, FARAH])).id;
for (let i = 1; i <= 12; i++) {
  await db.query(`insert into public.attachments (tenant_id, submission_id, field_name, file_name, content_type, size_bytes, data, uploaded_by, description, tags, version)
    values ($1, $2, 'Supporting document', $3, 'application/pdf', 4, '\x25504446'::bytea, $4, $5, $6, 1)`,
    [tenant, mine, `qa-doc-${i}.pdf`, FARAH, `QA document ${i}`, i % 3 === 0 ? ['vendor-acme', 'qa'] : ['qa']]);
}
const docCount = (await one(`select count(*)::int n from public.attachments where tenant_id = $1 and superseded_at is null`, [tenant])).n;
await page.goto(`${BASE}/documents?as=${FARAH}`); await settle(3500);
let t = await text();
ok('Documents is in the sidebar and opens', /Documents/.test(await page.locator('aside').innerText()) && /Every document on the requests you can see/.test(t), t.slice(0, 200));
const shown = await page.locator('[data-testid="document-list"] tbody tr').count();
ok('it lists documents, more than the eight the search box offered', shown > 0 && (docCount <= 8 || shown > 8), `${shown} shown of ${docCount}`);
const tag = (await one(`select t from public.attachments a, unnest(a.tags) t where a.tenant_id = $1 and a.superseded_at is null group by t order by count(*) desc limit 1`, [tenant]))?.t;
if (tag) {
  await page.getByLabel('Tag').selectOption(tag); await settle(2000);
  const want = (await one(`select count(*)::int n from public.attachments where tenant_id = $1 and superseded_at is null and $2 = any (tags)`, [tenant, tag])).n;
  ok(`filtering by #${tag} shows exactly those documents`, (await text()).includes(`${want} document${want === 1 ? '' : 's'} match`), (await page.locator('[data-testid="document-count"]').innerText()));
}

// ---------------------------------------------------------------- trackers: decided between, an answer exactly
const decided = await one(`select s.ref_number, (s.closed_at at time zone 'Asia/Dhaka')::date::text d from public.form_submissions s
  where s.tenant_id = $1 and s.status = 'completed' and s.closed_at is not null and s.archived_at is null order by s.closed_at desc limit 1`, [tenant]);
await page.goto(`${BASE}/trackers?as=${FARAH}`); await settle(3500);
ok('the tracker offers "Decided" dates, an exact answer and a date answer', (await page.getByLabel('Decided from').count()) === 1 && (await page.getByLabel('An answer exactly').count()) === 1 && (await page.getByLabel('Date answer').count()) === 1);
if (decided) {
  const [y, m, d] = decided.d.split('-');
  await page.getByLabel('Decided from').fill(`${d}/${m}/${y}`); await page.getByLabel('Decided from').press('Tab');
  await page.getByLabel('Decided to').fill(`${d}/${m}/${y}`); await page.getByLabel('Decided to').press('Tab');
  await settle(2500);
  ok('decided on a day: the request decided that day is listed', (await text()).includes(decided.ref_number), decided.ref_number);
}
const answer = await one(`select v.value, s.ref_number from public.submission_values v join public.form_submissions s on s.id = v.submission_id
  where s.tenant_id = $1 and s.status not in ('draft') and s.archived_at is null and length(v.value) between 6 and 30 and v.value !~ '^[0-9-]+$'
    and v.field_name not in ('Employee name') limit 1`, [tenant]);
if (answer) {
  await page.goto(`${BASE}/trackers?as=${FARAH}`); await settle(3000);
  await page.getByLabel('An answer exactly').fill(answer.value); await settle(2500);
  ok('an answer exactly finds its request', (await text()).includes(answer.ref_number), `${answer.value} → ${answer.ref_number}`);
}

// ---------------------------------------------------------------- report schedules
const rep = await one(`select id, name from public.report_templates where tenant_id = $1 and name = 'Missed deadlines'`, [tenant]);
await page.goto(`${BASE}/reports/${rep.id}?as=${FARAH}`); await settle(3500);
await page.locator('button', { hasText: 'Schedule' }).filter({ hasNotText: 'Save' }).first().click(); await settle(800);
await page.locator('select[name="schedule"]').selectOption('quarterly'); await settle(300);
await page.locator('select[name="schedule-day"]').selectOption('5');
await page.getByLabel('Outside addresses').fill('Audit@Example.com, finance-control@example.com');
await page.getByRole('button', { name: 'Save schedule' }).click(); await settle(2500);
const sch = await one(`select schedule, schedule_day, external_recipients from public.report_templates where id = $1`, [rep.id]);
ok('a report can be sent quarterly on a set day, to outside addresses', sch.schedule === 'quarterly' && sch.schedule_day === 5
  && JSON.stringify(sch.external_recipients) === JSON.stringify(['audit@example.com', 'finance-control@example.com']), JSON.stringify(sch));
ok('...and says so in words', /Quarterly on the 5th/.test(await text()));
await page.locator('button', { hasText: 'Schedule' }).filter({ hasNotText: 'Save' }).first().click(); await settle(800);
await page.locator('select[name="schedule"]').selectOption('daily');
await page.getByRole('button', { name: 'Save schedule' }).click(); await settle(2000);
ok('...or every working day', (await one(`select schedule from public.report_templates where id = $1`, [rep.id])).schedule === 'daily');

// ---------------------------------------------------------------- two-step sign-in policy
await page.goto(`${BASE}/admin/users?as=${FARAH}`); await settle(3500);
ok('Users shows the two-step sign-in policy', (await page.locator('[data-testid="mfa-policy"]').count()) === 1);
await page.locator('[data-testid="mfa-policy"] input[value="admins"]').click(); await settle(2000);
const pol = await one(`select require_admin_mfa, require_mfa_all from public.tenants where id = $1`, [tenant]);
ok('requiring it is refused to somebody not signed in with it, who could not undo it', pol.require_admin_mfa === false
  && /before requiring it of others/.test(await text()), JSON.stringify(pol));

// ---------------------------------------------------------------- team watchers in the builder
const form = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Leave Application'`, [tenant]);
await page.goto(`${BASE}/builder/notifications?templateId=${form.id}&as=${FARAH}`); await settle(4000);
await page.getByRole('button', { name: /Add Person/ }).click(); await settle(500);
const opts = await page.locator('section', { hasText: 'Additional people to notify' }).getByLabel('Who').last().locator('option').allInnerTexts();
ok('a watcher can be a department, a role\'s holders or an email address', opts.some((o) => /^Everyone in Compliance$/.test(o))
  && opts.some((o) => /^Everyone holding the .+ role$/.test(o)) && opts.includes('An email address…'), opts.slice(0, 8).join(' | '));

// ---------------------------------------------------------------- analytics wording
await page.goto(`${BASE}/analytics?as=${LENA}`); await settle(4000);
ok('analytics names its open count for what it counts', /Raised and still open/.test(await text()));
ok('the Outcomes panel shows the shares', (await page.locator('[data-testid="outcome-shares"]').count()) === 1);

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
