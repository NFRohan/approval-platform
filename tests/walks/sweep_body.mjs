// ================================================================ the sweep: every screen, as each persona
// Visits every screen as the people who would use it, at desktop and
// phone width; screenshots each (and each tab); and checks every page
// for what a person would notice: errors, sideways scrolling, the
// browser's own unstyled controls, placeholder words, a spinner that
// never stops, broken images, a dropdown with nothing to choose, links
// that lead nowhere. Writes sweep/report.json beside the screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
const OUT = new URL('../sweep/', import.meta.url).pathname.replace(/^\//, '');
mkdirSync(OUT, { recursive: true });

const ADMIN = 'EMP-0445', TOM = 'EMP-2847', SAM = 'EMP-1134', LENA = 'EMP-0830';
const id = async (sql, p = [tenant]) => (await one(sql, p))?.id;
const ids = {
  form: await id(`select id from public.form_templates where tenant_id = $1 and status = 'published' order by name limit 1`),
  tomSub: await id(`select id from public.form_submissions where tenant_id = $1 and submitted_by = '${TOM}' and status <> 'draft' order by submitted_at desc limit 1`),
  doneSub: await id(`select id from public.form_submissions where tenant_id = $1 and submitted_by = '${TOM}' and status = 'completed' order by submitted_at desc limit 1`),
  samStep: await id(`select submission_id id from public.approval_requests where tenant_id = $1 and approver_user_id = '${SAM}' and status = 'pending' and submission_id is not null limit 1`),
  exitSub: await id(`select s.id from public.form_submissions s join public.form_templates t on t.id = s.form_template_id where s.tenant_id = $1 and t.name = 'Employee Exit Clearance' order by s.submitted_at desc limit 1`),
  notice: await id(`select id from public.notices where tenant_id = $1 limit 1`),
  campaign: await id(`select id from public.campaigns where tenant_id = $1 limit 1`),
  report: await id(`select id from public.report_templates where tenant_id = $1 limit 1`),
};
const exitBy = (await one(`select submitted_by from public.form_submissions where id = $1`, [ids.exitSub]))?.submitted_by;
const forms = await rows(`select id, name from public.form_templates where tenant_id = $1 and status = 'published' order by name`, [tenant]);
console.log('ids', JSON.stringify(ids), forms.length, 'forms');

const plan = [];
const add = (who, path, opts = {}) => plan.push({ who, path, ...opts });
// The system administrator: every screen, every tab.
for (const p of ['/', '/forms', '/submissions', '/trackers', '/notices', '/notices/new', '/movement-orders',
  '/approvals', '/approvals/history', '/approvals/delegate', '/activity', '/account',
  '/builder', '/builder/approvers', '/builder/notifications',
  '/admin/users', '/admin/roles', '/admin/people', '/admin/email', '/admin/integrations', '/admin/audit',
  '/admin/calendar', '/admin/checklists', '/analytics', '/reports', '/reports/new', ...(ids.report ? [`/reports/${ids.report}`] : []),
  '/campaigns', `/campaigns/${ids.campaign}`, `/notices/${ids.notice}`, '/developers']) add(ADMIN, p, { tabs: true });
// The requester: what Tom does, on a desk and on a phone, and every form he can fill in.
for (const p of ['/', '/forms', '/submissions', '/trackers', '/notices', '/movement-orders', '/account',
  `/status/${ids.tomSub}`, `/status/${ids.doneSub}`]) { add(TOM, p); add(TOM, p, { phone: true }); }
for (const f of forms) add(TOM, `/forms/${f.id}`, { label: f.name });
add(TOM, `/forms/${forms[0].id}`, { phone: true, label: forms[0].name });
// The approver.
for (const p of ['/', '/approvals', '/approvals/history', '/approvals/delegate', `/status/${ids.samStep}`]) { add(SAM, p); add(SAM, p, { phone: true }); }
// The leaver's clearance and its certificate, as the leaver.
add(exitBy, `/status/${ids.exitSub}`); add(exitBy, `/certificate/${ids.exitSub}`);
// The auditor.
for (const p of ['/', '/analytics', '/reports', '/admin/audit', '/trackers', '/activity']) add(LENA, p, { tabs: true });

// --------------------------------------------------------------- the checks, run in the page
const CHECK = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const out = [];
  const W = window.innerWidth;
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 2) {
    // The outermost things that stick out.
    const wide = [...document.querySelectorAll('body *')].filter((e) => vis(e) && e.getBoundingClientRect().right > W + 2)
      .filter((e) => !e.parentElement || e.parentElement.getBoundingClientRect().right <= W + 2).slice(0, 4)
      .map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').slice(0, 3).join('.') : ''} "${(e.innerText || '').slice(0, 40).replace(/\s+/g, ' ')}" right=${Math.round(e.getBoundingClientRect().right)}`);
    out.push(`sideways scroll: page is ${sw}px on a ${W}px screen; ${wide.join(' | ')}`);
  }
  for (const f of document.querySelectorAll('input[type=file]')) if (vis(f)) out.push(`the browser's own file picker is showing (${f.getAttribute('aria-label') || f.name || 'unnamed'})`);
  for (const el of document.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select, textarea, button')) {
    if (!vis(el)) continue;
    const s = getComputedStyle(el);
    if (s.borderTopStyle === 'inset' || s.borderTopStyle === 'outset' || s.backgroundColor === 'rgb(239, 239, 239)' || s.backgroundColor === 'rgb(240, 240, 240)')
      out.push(`unstyled ${el.tagName.toLowerCase()} "${(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 30)}" (border ${s.borderTopStyle}, bg ${s.backgroundColor})`);
  }
  for (const s of document.querySelectorAll('select')) if (vis(s) && s.options.length <= 1) out.push(`dropdown with ${s.options.length} option(s): "${(s.getAttribute('aria-label') || s.name || s.options[0]?.text || '').slice(0, 40)}"`);
  for (const i of document.querySelectorAll('img')) if (vis(i) && i.complete && i.naturalWidth === 0) out.push(`broken image ${i.src.slice(0, 80)}`);
  const text = document.body.innerText;
  const m = text.match(/\b(the organisation|lorem|TODO|FIXME|undefined|NaN|\[object Object\]|Invalid Date|null)\b/g);
  if (m) {
    const uniq = [...new Set(m)];
    for (const w of uniq) { const i = text.indexOf(w); out.push(`suspicious text "${w}": …${text.slice(Math.max(0, i - 50), i + 50).replace(/\s+/g, ' ')}…`); }
  }
  if (/Loading…|Loading\.\.\.|Loading certificate/.test(text)) { const i = text.search(/Loading/); out.push(`still loading after the wait: …${text.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ')}…`); }
  if (/Page not found|\b404\b/.test(text) && !/records\//.test(location.pathname)) out.push('shows the not-found page');
  if (/Something went wrong|Unexpected error|Error:/.test(text)) { const i = text.search(/Something went wrong|Unexpected error|Error:/); out.push(`error text: …${text.slice(i, i + 100).replace(/\s+/g, ' ')}…`); }
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h && h.startsWith('/') && !h.startsWith('//'));
  const tabs = [...document.querySelectorAll('[role=tab]')].filter(vis).map((t) => (t.innerText || '').trim()).filter(Boolean);
  return { out, links, tabs, height: document.documentElement.scrollHeight };
};

