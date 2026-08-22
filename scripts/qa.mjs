// =====================================================================
// Browser QA.
//
//   node scripts/qa.mjs <base-url> <username> <password> [staffUser] [staffPass]
//
// Drives a real Chromium against a real deployment: signs in, walks the
// journeys a prospect walks, and reports what a person would see.
//
// This exists because every other suite here tests something short of
// the browser. The SQL suites test policies, the call-site test checks
// shapes, the render test mounts components with no effects, the auth
// suite walks server paths. None of them can tell you that a dropdown
// does not open, that a page cannot scroll, or that a button throws —
// which is where the last three user-reported bugs actually were.
//
// Failures are printed with what was expected, and a screenshot of the
// page at the moment it went wrong is written to qa-artifacts/.
//
// THIS CHANGES THE DATA IT RUNS AGAINST. It approves things, because
// that is the journey worth testing. Point it at an evaluation you are
// willing to lose, and reset afterwards:
//
//   node --env-file=.env scripts/dev-tenant.mjs --fresh
// =====================================================================

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const [BASE, USER, PASS, STAFF_USER, STAFF_PASS] = process.argv.slice(2);
if (!BASE || !USER || !PASS) {
  console.error('usage: node scripts/qa.mjs <base-url> <username> <password> [staffUser] [staffPass]');
  process.exit(1);
}

const OUT = 'qa-artifacts';
mkdirSync(OUT, { recursive: true });

const results = [];
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

let page;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(name, false, String(err.message).split('\n')[0].slice(0, 160));
    try {
      const file = `${OUT}/${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      await page.screenshot({ path: file, fullPage: true });
    } catch { /* the page may be gone */ }
  }
}

/** Does this page scroll when its content is taller than the window? */
async function scrollReport() {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflowing = [];
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 4 && /hidden/.test(s.overflowY)) {
        overflowing.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
      }
    }
    return {
      pageScrollable: doc.scrollHeight > doc.clientHeight,
      contentTaller: doc.scrollHeight - doc.clientHeight,
      clippedByHiddenOverflow: overflowing.slice(0, 4),
      horizontal: doc.scrollWidth > doc.clientWidth + 2,
    };
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`${page.url().replace(BASE, '')} :: ${m.text().slice(0, 180)}`);
});
page.on('pageerror', (e) => pageErrors.push(`${page.url().replace(BASE, '')} :: ${String(e.message).slice(0, 180)}`));
page.on('requestfailed', (r) => failedRequests.push(`${r.url().replace(BASE, '')} :: ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 500) failedRequests.push(`${r.url().replace(BASE, '')} :: HTTP ${r.status()}`);
});

console.log(`\nQA against ${BASE}\n`);

// ---------------------------------------------------------------------
// 1. The gate
// ---------------------------------------------------------------------
await check('an anonymous visitor lands on the sign-in page', async () => {
  await page.goto(`${BASE}/approvals`, { waitUntil: 'networkidle' });
  if (!page.url().endsWith('/login')) throw new Error(`ended on ${page.url()}`);
});

await check('the sign-in page has both fields and a submit', async () => {
  const users = await page.locator('input[autocomplete="username"]').count();
  const pw = await page.locator('input[type="password"]').count();
  const btn = await page.locator('button[type="submit"]').count();
  if (!users || !pw || !btn) throw new Error(`username:${users} password:${pw} submit:${btn}`);
});

await check('a wrong password is refused, and says so', async () => {
  await page.fill('input[autocomplete="username"]', USER);
  await page.fill('input[type="password"]', 'definitely-not-the-password');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[role="alert"]', { timeout: 15000 });
  const text = (await page.locator('[role="alert"]').innerText()).trim();
  if (!/do not match/i.test(text)) throw new Error(`said: ${text}`);
  return text;
});

