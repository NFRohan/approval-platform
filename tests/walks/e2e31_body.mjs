// ================================================================ throwing drafts away
// SOW 2.1 Save draft: "provision to save any request and work later the
// same document". A draft nobody will finish can be deleted, from My
// Submissions or from the form itself, by whoever started it.

await page.goto('about:blank'); await settle(1000);
const TOM = 'EMP-2847';
const src = (await one(`select id from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status <> 'draft' order by submitted_at desc limit 1`, [tenant, TOM])).id;
const mkDraft = async () => {
  await db.exec(`begin;
    select set_config('app.tenant_id', '${tenant}', true), set_config('app.employee_id', '${TOM}', true), set_config('app.role', 'admin', true);
    select public.copy_submission('${src}', '${TOM}');
    commit;`);
  return (await one(`select id, form_template_id from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status = 'draft' order by submitted_at desc limit 1`, [tenant, TOM]));
};

// ---------------------------------------------------------------- from My Submissions
const d1 = await mkDraft();
const drafts0 = (await one(`select count(*)::int n from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status = 'draft'`, [tenant, TOM])).n;
await page.goto(`${BASE}/submissions?as=${TOM}`); await settle(3500);
const del = page.getByRole('button', { name: 'Delete draft' });
ok('a draft in My Submissions has a Delete button', (await del.count()) >= 1);
ok('...and nothing else does', (await del.count()) === drafts0, `${await del.count()} buttons, ${drafts0} drafts`);
await del.first().click(); await settle(400);
ok('it asks first', /Delete this draft\?/.test(await text()));
await page.getByRole('button', { name: 'Keep' }).click(); await settle(400);
ok('Keep leaves it', (await one(`select count(*)::int n from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status = 'draft'`, [tenant, TOM])).n === drafts0);
await del.first().click(); await settle(400);
await page.getByRole('button', { name: /^Delete$/ }).click(); await settle(2500);
const drafts1 = (await one(`select count(*)::int n from public.form_submissions where tenant_id = $1 and submitted_by = $2 and status = 'draft'`, [tenant, TOM])).n;
ok('Delete removes it, and the list with it', drafts1 === drafts0 - 1 && (await del.count()) === drafts1, `${drafts0} → ${drafts1}`);

// ---------------------------------------------------------------- from the form, once reopened
const d2 = await mkDraft();
await page.goto(`${BASE}/forms/${d2.form_template_id}?draft=${d2.id}&as=${TOM}`); await settle(3500);
for (let i = 0; i < 8 && !(await page.getByRole('button', { name: 'Delete draft' }).count()); i++) {
  const next = page.getByRole('button', { name: /^Next/ });
  if (!(await next.count())) break;
  await next.click(); await settle(900);
}
ok('a reopened draft offers Delete draft beside Update draft', (await page.getByRole('button', { name: 'Delete draft' }).count()) === 1);
await page.getByRole('button', { name: 'Delete draft' }).click(); await settle(400);
await page.getByRole('button', { name: /^Delete$/ }).click(); await settle(2500);
ok('...which deletes it and goes back to My Submissions', !(await one(`select 1 x from public.form_submissions where id = $1`, [d2.id])) && page.url().includes('/submissions'), page.url());
void d1;

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
