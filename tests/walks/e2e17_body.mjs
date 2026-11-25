// ================================================================ the phone
await page.setViewportSize({ width: 390, height: 844 });
const overflow = () => page.evaluate(() => {
  const m = document.querySelector('main');
  const wide = [];
  if (m) for (const el of m.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 && r.width > 0) {
      // A scrolling table inside a scroll container is meant to be wider.
      let p = el.parentElement, scrolls = false;
      while (p && p !== m) { const s = getComputedStyle(p); if (s.overflowX === 'auto' || s.overflowX === 'scroll') { scrolls = true; break; } p = p.parentElement; }
      if (!scrolls) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(r.right)}`);
    }
  }
  return { page: document.documentElement.scrollWidth, main: m ? m.scrollWidth : 0, vw: window.innerWidth, wide: wide.slice(0, 5) };
});

for (const [path, who, label] of [['/', 'EMP-2847', 'dashboard'], ['/approvals', 'EMP-1134', 'approvals'], ['/forms', 'EMP-2847', 'forms'],
                                   ['/submissions', 'EMP-2847', 'submissions'], ['/trackers', 'EMP-0830', 'trackers'], ['/account', 'EMP-2847', 'account']]) {
  await page.goto(`${BASE}${path}?as=${who}`);
  await settle(3000);
  const o = await overflow();
  ok(`${label}: fits the phone, nothing sideways`, o.main <= o.vw + 1 && o.page <= o.vw + 1 && o.wide.length === 0, JSON.stringify(o));
  await shot(`s11-phone-${label}`);
}

await page.goto(`${BASE}/approvals?as=EMP-1134`);
await settle(3000);
ok('the sidebar gives way to the tab bar', !(await page.locator('aside').first().isVisible()) && await page.locator('[data-testid="tab-bar"]').isVisible());
const tabText = await page.locator('[data-testid="tab-bar"]').innerText();
ok('...with home, approvals and their count, requests, trackers and more', /Home/.test(tabText) && /Approvals/.test(tabText) && /\d/.test(tabText) && /Requests/.test(tabText) && /Trackers/.test(tabText) && /More/.test(tabText), tabText.replace(/\s+/g, ' '));
const row = page.locator('[id^="approval-"]').first();
const box = await row.getByRole('button', { name: /^Approve$/ }).boundingBox();
ok('Approve is big enough to tap', !!box && box.height >= 36 && box.width >= 64, JSON.stringify(box));
await row.getByRole('button', { name: /^Approve$/ }).click();
await settle(2500);
ok('...and approves from the phone', /Approved|signature|checklist/i.test(await text()));

await page.getByRole('button', { name: 'More' }).click();
await settle(800);
const drawer = page.locator('[role="dialog"][aria-label="Menu"]');
ok('More opens the whole menu as a drawer', await drawer.isVisible() && /Available Forms/.test(await drawer.innerText()));
await shot('s11-phone-drawer');
await drawer.getByText('Available Forms').click();
await settle(2500);
ok('...and a tap in it goes there and closes it', page.url().includes('/forms') && (await page.locator('[role="dialog"][aria-label="Menu"]').count()) === 0, page.url());

// The app itself.
const man = await page.evaluate(async () => { const r = await fetch('/manifest.webmanifest'); return { status: r.status, json: await r.json() }; });
ok('the manifest says it is an app: standalone, its icons, its colour', man.status === 200 && man.json.display === 'standalone' && man.json.icons.some((i) => i.purpose === 'maskable') && man.json.theme_color === '#4F46E5');
const sw = await page.evaluate(async () => { const r = await fetch('/sw.js'); return { status: r.status, text: await r.text() }; });
ok('the service worker is served, with push and the offline page', sw.status === 200 && sw.text.includes("addEventListener('push'") && sw.text.includes('/offline.html'));
const head = await page.evaluate(() => ({
  manifest: !!document.querySelector('link[rel="manifest"]'), apple: !!document.querySelector('link[rel="apple-touch-icon"]'),
  theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'), viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
}));
ok('the page links the manifest and the iPhone icon, in the brand colour, edge to edge', head.manifest && head.apple && head.theme === '#4F46E5' && /viewport-fit=cover/.test(head.viewport ?? ''), JSON.stringify(head));
await page.goto(`${BASE}/account?as=EMP-2847`);
await settle(3000);
ok('the account page offers notifications on this device', /This phone or computer/.test(await text()));
await page.goto('about:blank');
await settle(1000);
await page.goto(`${BASE}/account?as=EMP-2847`);
await settle(2500);

// Back on a laptop, the laptop's layout.
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${BASE}/approvals?as=EMP-1134`);
await settle(2500);
ok('on a laptop the sidebar is back and the tab bar gone', await page.locator('aside').first().isVisible() && !(await page.locator('[data-testid="tab-bar"]').isVisible()));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL PHONE CHECKS PASSED');
process.exit(failures ? 1 : 0);
