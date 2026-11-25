
await page.goto(BASE + '/approvals?as=EMP-0445');
await settle(4000);
const box = page.locator('div', { hasText: /^Coming your way/ }).first();
const items = await page.evaluate(() => {
  const h = [...document.querySelectorAll('div')].find((d) => d.textContent?.trim() === 'Coming your way');
  const list = h?.parentElement?.querySelector('.flex.flex-col');
  return list ? [...list.children].map((c) => ({ text: c.textContent?.trim(), href: c.getAttribute('href') })) : null;
});
console.log('  coming:', JSON.stringify(items));
ok('every request coming Farah\'s way is named, none a bare "Request"', !!items && items.length > 0 && items.every((i) => i.text && i.text !== 'Request'));
ok('...and each opens somewhere', !!items && items.every((i) => i.href));
ok('...once each', !!items && new Set(items.map((i) => i.text)).size === items.length);
ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL APPROVALS-PAGE CHECKS PASSED');
process.exit(failures ? 1 : 0);
