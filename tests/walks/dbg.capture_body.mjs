// ================================================================ capture: the whole app as one static HTML file
// For design work: every screen, as the people who use it, rendered by
// the production build and saved as static markup with the app's own CSS
// inlined. Links between captured screens work; nothing else does.
// Writes dist-mock/ams-mock.html.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const OUTDIR = REPO + 'dist-mock/';
mkdirSync(OUTDIR, { recursive: true });

// ---- the bKash look: local names, the organisation's name, the staged demo
await db.query(`select set_config('app.is_staff', 'true', false)`);
await db.query(`update public.tenants set name = 'bKash' where id = $1`, [tenant]);
await db.query(`select app.localise_names($1)`, [tenant]);
const slugRow = await one(`select slug from public.tenants where id = $1`, [tenant]);
// The local database takes one connection at a time: let the app's pool
// (idle after 10 s) let go of it first.
await page.goto('about:blank');
await settle(13000);
await new Promise((res, rej) => {
  const c = spawn(process.execPath, [REPO + 'scripts/stage-demo.mjs', slugRow.slug], {
    env: { ...process.env, DATABASE_URL: local.url, DIRECT_URL: '' } });
  let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d));
  c.on('close', (code) => { console.log(o.slice(-1500)); code === 0 ? res() : rej(new Error('staging failed')); });
});

const ADMIN = 'EMP-0445', TOWHID = 'EMP-2847', SAIFUL = 'EMP-1134', LUBNA = 'EMP-0830', MITU = 'EMP-0416', TANVIR = 'EMP-0411';
const id = async (sql, p = [tenant]) => (await one(sql, p))?.id;
const byRef = async (title) => id(`select s.id from public.form_submissions s join public.submission_values v on v.submission_id = s.id
                                     where s.tenant_id = $1 and v.value = $2 limit 1`, [tenant, title]);
const ids = {
  capexWaiting: await byRef('Branch office UPS replacement'),
  capexOverdue: await byRef('Call centre headset refresh'),
  campaignReq: await byRef('Pohela Falgun Send Money Offer'),
  exitOpen: await id(`select s.id from public.form_submissions s join public.submission_values v on v.submission_id = s.id
                       where s.tenant_id = $1 and s.submitted_by = 'EMP-2847' and v.value = '2026-12-10' limit 1`),
  exitDone: await id(`select s.id from public.form_submissions s join public.submission_values v on v.submission_id = s.id
                       where s.tenant_id = $1 and s.submitted_by = 'EMP-3120' and v.value = '2026-11-20' limit 1`),
  gift: await byRef('Grameenphone Ltd.'),
  notice: await id(`select id from public.notices where tenant_id = $1 limit 1`),
  campaign: await id(`select id from public.campaigns where tenant_id = $1 and name = 'Boishakhi Cashback 2026'`),
  report: await id(`select id from public.report_templates where tenant_id = $1 order by name limit 1`),
  capexForm: await id(`select id from public.form_templates where tenant_id = $1 and name = 'Capital Expenditure Request'`),
};
console.log('ids', JSON.stringify(ids));
const forms = await rows(`select id, name from public.form_templates where tenant_id = $1 and status = 'published' order by name`, [tenant]);

const plan = [];
const add = (who, path, opts = {}) => plan.push({ who, path, ...opts });
for (const p of ['/', '/forms', '/submissions', '/trackers', '/notices', '/notices/new', '/movement-orders',
  '/approvals', '/approvals/history', '/approvals/delegate', '/activity', '/account',
  `/builder?form=${ids.capexForm}`, `/builder/approvers?form=${ids.capexForm}`, `/builder/notifications?form=${ids.capexForm}`,
  '/admin/users', '/admin/roles', '/admin/people', '/admin/email', '/admin/integrations', '/admin/audit',
  '/admin/calendar', '/admin/checklists', '/analytics', '/reports', '/reports/new', `/reports/${ids.report}`,
  '/campaigns', `/campaigns/${ids.campaign}`, `/notices/${ids.notice}`, '/developers']) add(ADMIN, p, { tabs: true });
for (const p of ['/', '/forms', '/submissions', '/trackers', '/notices', `/status/${ids.capexOverdue}`, `/status/${ids.exitOpen}`, `/status/${ids.gift}`])
  add(TOWHID, p);
