const f = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Night Allowance'`, [tenant]);
await page.goto(`${BASE}/forms/${f.id}?as=EMP-2847`); await settle(3500);
for (let i = 0; i < 3 && !(await text()).includes('Nights worked'); i++) { await page.getByRole('button', { name: /Next|Continue/ }).first().click().catch(() => {}); await settle(1200); }
const inputs = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => `${i.type}|${i.getAttribute('aria-label') ?? i.name ?? ''}|${i.placeholder}`));
console.log('INPUTS', JSON.stringify(inputs));
const t = await text(); const i = t.indexOf('Total allowance'); console.log('CALC', t.slice(i, i + 120).replace(/\s+/g, ' '));
await browser.close(); await local.stop(); process.exit(0);
