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

// A column change Lubna asked for, waiting for an administrator.
await db.exec(`begin;
  select set_config('app.tenant_id', '${tenant}', true), set_config('app.employee_id', 'EMP-0830', true),
         set_config('app.role', 'admin', true), set_config('app.mfa', 'true', true);
  select public.request_report_change(t.id, t.columns || array['priority'], 'For the monthly compliance pack')
    from public.report_templates t where t.tenant_id = '${tenant}' and t.name = 'Missed deadlines';
  commit;`);
// A draft Towhid started and has not finished.
await db.exec(`begin;
  select set_config('app.tenant_id', '${tenant}', true), set_config('app.employee_id', 'EMP-2847', true), set_config('app.role', 'admin', true);
  select public.copy_submission(s.id, 'EMP-2847') from public.form_submissions s
   join public.form_templates f on f.id = s.form_template_id
   where s.tenant_id = '${tenant}' and s.submitted_by = 'EMP-2847' and f.name = 'Travel & Expense Reimbursement' and s.status <> 'draft' limit 1;
  commit;`);
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
  `/builder?templateId=${ids.capexForm}`, `/builder/approvers?templateId=${ids.capexForm}`, `/builder/notifications?templateId=${ids.capexForm}`,
  '/admin/users', '/admin/roles', '/admin/people', '/admin/email', '/admin/integrations', '/admin/audit',
  '/admin/calendar', '/admin/checklists', '/analytics', '/reports', '/reports/new', `/reports/${ids.report}`,
  '/campaigns', `/campaigns/${ids.campaign}`, `/notices/${ids.notice}`, '/developers', '/documents']) add(ADMIN, p, { tabs: true });
for (const p of ['/', '/forms', '/submissions', '/trackers', '/notices', `/status/${ids.capexOverdue}`, `/status/${ids.exitOpen}`, `/status/${ids.gift}`])
  add(TOWHID, p);
for (const f of forms) add(TOWHID, `/forms/${f.id}`, { label: f.name });
add(TOWHID, '/', { phone: true }); add(TOWHID, '/forms', { phone: true }); add(TOWHID, `/forms/${ids.capexForm}`, { phone: true });
for (const p of ['/', '/approvals', '/approvals/history', `/status/${ids.capexWaiting}`]) add(SAIFUL, p);
add(SAIFUL, '/approvals', { phone: true });
add('EMP-3120', `/status/${ids.exitDone}`); add('EMP-3120', `/certificate/${ids.exitDone}`);
add(TANVIR, '/approvals'); add(MITU, `/status/${ids.campaignReq}`);
add('EMP-0520', '/approvals'); add('EMP-0520', '/admin/roles');
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
<div id="mock-bar"><div id="mock-list"></div><button type="button" id="mock-toggle">All screens</button></div>
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
    f.onload = () => f.contentDocument.addEventListener('click', (e) => handle(e, true));
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
// The app moves between pages with buttons its router handles, not
// links; here they are matched by what they say.
const NAV = { 'Dashboard': '/', 'Home': '/', 'Pending Approvals': '/approvals', 'Approval History': '/approvals/history',
  'Delegation': '/approvals/delegate', 'Form Builder': '/builder', 'Published Forms': '/forms', 'Available Forms': '/forms',
  'Forms': '/forms', 'My Submissions': '/submissions', 'Requests': '/submissions', 'Movement Orders': '/movement-orders',
  'Notice Board': '/notices', 'Activity Log': '/activity', 'Analytics': '/analytics', 'Reports': '/reports',
  'Campaigns': '/campaigns', 'Trackers': '/trackers', 'Users': '/admin/users', 'Roles': '/admin/roles',
  'People & Directory': '/admin/people', 'Working Calendar': '/admin/calendar', 'Clearance Checklists': '/admin/checklists',
  'Email': '/admin/email', 'Integrations': '/admin/integrations', 'Audit Centre': '/admin/audit', 'Account': '/account',
  'Approvals': '/approvals', 'Developers': '/developers', 'Documents': '/documents' };