for (const f of forms) add(TOWHID, `/forms/${f.id}`, { label: f.name });
add(TOWHID, '/', { phone: true }); add(TOWHID, '/forms', { phone: true }); add(TOWHID, `/forms/${ids.capexForm}`, { phone: true });
for (const p of ['/', '/approvals', '/approvals/history', `/status/${ids.capexWaiting}`]) add(SAIFUL, p);
add(SAIFUL, '/approvals', { phone: true });
add('EMP-3120', `/status/${ids.exitDone}`); add('EMP-3120', `/certificate/${ids.exitDone}`);
add(TANVIR, '/approvals'); add(MITU, `/status/${ids.campaignReq}`);
for (const p of ['/analytics', '/trackers', `/status/${ids.gift}`]) add(LUBNA, p);

// ---- capture
const SNAP = () => {
  const root = document.body.cloneNode(true);
  root.querySelectorAll('script, noscript, iframe').forEach((e) => e.remove());
  // What the person typed or chose lives in properties, not attributes.
  const live = document.body.querySelectorAll('input, textarea, select');
  const copy = root.querySelectorAll('input, textarea, select');
  live.forEach((el, i) => {
    const c = copy[i]; if (!c) return;
    if (el.tagName === 'TEXTAREA') c.textContent = el.value;
    else if (el.tagName === 'SELECT') [...c.options].forEach((o, j) => { if (el.options[j]?.selected) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
    else if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); }
    else c.setAttribute('value', el.value);
  });
  const tabs = [...document.querySelectorAll('[role=tab]')].filter((t) => t.getBoundingClientRect().width > 0).map((t) => (t.innerText || '').trim()).filter(Boolean);
  return { html: root.innerHTML, bodyClass: document.body.className, title: document.title, tabs };
};

