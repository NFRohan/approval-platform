// ================================================================ draft forms
// A form not yet published, or unpublished, used to vanish: Available
// Forms lists published ones and the builder opens on a new form. Now
// whoever builds forms sees them under Drafts, to finish or delete.
await page.goto('about:blank'); await settle(1000);
const FARAH = 'EMP-0445';
const blank = (await one(`insert into public.form_templates (tenant_id, name, status, created_by, category)
  values ($1, 'QA half-built form', 'draft', $2, 'Admin') returning id`, [tenant, FARAH])).id;

await page.goto(`${BASE}/forms?as=${FARAH}`); await settle(3500);
const drafts = page.locator('[data-testid="draft-forms"]');
ok('Available Forms shows a Drafts section to a form builder', (await drafts.count()) === 1 && (await drafts.innerText()).includes('QA half-built form'));

// Unpublishing a form with requests moves it to Drafts, where it cannot be deleted.
const used = await one(`select f.id, f.name from public.form_templates f where f.tenant_id = $1 and f.status = 'published' and f.category = 'Admin'
  and exists (select 1 from public.form_submissions s where s.form_template_id = f.id) order by f.name limit 1`, [tenant]);
await page.locator('input[aria-label="Find a form"]').fill(used.name); await settle(800);
const card = page.locator('.rounded-xl.border', { hasText: used.name }).first();
await card.getByRole('button', { name: 'Unpublish form' }).click(); await settle(300);
await card.getByRole('button', { name: 'Yes' }).click(); await settle(2500);
ok(`unpublishing ${used.name} moves it to Drafts`, (await one(`select status from public.form_templates where id = $1`, [used.id])).status === 'draft'
  && (await drafts.innerText()).includes(used.name));
const usedRow = drafts.locator('div', { hasText: used.name }).filter({ has: page.getByRole('button', { name: 'Delete' }) }).last();
ok('...and, having requests, cannot be deleted', await usedRow.getByRole('button', { name: 'Delete' }).isDisabled() && /raised while it was published/.test(await usedRow.innerText()));

// An unused draft is deleted for good.
const blankRow = drafts.locator('div', { hasText: 'QA half-built form' }).filter({ has: page.getByRole('button', { name: 'Delete' }) }).last();
await blankRow.getByRole('button', { name: 'Delete' }).click(); await settle(300);
await drafts.locator('span', { hasText: 'Delete it for good?' }).getByRole('button', { name: /^Delete$/ }).click(); await settle(2500);
ok('an unused draft is deleted', !(await one(`select 1 x from public.form_templates where id = $1`, [blank])) && !(await drafts.innerText()).includes('QA half-built form'));

// Edit and publish opens the builder on it.
await drafts.locator('div', { hasText: used.name }).getByRole('button', { name: /Edit and publish/ }).last().click(); await settle(3500);
ok('Edit and publish opens it in the builder', page.url().includes(`templateId=${used.id}`), page.url());
await db.query(`update public.form_templates set status = 'published' where id = $1`, [used.id]);

// Somebody who does not build forms sees no Drafts.
await page.goto(`${BASE}/forms?as=EMP-2847`); await settle(3500);
ok('a requester sees no Drafts section', (await page.locator('[data-testid="draft-forms"]').count()) === 0);

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