const NAV_KEYS = Object.keys(NAV).sort((a, b) => b.length - a.length);
const REFS = {};
for (const p of INDEX) {
  if (!p.path.startsWith('/status/') || p.tab || p.phone) continue;
  const m = document.getElementById(p.k).content.textContent.match(/AMS-\\d{4}-\\d{5}/);
  if (m && !REFS[m[0]]) REFS[m[0]] = p.k;
}
const FORMS = INDEX.filter((p) => p.path.startsWith('/forms/') && !p.phone && p.label !== p.path);
const go = (k) => { if (k) { show(k, true); return true; } return false; };
function handle(e, inPhone) {
  const a = e.target.closest('a[href]');
  if (a && a.dataset.k) { e.preventDefault(); return go(a.dataset.k); }
  if (a && a.getAttribute('href').startsWith('/')) { e.preventDefault(); return go(find(a.getAttribute('href'), inPhone)); }
  if (e.target.closest('#mock-bar')) return false;
  // A tab captured separately: switch to that capture.
  const tab = e.target.closest('[role=tab]');
  if (tab && current) {
    const name = (tab.innerText || '').trim();
    const base = INDEX.find((p) => p.path === current.path && p.who === current.who && !p.tab && !p.phone);
    const hit = INDEX.find((p) => p.path === current.path && p.who === current.who && p.tab === name);
    return go((hit || base || {}).k);
  }
  const btn = e.target.closest('button, [role=button], [role=menuitem]');
  // Expanding or collapsing the sidebar: the other sidebar, as saved on
  // another screen of the same person.
  const toggle = btn && btn.title;
  if (toggle === 'Expand sidebar' || toggle === 'Collapse sidebar') {
    e.preventDefault();
    const want = toggle === 'Expand sidebar' ? 'Collapse sidebar' : 'Expand sidebar';
    const from = INDEX.filter((p) => !p.phone && document.getElementById(p.k).content.querySelector('aside button[title="' + want + '"]'))
      .sort((a, b) => (b.who === current?.who) - (a.who === current?.who))[0];
    const here = btn.closest('aside');
    if (from && here) here.replaceWith(document.getElementById(from.k).content.querySelector('aside').cloneNode(true));
    return true;
  }
  const label = btn ? ((btn.innerText || '').trim().split('\\n')[0].trim() || btn.title || btn.getAttribute('aria-label') || '') : '';
  // The person switcher: the list of every screen, by person.
  if (btn && current && (btn.innerText || '').includes(current.person)) { e.preventDefault(); list.classList.add('open'); return true; }
  if (btn && label) {
    const key = NAV_KEYS.find((k) => label === k || label.startsWith(k));
    if (key && go(find(NAV[key], inPhone))) { e.preventDefault(); return true; }
  }
  // The form builder's three steps, and its Next and Back.
  if (current && current.path.startsWith('/builder')) {
    const STEPS = ['/builder', '/builder/approvers', '/builder/notifications'];
    let s = e.target;
    for (let i = 0; s && i < 4; i++, s = s.parentElement) {
      const t = (s.innerText || '').replace(/\\s+/g, ' ').trim();
      const m = t.match(/^(?:\\d )?(Fields|Approvers|Notifications)$/);
      if (m) return go(find(STEPS[['Fields', 'Approvers', 'Notifications'].indexOf(m[1])]));
    }
    const at = STEPS.indexOf(current.path);
    if (/^Next/.test(label) && at >= 0 && at < 2) return go(find(STEPS[at + 1]));
    if (/^(Back|Previous)/.test(label) && at > 0) return go(find(STEPS[at - 1]));
  }
  // A row or card naming a request, or a form.
  let el = e.target;
  for (let i = 0; el && i < 6; i++, el = el.parentElement) {
    const t = el.innerText || '';
    const m = t.match(/AMS-\\d{4}-\\d{5}/g);
    if (m && new Set(m).size === 1 && REFS[m[0]] && REFS[m[0]] !== current?.k) return go(REFS[m[0]]);
    const fs = FORMS.filter((p) => t.includes(p.label));
    if (fs.length === 1 && t.length < 400 && current?.path !== fs[0].path) return go(fs[0].k);
  }
  return false;
}
document.addEventListener('click', (e) => { if (!e.target.closest('#mock-list, #mock-toggle')) list.classList.remove('open'); handle(e, false); });
window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (k && k !== current?.k && document.getElementById(k)) show(k, false); });
show((location.hash.slice(1) && document.getElementById(location.hash.slice(1))) ? location.hash.slice(1) : INDEX[0].k, false);
</script>
</body></html>`;
writeFileSync(OUTDIR + 'ams-mock.html', html.replaceAll(BASE, 'https://approval-platform-omega.vercel.app').replaceAll(USER, 'bkash.eval'));
console.log('wrote', OUTDIR + 'ams-mock.html', (html.length / 1024 / 1024).toFixed(1) + ' MB', pages.length, 'screens');
await browser.close();
local.stop?.();
process.exit(0);