const pages = [];
const styles = new Set();
const names = Object.fromEntries((await rows(`select employee_id, name from public.employees where tenant_id = $1`, [tenant])).map((r) => [r.employee_id, r.name]));
async function take(entry, tab) {
  const r = await page.evaluate(SNAP);
  for (const s of await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => new URL(l.href).pathname))) styles.add(s);
  for (const s of await page.evaluate(() => [...document.querySelectorAll('style')].map((x) => x.textContent))) styles.add('inline:' + s);
  pages.push({ who: entry.who, person: names[entry.who] ?? entry.who, path: entry.path.split('?')[0], label: entry.label, tab, phone: !!entry.phone, ...r });
  return r;
}
for (const entry of plan) {
  await page.setViewportSize(entry.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.goto(`${BASE}${entry.path}${entry.path.includes('?') ? '&' : '?'}as=${entry.who}`);
  await settle(3200);
  const r = await take(entry);
  if (entry.tabs && !entry.phone && r.tabs.length > 1) {
    for (const t of r.tabs.slice(1)) {
      try {
        await page.getByRole('tab', { name: t, exact: true }).first().click({ timeout: 4000 });
        await settle(2000);
        await take(entry, t);
      } catch (e) { console.log('tab failed', entry.path, t); }
    }
  }
}
ok(`captured ${pages.length} screens`, pages.length > 40);

// ---- assemble
let css = '';
for (const s of styles) {
  if (s.startsWith('inline:')) css += s.slice(7) + '\n';
  else if (existsSync(DIST + '/client' + s)) css += readFileSync(DIST + '/client' + s, 'utf8') + '\n';
}
// Images the pages point at, inlined.
const inlineImgs = (html) => html.replace(/(src|href)="(\/[^"]+\.(?:svg|png|ico|webp))"/g, (m, attr, p) => {
  const f = DIST + '/client' + p;
  if (!existsSync(f)) return m;
  const type = p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/x-icon';
  return `${attr}="data:${type};base64,${readFileSync(f).toString('base64')}"`;
});
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const keyOf = (p, i) => `p${i}`;
const label = (p) => `${p.label ?? p.path}${p.tab ? ' · ' + p.tab : ''}${p.phone ? ' (phone)' : ''}`;
const templates = pages.map((p, i) => `<template id="${keyOf(p, i)}" data-path="${esc(p.path)}" data-who="${p.who}" data-tab="${esc(p.tab ?? '')}" data-phone="${p.phone ? 1 : ''}" data-body-class="${esc(p.bodyClass)}">${inlineImgs(p.html)}</template>`).join('\n');
const index = pages.map((p, i) => ({ k: keyOf(p, i), path: p.path, who: p.who, person: p.person, label: label(p), tab: p.tab ?? '', phone: p.phone }));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AMS mock</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>${css}</style>
<style>
#mock-bar{position:fixed;right:12px;bottom:12px;z-index:2147483000;font:12px/1.4 system-ui,sans-serif}
#mock-bar button{background:#18181b;color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
#mock-list{display:none;position:absolute;right:0;bottom:44px;width:360px;max-height:70vh;overflow:auto;background:#fff;color:#18181b;border:1px solid #e4e4e7;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:8px}
#mock-list.open{display:block}
#mock-list h4{margin:10px 6px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#71717a}
#mock-list a{display:block;padding:5px 8px;border-radius:6px;color:inherit;text-decoration:none}
#mock-list a:hover,#mock-list a.on{background:#f4f4f5}
#mock-stage.phone{padding:8px 0}
</style></head>
<body>
<div id="mock-stage"></div>
<div id="mock-bar"><div id="mock-list"></div><button type="button" id="mock-toggle">Screens</button></div>
${templates}
<script>
// A static capture of the AMS app (bKash evaluation, synthetic data).
// Each screen is a <template>; links between captured screens swap the
// stage. "Screens" (bottom right) lists every capture by person.
const INDEX = ${JSON.stringify(index)};
const stage = document.getElementById('mock-stage');
const list = document.getElementById('mock-list');
let current = null;
function show(k, push) {
  const t = document.getElementById(k); if (!t) return;
  if (t.dataset.phone) {
    // A phone screen gets a phone-sized window of its own, so the app's
    // phone layout applies.
    const f = document.createElement('iframe');
    f.title = 'Phone';
    f.style.cssText = 'width:390px;height:844px;border:0;display:block;margin:24px auto;border-radius:24px;box-shadow:0 0 0 10px #18181b,0 20px 50px rgba(0,0,0,.25);background:#fff';
    f.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + document.querySelector('style').textContent + '</style></head><body class="' + (t.dataset.bodyClass || '') + '">' + t.innerHTML + '</body></html>';
    f.onload = () => f.contentDocument.addEventListener('click', (e) => { const a = e.target.closest('a[href]'); if (a && a.getAttribute('href').startsWith('/')) { e.preventDefault(); const k = find(a.getAttribute('href'), true); if (k) show(k, true); } });
    stage.replaceChildren(f);
    stage.className = 'phone';
    document.body.className = '';
    document.body.style.background = '#f4f4f5';
  } else {
    stage.replaceChildren(t.content.cloneNode(true));
    stage.className = '';
    document.body.className = t.dataset.bodyClass || '';
    document.body.style.background = '';
  }
  current = INDEX.find((p) => p.k === k);
  list.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.k === k));
  if (push) history.replaceState(null, '', '#' + k);
  window.scrollTo(0, 0);
}
function find(path, phone) {
  const clean = path.split('?')[0].split('#')[0] || '/';
  const same = (p) => p.path === clean && !p.tab && !p.phone;
  const samePhone = (p) => p.path === clean && p.phone;
  return ((phone && INDEX.find((p) => samePhone(p) && current && p.who === current.who))
    || INDEX.find((p) => same(p) && current && p.who === current.who) || INDEX.find(same) || {}).k;
}
const groups = {};
for (const p of INDEX) (groups[p.person] ||= []).push(p);
list.innerHTML = Object.entries(groups).map(([who, ps]) => '<h4>' + who + '</h4>' + ps.map((p) => '<a href="#' + p.k + '" data-k="' + p.k + '">' + p.label.replace(/</g, '&lt;') + '</a>').join('')).join('');
document.getElementById('mock-toggle').onclick = () => list.classList.toggle('open');
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a && a.dataset.k) { e.preventDefault(); show(a.dataset.k, true); return; }
  if (a && a.getAttribute('href').startsWith('/')) { e.preventDefault(); const k = find(a.getAttribute('href')); if (k) show(k, true); return; }
  // A tab captured separately: switch to that capture.
  const tab = e.target.closest('[role=tab]');
  if (tab && current) {
    const name = (tab.innerText || '').trim();
    const base = current.tab ? INDEX.find((p) => p.path === current.path && p.who === current.who && !p.tab && !p.phone) : current;
    const k = name === (INDEX.find((p) => p.k === base?.k)?.tab || '') ? base?.k
      : (INDEX.find((p) => p.path === current.path && p.who === current.who && p.tab === name) || base || {}).k;
    if (k) show(k, true);
  }
});
window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (k && k !== current?.k && document.getElementById(k)) show(k, false); });
show((location.hash.slice(1) && document.getElementById(location.hash.slice(1))) ? location.hash.slice(1) : INDEX[0].k, false);
</script>
</body></html>`;
writeFileSync(OUTDIR + 'ams-mock.html', html.replaceAll(BASE, 'https://approval-platform-omega.vercel.app').replaceAll(USER, 'bkash.eval'));
console.log('wrote', OUTDIR + 'ams-mock.html', (html.length / 1024 / 1024).toFixed(1) + ' MB', pages.length, 'screens');
await browser.close();
local.stop?.();
process.exit(0);
