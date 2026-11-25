
// ================================================================ signing in, without the form coming back
// Sign out (the idle sign-out does it on the server), then sign in again
// while watching the page: from Enter until the dashboard, the sign-in
// form must not reappear.
await ctx.clearCookies();
await page.goto(BASE + '/login');
await settle(1500);
ok('signed out', page.url().includes('/login'));

// Slow the way in, as the live database is: every server call after the
// sign-in waits half a second.
let signedIn = false;
await page.route(BASE + '/**', async (route) => {
  if (signedIn && !/\.(js|css|svg|png|woff2)$/.test(new URL(route.request().url()).pathname)) await new Promise((r) => setTimeout(r, 500));
  return route.fallback();
});

await page.locator('input[autocomplete="username"]').fill(USER);
await page.locator('input[autocomplete="current-password"]').fill(PASS);
const seen = [];
// The page reports the moment "Signing you in" is drawn: sampling cannot
// see it once the browser has started loading the next page.
let reportedArriving = false;
await page.exposeFunction('__arriving', () => { reportedArriving = true; });
await page.evaluate(() => new MutationObserver(() => {
  if (document.querySelector('[data-testid="signing-in"]')) (window).__arriving();
}).observe(document.body, { childList: true, subtree: true }));
const watch = (async () => {
  for (let i = 0; i < 400; i++) {
    const s = await page.evaluate(() => ({
      path: location.pathname,
      form: !!document.querySelector('input[autocomplete="current-password"]'),
      button: document.querySelector('button[type="submit"]')?.textContent ?? null,
      arriving: !!document.querySelector('[data-testid="signing-in"]'),
      dashboard: !!document.querySelector('aside') && location.pathname === '/',
    })).catch(() => null);
    if (s) seen.push(s);
    // Watch until the dashboard is drawn, not until the address changes:
    // the address changes first.
    if (s && s.dashboard) break;
    await new Promise((r) => setTimeout(r, 40));
  }
})();
signedIn = true;
await page.locator('input[autocomplete="current-password"]').press('Enter');
await watch;
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
await settle(2000);

console.log('  frames:', seen.map((s) => (s.dashboard ? 'D' : s.arriving ? 'A' : s.form ? (s.button === 'Sign in' ? 'F' : 'B') : s.path === '/login' ? '?' : s.path)).join(''), seen.length);
const firstBusy = seen.findIndex((s) => s.arriving || s.button === 'Working…');
const bounced = seen.slice(Math.max(firstBusy, 0) + 1).filter((s) => s.form && s.button === 'Sign in');
ok('after Enter the page says it is signing in', reportedArriving || seen.some((s) => s.arriving));
ok('...and the empty sign-in form never comes back on the way to the dashboard', firstBusy >= 0 && bounced.length === 0,
  `${bounced.length} frames of the form after signing in began: ${JSON.stringify(seen.map((s) => (s.arriving ? 'A' : s.form ? (s.button === 'Sign in' ? 'F' : 'B') : s.path)).join(''))}`);
ok('the dashboard is reached', new URL(page.url()).pathname === '/' && /Dashboard|Good (morning|afternoon|evening)/.test(await text()));

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL SIGN-IN E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
