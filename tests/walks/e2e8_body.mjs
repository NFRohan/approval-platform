
// ================================================================ ServiceDesk Plus, live
const { startMock } = await import(pathToFileURL(REPO + 'scripts/servicedesk-mock.mjs').href);
process.env.OUTBOUND_ALLOW_PRIVATE = '1';   // the stand-in is on this machine
const now = Date.now();
const mock = await startMock({ tickets: [
  { id: '8001', subject: 'Access to the finance ledger', description: '<p>Quarter-end close needs <b>read</b> access.</p>',
    requester_email: 'tom.bexley@example.com', category: 'Access', priority: 'High', created_ms: now - 3600_000 },
  { id: '8002', subject: 'Printer jam, 4th floor', requester_email: 'tom.bexley@example.com', category: 'Printer', created_ms: now - 1800_000 },
] });
const slug = (await one(`select slug from public.tenants where id = $1`, [tenant])).slug;

// ------------------------------------------------- connect, on screen
await page.goto(BASE + '/admin/integrations?as=EMP-0445');
await settle(3000);
await page.getByRole('tab', { name: 'ServiceDesk Plus' }).click();
await settle(2000);
ok('the link starts mapped and not connected', /Not connected/.test(await page.locator('[data-testid="servicedesk"]').innerText())
  && (await page.locator('[data-testid="servicedesk-map"] input').first().inputValue()) === 'Access');
await page.locator('input[aria-label="ServiceDesk address"]').fill(mock.url);
await page.locator('input[aria-label="Technician API key"]').fill('wrong-key');
await page.locator('button[name="test-servicedesk"]').click();
await settle(2000);
ok('a wrong key is reported', /UNAUTHORISED|refused/i.test(await page.locator('[data-testid="servicedesk-test"]').innerText()));
await page.locator('input[aria-label="Technician API key"]').fill(mock.key);
await page.locator('button[name="test-servicedesk"]').click();
await settle(2000);
let t = await page.locator('[data-testid="servicedesk-test"]').innerText();
ok('the right one connects, and says how many tickets there are', /Connected/.test(t) && /2 tickets/.test(t), t);
await page.locator('button[role="switch"][aria-label="Connected"]').click();
await page.locator('button[name="save-servicedesk"]').click();
await settle(2500);
const link = await one(`select enabled, base_url, token_sealed from public.servicedesk_links where tenant_id = $1`, [tenant]);
ok('saved: connected, the key sealed, never stored as typed', link.enabled && link.base_url === mock.url && link.token_sealed.startsWith('v1.') && !link.token_sealed.includes(mock.key));
await shot('s8-servicedesk-connected');

// ------------------------------------------------- tickets fetched
await page.locator('button[name="fetch-servicedesk"]').click();
await settle(4000);
const raised = await one(`select s.id, s.ref_number, s.submitted_by, s.priority, t.name form from public.form_submissions s
  join public.form_templates t on t.id = s.form_template_id where s.tenant_id = $1 and s.external_ref = '8001'`, [tenant]);
ok('the access ticket is fetched and raised as Tom\'s request, high priority', raised?.submitted_by === 'EMP-2847' && raised.form === 'IT System Access Request' && raised.priority === 'high', JSON.stringify(raised));
ok('...the printer ticket left to the desk', !(await one(`select 1 x from public.form_submissions where tenant_id = $1 and external_ref = '8002'`, [tenant])));
ok('...and the ticket told its reference, at once', mock.store.get('8001').notes.some((n) => n.description.includes(raised.ref_number) && /Waiting on/.test(n.description)));
const just = await one(`select value from public.submission_values where submission_id = $1 and field_name = 'Justification'`, [raised.id]);
ok('the description, as text, answers the form', just?.value === 'Quarter-end close needs read access.', just?.value);

