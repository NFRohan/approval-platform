
await page.setViewportSize({ width: 1100, height: 520 });
await page.goto(BASE + '/analytics?as=EMP-0445');
await settle(4000);
await page.screenshot({ path: new URL('./s12-scrollbars.png', import.meta.url).pathname.replace(/^\//, '') });
const thumb = await page.evaluate(() => getComputedStyle(document.querySelector('nav.scroll-dark'), '::-webkit-scrollbar-thumb').backgroundColor);
console.log('sidebar thumb', thumb);
await browser.close(); await local.stop(); process.exit(0);
