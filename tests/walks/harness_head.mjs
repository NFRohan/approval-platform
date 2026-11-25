// Shared head: the production build against a local PGlite
// evaluation. Parallel clearance, quorum, ask/answer, return, conditional
// routes, recall, cancel, follow-up, and a builder round trip.
import { startLocalDb, REPO, USER, PASS } from './localdb.mjs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const req = createRequire(REPO + 'package.json');
const { chromium } = req('playwright');

const local = await startLocalDb();
process.env.DATABASE_URL = local.url;
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.PGPOOL_MAX = '1';
const { db, tenant } = local;

const DIST = REPO + 'dist';
const server = (await import(pathToFileURL(DIST + '/server/server.js').href)).default;
const BASE = 'https://app.test';
const SECURITY_HEADERS = JSON.parse(await readFile(REPO + 'vercel.json', 'utf8')).headers?.[0]?.headers ?? [];
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let failures = 0;
// A failure keeps a picture of the page as it stood, for the QA report
// (tests/qa-report/shots); QA_SHOTS names the folder when run by npm run qa.
let failShots = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 600)}` : ''}`);
  if (!cond && process.env.QA_SHOTS && typeof page !== 'undefined' && failShots < 5) {
    const file = `${process.env.QA_SHOTS}/${process.env.QA_WALK ?? 'walk'}-${++failShots}.png`;
    console.log(`SHOT  ${file}`);
    page.screenshot({ path: file, fullPage: true }).catch(() => {});
  }
};
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];
const formId = async (name) => (await one(
  `select id from public.form_templates where tenant_id = $1 and name = $2`, [tenant, name])).id;
const subOf = async (form, by) => (await one(
  `select s.id from public.form_submissions s join public.form_templates t on t.id = s.form_template_id
    where s.tenant_id = $1 and t.name = $2 and s.submitted_by = $3 order by s.submitted_at desc limit 1`, [tenant, form, by])).id;
const stepOf = async (sub, who) => (await one(
  `select id from public.approval_requests where submission_id = $1 and approver_user_id = $2
    order by step_index, lane, lane_step limit 1`, [sub, who]))?.id;
const live = async (sub) => (await rows(
  `select approver_user_id from public.approval_requests where submission_id = $1 and status = 'pending'
    order by step_index, lane, lane_step`, [sub])).map((r) => r.approver_user_id).join(',');

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/error occurred when fetching the script/.test(m.text())) pageErrors.push('console: ' + m.text().slice(0, 300)); });  // the harness serves pages, not the service worker's own fetch
await page.route(BASE + '/**', async (route) => {
  const r = route.request();
  const url = new URL(r.url());
  if (url.pathname !== '/' && extname(url.pathname) && !url.pathname.startsWith('/files/')) {
    try {
      return route.fulfill({ status: 200, body: await readFile(DIST + '/client' + decodeURIComponent(url.pathname)), contentType: TYPES[extname(url.pathname)] ?? 'application/octet-stream' });
    } catch {}
  }
  const res = await server.fetch(new Request(r.url(), {
    method: r.method(), headers: await r.allHeaders(),
    body: ['GET', 'HEAD'].includes(r.method()) ? undefined : r.postDataBuffer(),
  }));
  const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
  // The production headers (vercel.json), so a content-policy violation shows up as a page error here.
  for (const h of SECURITY_HEADERS) headers[h.key.toLowerCase()] = h.value;
  // Each Set-Cookie separately: joined with commas they are ambiguous.
  if (res.headers.getSetCookie?.().length) headers['set-cookie'] = res.headers.getSetCookie().join(String.fromCharCode(10));
  await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
});
const settle = (ms = 1500) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: new URL(`./${name}.png`, import.meta.url).pathname.replace(/^\//, ''), fullPage: true });
const text = () => page.locator('body').innerText();

// Approve, as someone, the step they hold on a submission, from their queue.
async function approveAs(who, sub) {
  const id = await stepOf(sub, who);
  // A department's checklist is ticked before its step is approved, as
  // its approver would (the ticking itself is walked in e2e15).
  await page.goto('about:blank');
  await settle(800);
  await db.query(`insert into public.checklist_ticks (tenant_id, submission_id, item_id, done_by)
    select ar.tenant_id, ar.submission_id, i.id, ar.approver_user_id from public.approval_requests ar
      join public.form_submissions s on s.id = ar.submission_id
      join public.checklist_items i on i.tenant_id = ar.tenant_id and i.form_template_id = s.form_template_id and i.active
                                   and i.track = app.checklist_track(ar.lane_label, ar.stage_label)
     where ar.id = $1 on conflict do nothing`, [id]);
  await page.goto(`${BASE}/approvals?as=${who}`);
  await settle(2500);
  const btn = page.locator(`#approval-${id}`).getByRole('button', { name: /^Approve$/ });
  if (!(await btn.count())) {
    await shot(`fail-approve-${who}`);
    const ids = await page.locator('[id^="approval-"]').evaluateAll((els) => els.map((e) => e.id));
    console.log(`  debug: ${who} queue has ${ids.length} rows, wanted approval-${id}; header:`,
      (await page.locator('body').innerText()).slice(0, 300).replace(/\s+/g, ' '));
    console.log('  debug rows', ids.join(' '));
  }
  await btn.click({ timeout: 5000 });
  await settle(2000);
}
async function field(label) {
  return page.getByText(label, { exact: true }).first().locator('xpath=ancestor::div[.//input or .//select or .//textarea][1]');
}

// ---------------------------------------------------------------- sign in
await page.goto(BASE + '/login');
await page.locator('input[autocomplete="username"]').fill(USER);
await page.locator('input[autocomplete="current-password"]').fill(PASS);
await page.locator('input[autocomplete="current-password"]').press('Enter');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

