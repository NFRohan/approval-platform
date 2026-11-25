
// ------------------------------------------------- idle timeout (limit 20s here)
await page.goto(BASE + '/');
await settle(2500);
ok('signed in and active', !page.url().includes('/login'));
await page.waitForURL(/\/login\?idle=1/, { timeout: 45000 }).catch(() => {});
ok('time without activity signs out', page.url().includes('/login?idle=1'), page.url());
await settle(1000);
ok('...and says why', /signed out after 5 minutes/i.test(await text()));
ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
const r = await page.evaluate(async () => (await fetch('/files/00000000-0000-4000-8000-000000000000')).status);
ok('...and the session is gone on the server too', r === 401, String(r));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL IDLE CHECKS PASSED');
process.exit(failures ? 1 : 0);