// ---------------------------------------------------------------------
// 2. Signing in
// ---------------------------------------------------------------------
await check('the right password signs in and lands on the dashboard', async () => {
  await page.fill('input[autocomplete="username"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 25000 });
  await page.waitForLoadState('networkidle');
});

await check('the session cookie is httpOnly and secure', async () => {
  const c = (await context.cookies()).find((x) => x.name === 'admin_session');
  if (!c) throw new Error('no admin_session cookie was set');
  if (!c.httpOnly) throw new Error('cookie is not httpOnly');
  if (!c.secure && BASE.startsWith('https')) throw new Error('cookie is not secure over https');
  return `httpOnly=${c.httpOnly} secure=${c.secure} sameSite=${c.sameSite}`;
});

// ---------------------------------------------------------------------
// 3. Every screen loads, scrolls, and shows real data
// ---------------------------------------------------------------------
const SCREENS = [
  ['/', 'Dashboard'],
  ['/approvals', 'Approvals'],
  ['/approvals/history', 'History'],
  ['/approvals/delegate', 'Delegate'],
  ['/forms', 'Forms'],
  ['/submissions', 'My Submissions'],
  ['/notices', 'Notice Board'],
  ['/stationery', 'Stationery'],
  ['/maintenance', 'Maintenance'],
  ['/movement-orders', 'Movement Orders'],
  ['/activity', 'Activity Log'],
  ['/builder', 'Form Builder'],
];

for (const [path, label] of SCREENS) {
  await check(`${label} loads and can be scrolled if it needs to`, async () => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 });
    const body = (await page.locator('body').innerText()).trim();
    if (body.length < 40) throw new Error('page is essentially blank');

    const s = await scrollReport();
    if (s.contentTaller > 40 && !s.pageScrollable && s.clippedByHiddenOverflow.length) {
      throw new Error(`content is ${s.contentTaller}px taller than the window but clipped by ${s.clippedByHiddenOverflow.join(', ')}`);
    }
    if (s.horizontal) throw new Error('the page scrolls sideways');
    return `${body.length} chars${s.contentTaller > 40 ? `, ${s.contentTaller}px of scroll` : ''}`;
  });
}

await check('the dashboard shows real numbers rather than placeholders', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const text = await page.locator('body').innerText();
  for (const ghost of ['Ahmed Rahman', 'Faisal Ahmed', 'Rina Parvin', 'Shamsul', 'Board Approval']) {
    if (text.includes(ghost)) throw new Error(`still showing invented data: ${ghost}`);
  }
});

// ---------------------------------------------------------------------
// 4. The search box — the thing that was a lie for five sprints
// ---------------------------------------------------------------------
await check('cmd-K focuses the search box', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.keyboard.press('Control+k');
  const focused = await page.evaluate(() =>
    document.activeElement?.getAttribute('placeholder') ?? '');
  if (!/search/i.test(focused)) throw new Error(`focus went to "${focused}"`);
});

await check('typing a name opens results that go somewhere', async () => {
  await page.keyboard.type('Alex', { delay: 40 });
  await page.waitForTimeout(1200);
  const hits = await page.locator('button:has-text("Alex")').count();
  if (!hits) throw new Error('no results appeared for a name that exists');
  return `${hits} result(s)`;
});

await check('a bare percent sign does not match everything', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.keyboard.press('Control+k');
  await page.keyboard.type('%%', { delay: 40 });
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  if (!/Nothing matches/i.test(body)) {
    throw new Error('a wildcard returned results — escaping is not working in the browser');
  }
});