const report = [];
const allLinks = new Map();
let n = 0;
const slug = (s) => s.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'id').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50) || 'home';
async function snap(entry, suffix = '') {
  const r = await page.evaluate(CHECK);
  const errs = pageErrors.splice(0);
  n += 1;
  const file = `${String(n).padStart(3, '0')}-${entry.who}-${slug(entry.label ?? entry.path)}${suffix ? '-' + slug(suffix) : ''}${entry.phone ? '-phone' : ''}.png`;
  const vp = page.viewportSize();
  await page.screenshot({ path: OUT + file, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: Math.min(r.height, entry.phone ? 2600 : 2200) } }).catch(async () => {
    await page.screenshot({ path: OUT + file });
  });
  for (const l of r.links) if (!allLinks.has(l.split('?')[0])) allLinks.set(l.split('?')[0], `${entry.who} ${entry.path}`);
  report.push({ file, who: entry.who, path: entry.path, label: entry.label, tab: suffix || undefined, phone: !!entry.phone,
                problems: [...r.out, ...errs.filter((e) => !/status of 404/.test(e)).map((e) => 'page error: ' + e.slice(0, 200))] });
  return r;
}

for (const entry of plan) {
  await page.setViewportSize(entry.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  pageErrors.splice(0);
  await page.goto(`${BASE}${entry.path}${entry.path.includes('?') ? '&' : '?'}as=${entry.who}`);
  await settle(entry.path.startsWith('/records') ? 1500 : 3200);
  const r = await snap(entry);
  if (entry.tabs && !entry.phone && r.tabs.length > 1) {
    for (const t of r.tabs.slice(1)) {
      try {
        await page.getByRole('tab', { name: t, exact: true }).first().click({ timeout: 4000 });
        await settle(2200);
        await snap(entry, t);
      } catch (e) { report.push({ who: entry.who, path: entry.path, tab: t, problems: [`could not open the tab: ${String(e.message).slice(0, 120)}`] }); }
    }
  }
}

// The approval record is a PDF download: fetched, not opened.
{
  await page.goto(`${BASE}/?as=${TOM}`); await settle(2500);
  const got = await page.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, head: String.fromCharCode(...b.slice(0, 4)) }; }, `/records/${ids.doneSub}`);
  const res = { status: () => got.status }; const head = got.head;
  report.push({ who: TOM, path: `/records/${ids.doneSub}`, problems: head === '%PDF' ? [] : [`the approval record is not a PDF (status ${res.status()}, starts ${JSON.stringify(head)})`] });
}

// Every link seen, once, as the administrator: does it lead anywhere?
await page.setViewportSize({ width: 1440, height: 900 });
const seen = new Set(plan.map((p) => p.path));
const dead = [];
for (const [href, from] of allLinks) {
  if (seen.has(href) || /^\/(files|records|exports|topsheet|api|cron|webhooks|inbound|integrations)\//.test(href)) continue;
  try { await page.goto(`${BASE}${href}?as=${ADMIN}`); } catch { continue; }
  await settle(1800);
  const t = await text();
  if (/Page not found/.test(t)) dead.push(`${href} (linked from ${from})`);
}

writeFileSync(OUT + 'report.json', JSON.stringify({ pages: report.length, dead, report }, null, 1));
const flagged = report.filter((r) => r.problems.length);
console.log(`SWEEP: ${report.length} screens, ${flagged.length} with something flagged, ${dead.length} dead links, ${allLinks.size} links seen`);
await browser.close(); await local.stop();
process.exit(0);
