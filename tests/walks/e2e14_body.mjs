
// ServiceDesk's webhook, sent the three ways its form allows.
// The page polls in the background on the same connection; park it.
await page.goto('about:blank');
await settle(1500);
console.log('  links:', JSON.stringify(await rows(`select l.tenant_id, t.slug, t.kind, l.inbound_secret is not null s from public.servicedesk_links l join public.tenants t on t.id = l.tenant_id`)), 'tenant', tenant);
const slug = (await one(`select slug from public.tenants where id = $1`, [tenant])).slug;
const secret = (await one(`select inbound_secret from public.servicedesk_links where tenant_id = $1`, [tenant])).inbound_secret;
const send = async (qs, init) => (await server.fetch(new Request(`${BASE}/integrations/servicedesk/${slug}${qs}`, { method: 'POST', ...init }))).status;
// The link is not connected, so an id alone cannot be completed: a 200 with
// "left alone" means the id was read and the ticket judged.
let r = await server.fetch(new Request(`${BASE}/integrations/servicedesk/${slug}?key=${secret}&id=777001`, { method: 'POST' }));
ok('an id on the address, the secret as ?key=, is read', r.status === 200, String(r.status) + ' ' + await r.text());
ok('a JSON body with the secret in X-AMS-Secret is read', await send('', { headers: { 'x-ams-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify({ id: '777002' }) }) === 200);
ok('a form body is read', await send(`?key=${secret}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'id=777003' }) === 200);
ok('no secret, refused', await send('?id=777004', {}) === 401);
ok('no id anywhere, a 400', await send(`?key=${secret}`, {}) === 400);
await browser.close(); await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL WEBHOOK-SHAPE CHECKS PASSED');
process.exit(failures ? 1 : 0);
