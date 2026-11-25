// ================================================================ the notifications panel fits a phone
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/?as=EMP-2847`); await settle(3500);
await page.getByRole('button', { name: /notification/i }).first().click();
await settle(1200);
const box = await page.evaluate(() => { const el = [...document.querySelectorAll('div')].find((d) => /Mark all read|unread|No notifications/i.test(d.innerText || '') && d.className.includes('z-50')); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, w: innerWidth }; });
ok('the notifications panel opens on a phone', !!box, JSON.stringify(box));
ok('...and fits inside the screen', box && box.left >= 0 && box.right <= box.w, JSON.stringify(box));
await page.screenshot({ path: 'v-notif-phone.png' });
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/?as=EMP-2847`); await settle(3000);
await page.getByRole('button', { name: /notification/i }).first().click();
await settle(1200);
const d = await page.evaluate(() => { const el = [...document.querySelectorAll('div')].find((d) => d.className.includes('z-50') && d.className.includes('w-[380px]')); const r = el?.getBoundingClientRect(); return r ? { w: Math.round(r.width), right: Math.round(r.right), vw: innerWidth } : null; });
ok('on a desk it is still 380px, under the bell', d && d.w === 380 && d.right < d.vw, JSON.stringify(d));
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
