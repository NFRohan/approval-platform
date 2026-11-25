
// ================================================================ signing out, without an error on the way
// From a busy screen, as a person would: the dashboard, then the top bar's
// sign-out, and the sidebar's. The page reports the moment it draws the
// error screen; sampling would miss it.
let errorShown = 0;
await page.exposeFunction('__errorShown', () => { errorShown++; });
const watchErrors = () => page.evaluate(() => new MutationObserver(() => {
  if (/Something went wrong/.test(document.body.innerText)) (window).__errorShown();
}).observe(document.body, { childList: true, subtree: true, characterData: true }));

// Slow, as the live database is.
await page.route(BASE + '/**', async (route) => {
  if (!/\.(js|css|svg|png|woff2)$/.test(new URL(route.request().url()).pathname)) await new Promise((r) => setTimeout(r, 300));
  return route.fallback();
});

async function signInAgain() {
  await page.goto(BASE + '/login');
  await settle(1500);
  await page.locator('input[autocomplete="username"]').fill(USER);
  await page.locator('input[autocomplete="current-password"]').fill(PASS);
  await page.locator('input[autocomplete="current-password"]').press('Enter');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  await settle(3000);
}

await page.goto(BASE + '/?as=EMP-0445');
await settle(4000);
await watchErrors();
await page.locator('button[title="Sign out"]').click();
await page.waitForURL((u) => u.pathname.startsWith('/login'), { timeout: 20000 });
await settle(2500);
ok('the top bar signs out to the sign-in page', page.url().includes('/login') && (await page.locator('input[autocomplete="current-password"]').count()) === 1);
ok('...without an error screen on the way', errorShown === 0, `${errorShown} error screen(s) drawn`);

await signInAgain();
errorShown = 0;
await watchErrors();
await page.locator('button[title="Logout"]').click();
await page.waitForURL((u) => u.pathname.startsWith('/login'), { timeout: 20000 });
await settle(2500);
ok('the sidebar signs out too, without an error screen', page.url().includes('/login') && errorShown === 0, `${errorShown} error screen(s) drawn`);
ok('...and the session is gone', !(await (await server.fetch(new Request(BASE + '/', { headers: { cookie: (await ctx.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join('; ') } }))).headers.get('location')) === false);

ok('no page errors along the way', pageErrors.filter((e) => !/401|not signed in/i.test(e)).length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL SIGN-OUT E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