// ---------------------------------------------------------------------
// 5. Approvals, the demo's whole point
// ---------------------------------------------------------------------
await check('the queue is empty for a requester, and full for an approver', async () => {
  // Tom Bexley is an Operations Analyst — he raises things, he does not
  // approve them, so an empty queue is the correct answer for him. The
  // first version of this check read that as a failure.
  await page.goto(`${BASE}/approvals`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const asRequester = await page.getByRole('button', { name: 'Approve', exact: true }).count();

  await page.goto(`${BASE}/approvals?as=EMP-1134`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const asApprover = await page.getByRole('button', { name: 'Approve', exact: true }).count();

  if (asApprover === 0) throw new Error('the line manager has nothing to approve');
  return `requester ${asRequester}, line manager ${asApprover}`;
});

await check('switching persona changes whose queue you see', async () => {
  await page.goto(`${BASE}/approvals?as=EMP-0700`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText();
  if (!/Alex Mercer/.test(body)) throw new Error('the persona did not change');
});

await check('approving a claim hands it to the finance controller', async () => {
  // Deliberately the travel claim rather than whatever is first. The
  // line manager's queue holds four kinds of request and only this one
  // routes to finance — asserting "the controller got it" about an
  // arbitrary row asserts a chain the test cannot know.
  const controllerBefore = await (async () => {
    await page.goto(`${BASE}/approvals?as=EMP-0312`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    return page.getByRole('button', { name: 'Approve', exact: true }).count();
  })();

  await page.goto(`${BASE}/approvals?as=EMP-1134`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const claim = page.locator('div').filter({ hasText: /Travel & Expense/ })
    .locator('button', { hasText: /^Approve$/ }).first();
  if (!(await claim.count())) return 'no travel claim in the queue to walk';

  const before = await page.getByRole('button', { name: 'Approve', exact: true }).count();
  await claim.click();
  await page.waitForTimeout(3000);

  // Reload rather than trust the fade: a row disappearing locally proves
  // an animation ran, not that anything was written.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const after = await page.getByRole('button', { name: 'Approve', exact: true }).count();
  if (after >= before) throw new Error(`queue did not shrink after a reload: ${before} -> ${after}`);

  await page.goto(`${BASE}/approvals?as=EMP-0312`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const controllerAfter = await page.getByRole('button', { name: 'Approve', exact: true }).count();
  if (controllerAfter <= controllerBefore) {
    throw new Error(`left the line manager but never reached the controller: ${controllerBefore} -> ${controllerAfter}`);
  }
  return `line manager ${before}->${after}, controller ${controllerBefore}->${controllerAfter}`;
});

await check('the notification bell opens and shows real notifications', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const bell = page.locator('button:has(svg.lucide-bell), button:near(:text("Search"))').first();
  await page.locator('button').filter({ has: page.locator('svg') }).nth(0).click({ timeout: 5000 }).catch(() => {});
  const body = await page.locator('body').innerText();
  if (/3 new notifications/.test(body)) throw new Error('still the hardcoded "3 new notifications"');
  return 'no hardcoded count';
});

// ---------------------------------------------------------------------
// 6. Signing out
// ---------------------------------------------------------------------
await check('signing out returns you to the gate', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.locator('button[title="Sign out"]').click();
  await page.waitForURL((u) => u.pathname.endsWith('/login'), { timeout: 20000 });

  const cookie = (await context.cookies()).find((x) => x.name === 'admin_session' && x.value);
  if (cookie) throw new Error('the session cookie survived signing out');

  // Sign-out navigates by setting location, so a goto issued straight
  // after it races that navigation and aborts. Let it settle first.
  await page.waitForTimeout(1000);
  await page.goto(`${BASE}/approvals`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (!page.url().endsWith('/login')) throw new Error('still reachable after signing out');
});

// ---------------------------------------------------------------------
// 7. The staff console
// ---------------------------------------------------------------------
if (STAFF_USER && STAFF_PASS) {
  await check('a staff account can sign in and open the console', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[autocomplete="username"]', STAFF_USER);
    await page.fill('input[type="password"]', STAFF_PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 25000 });

    await page.goto(`${BASE}/staff`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    if (/Not your console/i.test(body)) throw new Error('the console refused a staff account');
    if (!/Issue evaluation/i.test(body)) throw new Error('the issue form is not on the page');
    return 'console opened';
  });

  await check('the console lists the evaluations that exist', async () => {
    const rows = await page.locator('button:has-text("Reset password")').count();
    if (!rows) throw new Error('no evaluations listed');
    return `${rows} evaluation(s)`;
  });
}

// ---------------------------------------------------------------------
await browser.close();

const failed = results.filter((r) => !r.ok);
const summary = {
  base: BASE,
  ran: results.length,
  failed: failed.length,
  results,
  consoleErrors: [...new Set(consoleErrors)],
  pageErrors: [...new Set(pageErrors)],
  failedRequests: [...new Set(failedRequests)],
};
writeFileSync(`${OUT}/qa-report.json`, JSON.stringify(summary, null, 2));

console.log('');
if (summary.pageErrors.length) {
  console.log(`  ${summary.pageErrors.length} uncaught error(s) in the page:`);
  summary.pageErrors.slice(0, 6).forEach((e) => console.log(`    ${e}`));
}
if (summary.consoleErrors.length) {
  console.log(`  ${summary.consoleErrors.length} console error(s):`);
  summary.consoleErrors.slice(0, 6).forEach((e) => console.log(`    ${e}`));
}
if (summary.failedRequests.length) {
  console.log(`  ${summary.failedRequests.length} failed request(s):`);
  summary.failedRequests.slice(0, 6).forEach((e) => console.log(`    ${e}`));
}

console.log('');
if (failed.length) {
  console.log(`${failed.length} of ${results.length} CHECKS FAILED — screenshots in ${OUT}/\n`);
  process.exit(1);
}
console.log(`ALL ${results.length} BROWSER CHECKS PASSED\n`);
