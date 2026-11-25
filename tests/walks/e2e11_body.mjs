
// ================================================================ the cloud tab after Save
const { createHash, createCipheriv, randomBytes: rnd } = await import('node:crypto');
const seal = (secret) => {
  const key = createHash('sha256').update('totp-secret:' + (process.env.MFA_KEY || process.env.JWT_SECRET)).digest();
  const iv = rnd(12); const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
};
const { startMock } = await import(pathToFileURL(REPO + 'scripts/servicedesk-mock.mjs').href);
process.env.OUTBOUND_ALLOW_PRIVATE = '1';
const mock = await startMock({ tickets: [{ id: '9001', subject: 'x', requester_email: 'tom.bexley@example.com', category: 'Access' }] });
const code = await (await fetch(mock.url + '/oauth/v2/token?grant_type=authorization_code&client_id=mock-client&client_secret=mock-secret&code=mock-code', { method: 'POST' })).json();
// As the sign-in leaves it: cloud, signed in, not yet switched on.
// The page shares the database session: park it first.
await page.goto('about:blank');
await settle(1500);
await db.query(`update public.servicedesk_links set auth_mode = 'oauth', base_url = $2, oauth_accounts_url = $3, oauth_client_id = 'mock-client',
  oauth_secret_sealed = $4, oauth_refresh_sealed = $5, enabled = false where tenant_id = $1`,
  [tenant, mock.url + '/app/itdesk', mock.url, seal('mock-secret'), seal(code.refresh_token)]);

await page.goto(BASE + '/admin/integrations?as=EMP-0445');
await settle(3000);
await page.getByRole('tab', { name: 'ServiceDesk Plus' }).click();
await settle(2000);
const state = async (label) => {
  const s = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="servicedesk"]');
    return {
      tab: !!root,
      cloud: !!document.querySelector('[data-testid="servicedesk-cloud"]'),
      onprem: !!document.querySelector('input[aria-label="ServiceDesk address"]'),
      portal: document.querySelector('input[aria-label="Portal name"]')?.value ?? null,
      clientId: document.querySelector('input[aria-label="Zoho client id"]')?.value ?? null,
      test: document.querySelector('[data-testid="servicedesk-test"]')?.innerText ?? null,
      text: (root?.innerText ?? document.body.innerText).slice(0, 160).replace(/\s+/g, ' '),
    };
  });
  console.log(`  ${label}:`, JSON.stringify(s));
  return s;
};
const before = await state('opened');
ok('a signed-in cloud link opens on the cloud form, with its portal and client', before.cloud && before.portal === 'itdesk' && before.clientId === 'mock-client');
await page.locator('button[name="test-servicedesk"]').click();
await settle(2500);
await state('tested');
console.log('  mock refreshes:', mock.oauth.refreshes, 'calls:', JSON.stringify(mock.calls.slice(-3).map((c) => c.method + ' ' + c.path)));
console.log('  stored:', JSON.stringify(await one(`select auth_mode, base_url, oauth_accounts_url, oauth_access_expires from public.servicedesk_links where tenant_id = $1`, [tenant])));
await page.locator('button[name="save-servicedesk"]').click();
await settle(3000);
const after = await state('saved');
await shot('s11-cloud-after-save');
ok('after Save the tab is still there, still the cloud form, with its portal and client', after.tab && after.cloud && after.portal === 'itdesk' && after.clientId === 'mock-client');

await page.locator('button[role="switch"][aria-label="Connected"]').click();
await page.locator('button[name="save-servicedesk"]').click();
await settle(3000);
const on = await state('switched on and saved');
const header = await page.locator('[data-testid="servicedesk"] > div').first().innerText();
ok('switched on and saved, it says Connected and keeps the form', /(^|\s)Connected/.test(header) && !/Not connected/.test(header) && on.cloud && on.portal === 'itdesk', header);
ok('...stored as connected', (await one(`select enabled from public.servicedesk_links where tenant_id = $1`, [tenant])).enabled === true);
await mock.close();

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL CLOUD-TAB E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
