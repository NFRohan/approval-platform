// ================================================================ visual fixes, looked at
const sub = await one(`select id from public.form_submissions where tenant_id = $1 and submitted_by = 'EMP-2847' and status <> 'draft' order by submitted_at desc limit 1`, [tenant]);
const leave = await one(`select id from public.form_templates where tenant_id = $1 and name = 'Leave Application'`, [tenant]);
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/status/${sub.id}?as=EMP-2847`); await settle(3500);
await page.screenshot({ path: 'v-status-phone.png' });
const sw = await page.evaluate(() => document.documentElement.scrollWidth);
ok('status page fits a phone', sw <= 392, String(sw));
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/trackers?as=EMP-0830`); await settle(3500);
await page.screenshot({ path: 'v-trackers.png' });
const dims = await page.evaluate(() => { const t = document.querySelector('[data-testid=tracker-rows]'); const w = t.parentElement; return { table: t.scrollWidth, card: w.clientWidth, cols: [...t.querySelectorAll('thead th')].map((h) => Math.round(h.getBoundingClientRect().width)) }; });
ok('tracker table fits its card', dims.table <= dims.card + 1, JSON.stringify(dims));
await page.goto(`${BASE}/forms/${leave.id}?as=EMP-2847`); await settle(3000);
const t = await text();
ok('a leave form neither says departing employee nor offers the NFA import', !/departing employee/.test(t) && !/vetted NFA/.test(t), t.slice(0, 300));
await page.screenshot({ path: 'v-leave.png' });
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