// ------------------------------------------------- a ticket by webhook, only its id
mock.add({ id: '8003', subject: 'Capex: new firewall', requester_email: 'tom.bexley@example.com', category: 'Network', template: 'Purchase Request' });
const hook = (secret, body) => server.fetch(new Request(`${BASE}/integrations/servicedesk/${slug}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-ams-secret': secret }, body: JSON.stringify(body) }));
let res = await hook('not-the-secret', { id: '8003' });
ok('a webhook without the secret is refused', res.status === 401);
const secret = (await one(`select inbound_secret from public.servicedesk_links where tenant_id = $1`, [tenant])).inbound_secret;
res = await hook(secret, { id: '8003' });
const viaHook = await res.json();
ok('a webhook with only the id is completed from the API and raised on the template\'s form', res.status === 200 && viaHook.outcome === 'raised' && viaHook.form === 'Capital Expenditure Request', JSON.stringify(viaHook));
res = await hook(secret, { id: '8003' });
ok('...and sent twice, raised once', (await res.json()).outcome === 'duplicate');

// ------------------------------------------------- decided here, written back there
for (let i = 0; i < 6; i++) {
  const next = await one(`select approver_user_id from public.approval_requests where submission_id = $1 and status = 'pending' order by step_index limit 1`, [raised.id]);
  if (!next) break;
  await approveAs(next.approver_user_id, raised.id);
}
await settle(1500);
const tk = mock.store.get('8001');
ok('the request is approved', (await one(`select status from public.form_submissions where id = $1`, [raised.id])).status === 'completed');
ok('every approval is a note on the ticket', tk.notes.filter((n) => /approved by/.test(n.description)).length >= 2, tk.notes.map((n) => n.description).join(' | '));
ok('...then it is resolved, listing who approved, and closed as Success', tk.resolution?.content.includes('Approved by:') && tk.status.name === 'Closed' && tk.closure_info?.closure_code?.name === 'Success', JSON.stringify(tk.closure_info));
const order = mock.calls.filter((c) => c.path.startsWith('/api/v3/requests/8001/')).map((c) => c.path.split('/').pop());
ok('...in that order', order.indexOf('resolutions') > order.lastIndexOf('notes') && order.indexOf('close') > order.indexOf('resolutions'), order.join(','));

// The purchase, rejected on screen.
const capex = viaHook.submission_id;
const first = await one(`select id, approver_user_id from public.approval_requests where submission_id = $1 and status = 'pending' order by step_index limit 1`, [capex]);
// Rejected from the ERP, through the open API, as the approver.
const { createHash, randomBytes: rnd } = await import('node:crypto');
const prefix = rnd(4).toString('hex'), keySecret = rnd(24).toString('hex');
await db.query(`insert into public.api_keys (tenant_id, name, prefix, secret_hash, scopes) values ($1, 'walk', $2, $3, '{approvals:write}')`,
  [tenant, prefix, createHash('sha256').update(keySecret).digest('hex')]);
const rej = await server.fetch(new Request(`${BASE}/api/v1/approvals/${first.id}/decision`, {
  method: 'POST', headers: { authorization: `Bearer ams_${prefix}_${keySecret}`, 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'reject', comment: "Not in this quarter's budget" }) }));
ok('the purchase is rejected from the ERP', rej.status === 200, String(rej.status));
await settle(1500);
const ct = mock.store.get('8003');
ok('a rejection closes the ticket as rejected, with the reason', ct.status.name === 'Closed' && ct.closure_info?.closure_code?.name === 'Rejected' && /budget/.test(ct.closure_info?.closure_comments ?? ''), JSON.stringify(ct.closure_info));

// ------------------------------------------------- the log, and a failure retried
await mock.close();
mock.add({ id: '8004', subject: 'x' });
const second = await (await import(pathToFileURL(REPO + 'scripts/servicedesk-mock.mjs').href)).startMock({ tickets: [{ id: '8005', subject: 'Access for the auditors', requester_email: 'stranger@elsewhere.test', category: 'Access' }] });
await db.query(`update public.servicedesk_links set base_url = $2 where tenant_id = $1`, [tenant, second.url]);
await page.goto(BASE + '/admin/integrations?as=EMP-0445');
await settle(2500);
await page.getByRole('tab', { name: 'ServiceDesk Plus' }).click();
await settle(1500);
await page.locator('button[name="fetch-servicedesk"]').click();
await settle(3000);
ok('a stranger\'s ticket is refused, and the desk told why', second.store.get('8005').notes.some((n) => /not in the org chart/.test(n.description)));
await page.locator('button[name="fetch-servicedesk"]').click();   // refresh the log
await settle(2000);
t = await page.locator('[data-testid="servicedesk-events"]').innerText();
ok('the log shows tickets in and write-backs out', /Ticket fetched/.test(t) && /Ticket from webhook/.test(t) && /Ticket closed/.test(t) && /Refused/.test(t) && /Ignored/.test(t), t.slice(0, 400));
await shot('s8-servicedesk-log');
await second.close();

// ------------------------------------------------- the cloud's sign-in, on screen
await page.getByRole('radio', { name: /Cloud/ }).click();
await page.locator('select[aria-label="Data centre"]').selectOption('India');
await page.locator('input[aria-label="Portal name"]').fill('itdesk');
t = await page.locator('[data-testid="servicedesk-cloud"]').innerText();
ok('the cloud form builds the portal address and points at that data centre API console',
  t.includes('https://sdpondemand.manageengine.in/app/itdesk') && t.includes('api-console.zoho.in') && t.includes('SDPOnDemand.requests.ALL'), t.slice(0, 300));
ok('...and signs in only with a client id, secret and code', await page.locator('button[name="zoho-sign-in"]').isDisabled());
await shot('s8-servicedesk-cloud');

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL SERVICEDESK E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
