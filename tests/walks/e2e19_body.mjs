// ================================================================ moving between pages: the old one never replays
// Production fetches the next page's code over the network; here it is
// instant unless slowed, and the flash happens only while it is fetched.
// The root's session check runs on every move, as a server call; in
// production that is a round trip, so slow it to one.
let slow = false;
await page.route((u) => slow && /_serverFn|\/assets\/.*\.js/.test(u.href), async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.fallback(); });
async function hop(from, label, expectNew) {
  await page.goto(`${BASE}${from}?as=EMP-2847`);
  await settle(3500);
  // Record every page that mounts from here on, and what it shows.
  await page.evaluate(() => {
    window.__mounts = [];
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.classList?.contains('page-enter')) {
          setTimeout(() => window.__mounts.push((n.innerText || '').slice(0, 120).replace(/\s+/g, ' ')), 30);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  slow = true;
  await page.getByText(label, { exact: true }).first().click();
  await settle(4500);
  slow = false;
  return page.evaluate(() => window.__mounts);
}

let m = await hop('/movement-orders', 'Notice Board');
ok('Movement Orders → Notice Board: the old page is not mounted again', m.length > 0 && !m.some((t) => /Movement Orders/.test(t)), JSON.stringify(m));
ok('...and the notice board itself enters once', m.filter((t) => /Notice/i.test(t)).length === 1, JSON.stringify(m));

m = await hop('/submissions', 'Available Forms');
ok('My Submissions → Available Forms: no replay of the old page', m.length > 0 && !m.some((t) => /My Submissions/.test(t) && !/Available/.test(t)), JSON.stringify(m));

m = await hop('/forms', 'Trackers');
ok('Available Forms → Trackers: no replay of the old page', m.length > 0 && m.every((t) => /tracker/i.test(t)), JSON.stringify(m));
ok('no page errors', pageErrors.length === 0, pageErrors.join(' / ').slice(0, 400));
await browser.close(); await local.stop();
console.log(failures ? `${failures} FAILED` : 'ALL PAGE-SWITCH CHECKS PASSED');
process.exit(failures ? 1 : 0);
