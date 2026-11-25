
// ================================================================ Stage 6
import { createServer as httpServer } from 'node:http';
import { createHmac, createHash, randomBytes as rb } from 'node:crypto';
const sidebar = async () => page.locator('aside').innerText();

// The open API, from another system: straight at the server.
const callApi = async (key, method, path, body) => {
  const res = await server.fetch(new Request(`${BASE}/api/v1/${path}`, {
    method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), 'x-forwarded-for': '10.9.8.7' },
    body: body ? JSON.stringify(body) : undefined,
  }));
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
};

// The ERP's own receiver, on this machine, checking every signature the
// way /developers says to. And the address the app calls itself by, so
// the built-in receiver is reachable too.
const received = [];
let receiverSecret = null;
const receiver = httpServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url.startsWith('/erp')) {
    const ts = req.headers['x-ams-timestamp'];
    const want = 'sha256=' + createHmac('sha256', receiverSecret ?? '').update(`${ts}.${body}`).digest('hex');
    const verified = want === req.headers['x-ams-signature'];
    received.push({ event: req.headers['x-ams-event'], verified, body: JSON.parse(body) });
    res.writeHead(verified ? 200 : 401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: verified }));
  }
  // Anything else is the app: proxy it, as the platform's own address would.
  const r = await server.fetch(new Request(BASE + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
const RX = `http://127.0.0.1:${receiver.address().port}`;
process.env.APP_URL = RX;

// ------------------------------------------------- who sees what
await page.goto(BASE + '/?as=EMP-2847');
await settle(2500);
ok('an employee is not offered integrations or the audit centre', !/Integrations|Audit Centre/.test(await sidebar()));
await page.goto(BASE + '/?as=EMP-0445');
await settle(2500);
ok('the system administrator is offered both', /Integrations/.test(await sidebar()) && /Audit Centre/.test(await sidebar()));

// ------------------------------------------------- a key, made on screen
await page.goto(BASE + '/admin/integrations?as=EMP-0445');
await settle(3000);
let t = await text();
ok('the evaluation comes with the ERP\'s and Tableau\'s keys, and a revoked one', t.includes('SAP S/4HANA') && t.includes('Tableau') && /Revoked/.test(t));
await shot('s6-keys');
await page.getByRole('button', { name: /New key/ }).click();
await page.locator('input[aria-label="Key name"]').fill('Oracle ERP — test');
for (const s of ['requests:write', 'approvals:write', 'forms:read', 'reports:read']) await page.locator(`input[aria-label="${s}"]`).check();
await page.getByRole('button', { name: /Create key/ }).click();
await settle(2500);
const KEY = (await page.locator('[data-testid="one-time-secret"]').innerText()).trim();
ok('the key is shown once, with a call to try it', /^ams_[a-z0-9]{8}_[A-Za-z0-9]{40}$/.test(KEY) && (await page.locator('[data-testid="new-key"] pre').innerText()).includes('/api/v1/me'), KEY);
ok('...and only its hash is kept', (await one(`select secret_hash from public.api_keys where name = 'Oracle ERP — test'`)).secret_hash === createHash('sha256').update(KEY.split('_')[2]).digest('hex'));
await shot('s6-new-key');

// ------------------------------------------------- the API, as the ERP
let r = await callApi(KEY, 'GET', 'me');
ok('the key works, and says what it may do', r.status === 200 && r.body.data.scopes.length === 5, JSON.stringify(r.body));
r = await callApi(KEY, 'GET', 'forms');
const travel = r.body.data?.find((f) => f.name === 'Travel & Expense Reimbursement');
ok('the forms come with their fields, required ones marked', r.status === 200 && travel?.fields.some((f) => f.name === 'Amount claimed' && f.required), JSON.stringify(travel?.fields?.slice(0, 3)));
r = await callApi(KEY, 'POST', 'requests', { form: 'Travel & Expense Reimbursement', on_behalf_of: 'EMP-2847', answers: { 'Purpose of travel': 'Client visit' } });
ok('a request missing a required answer is refused with what is missing', r.status === 422 && r.body.error.details.missing.includes('Amount claimed'), JSON.stringify(r.body));
r = await callApi(KEY, 'POST', 'requests', { form: 'Travel & Expense Reimbursement', on_behalf_of: 'EMP-2847', answers: { 'Purpose of travel': 'x', Colour: 'red' } });
ok('...and one with a field the form does not have', r.status === 422 && /no field called "Colour"/.test(r.body.error.message));
r = await callApi(KEY, 'POST', 'requests', { form: 'Travel & Expense Reimbursement', on_behalf_of: 'EMP-9999', answers: {} });
ok('...and one for somebody who does not work here', r.status === 404);
r = await callApi(KEY, 'POST', 'requests', {
  form: 'Travel & Expense Reimbursement', on_behalf_of: 'EMP-2847', priority: 'high',
  answers: { 'Purpose of travel': 'Raised from the ERP', 'Travel date': '2026-12-02', 'Amount claimed': 42000 },
});
const created = r.body.data;
ok('a request raised through the API is submitted and routed', r.status === 201 && /^AMS-\d{4}-\d{5}$/.test(created?.reference) && created.approvals.length > 0 && created.requester.employee_id === 'EMP-2847', JSON.stringify(r.body).slice(0, 300));
ok('...with its answers and the employee\'s name filled in', created?.answers['Amount claimed'] === '42000' && created?.answers['Employee name'] === 'Tom Bexley', JSON.stringify(created?.answers));
r = await callApi(KEY, 'GET', `requests/${created.reference}`);
ok('it is read back by its reference, with its history', r.status === 200 && r.body.data.history.some((h) => h.action === 'submitted'));
const step = r.body.data.approvals.find((a) => a.status === 'pending');
r = await callApi(KEY, 'GET', `approvals?approver=${step.approver.employee_id}`);
ok('it is in the approver\'s queue', r.status === 200 && r.body.data.some((a) => a.id === step.id));
r = await callApi(KEY, 'POST', `approvals/${step.id}/decision`, { decision: 'approve', on_behalf_of: 'EMP-2847' });
ok('the requester cannot approve their own step', r.status === 403, JSON.stringify(r.body));
r = await callApi(KEY, 'POST', `approvals/${step.id}/decision`, { decision: 'reject' });
ok('a rejection needs a comment', r.status === 400);
r = await callApi(KEY, 'POST', `approvals/${step.id}/decision`, { decision: 'approve', comment: 'Budget confirmed in the ERP' });
ok('the approver approves from the ERP', r.status === 200 && r.body.data.request.approvals.find((a) => a.id === step.id).status === 'approved', JSON.stringify(r.body).slice(0, 300));
r = await callApi(KEY, 'POST', `approvals/${step.id}/decision`, { decision: 'approve' });
ok('...once', r.status === 409, JSON.stringify(r.body));
ok('...as themselves, in the trail', (await one(`select actor_id from public.approval_events where request_id = $1 and action = 'approved'`, [step.id])).actor_id === step.approver.employee_id);
r = await callApi(KEY, 'POST', `requests/${created.id}/notes`, { on_behalf_of: 'EMP-2847', body: 'PO 4500017321 raised in the ERP' });
ok('a note is added from the ERP', r.status === 201);
r = await callApi(KEY, 'GET', 'requests?status=completed&limit=5');
ok('requests are listed a page at a time', r.status === 200 && r.body.data.length === 5 && r.body.paging.next_offset === 5 && r.body.data.every((x) => x.status === 'completed'));
r = await callApi(KEY, 'GET', 'requests?include_archived=true&form=ManageEngine%20archive&limit=100');
ok('migrated tickets are there when asked for', r.status === 200 && r.body.paging.total === 48 && r.body.data[0].legacy.source === 'ManageEngine', JSON.stringify(r.body.paging));
r = await callApi(KEY, 'GET', 'reports');
const rep = r.body.data?.[0];
r = await callApi(KEY, 'GET', `reports/${rep.id}?format=csv`);
ok('a saved report comes as CSV, for Tableau or Power BI', r.status === 200 && r.type.startsWith('text/csv') && r.body.split('\n').length > 2, r.type);
r = await callApi(KEY, 'GET', 'campaigns');
ok('an endpoint outside the key\'s scopes is refused', r.status === 403 && /campaigns:read/.test(r.body.error.message));
r = await callApi(KEY, 'GET', 'nowhere');
ok('an endpoint that does not exist is a 404', r.status === 404);
const calls = await one(`select count(*)::int n, count(*) filter (where status = 403)::int refused, max(ip) ip from public.api_requests where key_id = (select id from public.api_keys where name = 'Oracle ERP — test')`);
ok('every call is logged, with its answer and where it came from', calls.n >= 17 && calls.refused >= 2 && calls.ip === '10.9.8.7', JSON.stringify(calls));

// ------------------------------------------------- webhooks
// The seeded one points at the built-in receiver; the deliveries the
// API's decision queued went there and were verified.
await settle(500);
const echo = await one(`select d.status, d.response_status, d.response_body from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id
  where w.url = '/webhooks/echo' and d.payload #>> '{data,request,reference}' = $1 and d.event = 'approval.approved'`, [created.reference]);
ok('the approval reached the ERP\'s webhook, through the built-in receiver, signature verified', echo?.status === 'delivered' && /"verified":true/.test(echo?.response_body ?? ''), JSON.stringify(echo));

await page.goto(BASE + '/admin/integrations?as=EMP-0445');
await settle(2500);
await page.getByRole('tab', { name: 'Webhooks' }).click();
await settle(800);
await page.getByRole('button', { name: /New webhook/ }).click();
await page.locator('input[aria-label="Webhook name"]').fill('Oracle ERP — submissions');
await page.locator('input[aria-label="Webhook URL"]').fill(`${RX}/erp`);
await page.locator('input[aria-label="request.submitted"]').check();
await page.getByRole('button', { name: 'Add webhook' }).click();
await settle(2500);
receiverSecret = (await page.locator('[data-testid="webhook-secret"] code').innerText()).trim();
ok('a webhook is added, and its signing secret shown', /^whsec_[A-Za-z0-9]{32}$/.test(receiverSecret), receiverSecret);
await page.locator('section', { hasText: 'Oracle ERP — submissions' }).getByRole('button', { name: /Send a test/ }).click();
await settle(3000);
ok('a test is delivered, and the receiver verified it', /Delivered/.test(await page.locator('[data-testid="test-result"]').innerText()) && received.some((x) => x.event === 'ping' && x.verified));
await shot('s6-webhooks');

// A webhook cannot be used to reach the network the server sits on.
await page.getByRole('button', { name: /New webhook/ }).click();
await page.locator('input[aria-label="Webhook name"]').fill('Metadata probe');
await page.locator('input[aria-label="Webhook URL"]').fill('http://169.254.169.254/latest/meta-data');
await page.getByRole('button', { name: 'Add webhook' }).click();
await settle(2000);
await page.getByRole('button', { name: 'Done' }).click();
await page.locator('section', { hasText: 'Metadata probe' }).getByRole('button', { name: /Send a test/ }).click();
await settle(2500);
const probe = await page.locator('section', { hasText: 'Metadata probe' }).locator('[data-testid="test-result"]').innerText();
ok('a webhook aimed at a private address is refused, not called', /private network/.test(probe) && !/200/.test(probe), probe);

r = await callApi(KEY, 'POST', 'requests', { form: 'Leave Application', on_behalf_of: 'EMP-1134', answers: await (async () => {
  const f = (await callApi(KEY, 'GET', 'forms/Leave Application')).body.data.fields;
  return Object.fromEntries(f.filter((x) => x.required).map((x) => [x.name, x.type === 'date' ? '2026-12-10' : x.options?.[0] ?? 'Family event']));
})() });
await settle(1000);
const sub = received.find((x) => x.event === 'request.submitted' && x.body.data.request.id === r.body.data?.id);
ok('a request raised elsewhere is announced to the ERP within the call, signed', r.status === 201 && sub?.verified === true, `${r.status} ${JSON.stringify(r.body).slice(0, 200)} ${received.map((x) => x.event).join(',')}`);
ok('...with the request in the body', sub?.body.data.request.form.name === 'Leave Application' && sub?.body.organisation);

// A receiver that is down: tried again, then failed, then redelivered.
receiver.closeAllConnections?.();
const prevSecret = receiverSecret;
receiverSecret = 'wrong-secret-so-it-refuses';
await callApi(KEY, 'POST', `requests/${r.body.data.id}/cancel`, { comment: 'Plans changed' });
r = await callApi(KEY, 'POST', 'requests', { form: 'Leave Application', on_behalf_of: 'EMP-1134', submit: false, answers: {} });
ok('a draft can be raised, and is not announced', r.status === 201 && r.body.data.status === 'draft');
r = await callApi(KEY, 'POST', `requests/${r.body.data.id}/submit`, {});
await settle(800);
const failed = await one(`select d.id, d.status, d.attempts, d.response_status from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id
  where w.name = 'Oracle ERP — submissions' and d.event = 'request.submitted' and d.payload #>> '{data,request,id}' = $1`, [r.body.data.id]);
ok('a refused delivery is queued to try again', failed?.status === 'queued' && failed.attempts === 1 && failed.response_status === 401, JSON.stringify(failed));
receiverSecret = prevSecret;
await page.getByRole('tab', { name: 'Deliveries' }).click();
await settle(2000);
await page.locator('[data-testid="deliveries"] button', { hasText: 'request.submitted' }).first().click();
await settle(1200);
ok('the delivery log shows what was sent', (await page.locator('[data-testid="delivery-payload"]').innerText()).includes('"request.submitted"'));
await page.getByRole('button', { name: /Redeliver/ }).click();
await settle(2500);
ok('...and redelivers it once the receiver is fixed', (await one(`select status from public.webhook_deliveries where id = $1`, [failed.id])).status === 'delivered');
await shot('s6-deliveries');

// ------------------------------------------------- traffic, and revoking
await page.getByRole('tab', { name: 'API traffic' }).click();
await settle(1500);
ok('the traffic tab charts the calls and lists the latest', (await page.locator('.recharts-surface').count()) >= 1 && (await page.locator('[data-testid="api-calls"]').innerText()).includes('/api/v1/requests'));
await shot('s6-traffic');
await page.getByRole('tab', { name: 'API keys' }).click();
await settle(800);
page.once('dialog', (d) => d.accept());
await page.locator('[data-testid="keys"] tr', { hasText: 'Oracle ERP — test' }).getByRole('button', { name: 'Revoke' }).click();
await settle(2000);
r = await callApi(KEY, 'GET', 'me');
ok('a revoked key is refused at once', r.status === 401 && /revoked/.test(r.body.error.message));

// ------------------------------------------------- migration from ManageEngine
await page.getByRole('tab', { name: 'Migration' }).click();
await settle(1500);
ok('the migration tab counts what is already migrated', (await page.locator('[data-testid="migrated-ManageEngine"]').innerText()).includes('48'));
const csv = [
  'Request ID,Subject,Requester,Request Status,Priority,Created Time,Completed Time,Technician,Resolution',
  'E2E-501,"Projector, board room",Sam Lindqvist,Closed,High,03/02/2021 10:15,04/02/2021 16:00,Rafiq Ahmed,Lamp replaced',
  'E2E-502,Shared drive access,tom@old-domain.test,Resolved,Medium,Feb 9 2021 9:30 AM,Feb 9 2021 2:00 PM,Lina Chowdhury,Granted',
  'E2E-503,New monitor,EMP-0312,Open,Low,10/02/2021 11:00,,,',
].join('\r\n');
await page.locator('input[aria-label="ManageEngine export"]').setInputFiles({ name: 'servicedesk.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
await settle(1500);
ok('an export is previewed with its columns mapped', (await page.locator('[data-testid="legacy-preview"] tbody tr').count()) === 3 && /Request ID → ref/.test(await text()));
await page.getByRole('button', { name: /Import 2 settled tickets/ }).click();
await settle(3000);
t = await page.locator('[data-testid="legacy-result"]').innerText();
ok('settled tickets come in; the open one does not', /Imported\s+2/.test(t) && /Still open\s+1/.test(t), t.replace(/\s+/g, ' '));
await shot('s6-migration');
const mig = await one(`select id, ref_number, submitted_by, archived_at from public.form_submissions where tenant_id = $1 and legacy_ref = 'E2E-501'`, [tenant]);
ok('...archived, matched to the org chart, under their old reference', mig?.ref_number === 'ME-E2E-501' && mig.submitted_by === 'EMP-1134' && mig.archived_at);
await page.goto(`${BASE}/status/${mig.id}?as=EMP-0445`);
await settle(2500);
ok('a migrated record says where it came from', /Migrated from ManageEngine/.test(await page.locator('[data-testid="archived-banner"]').innerText()));
await shot('s6-migrated-record');
await page.goto(BASE + '/submissions?archived=1&as=EMP-0445');
await settle(2500);
ok('the archive lists migrated records', (await text()).includes('ME-E2E-501') && (await text()).includes('From ManageEngine'));
await page.goto(BASE + '/submissions?as=EMP-1134');
await settle(2500);
ok('...and they are out of the working lists', !(await text()).includes('ME-E2E-501'));

// ------------------------------------------------- the audit centre
await page.goto(BASE + '/admin/audit?as=EMP-0445');
await settle(3500);
ok('the trail opens on the last seven days', (await page.locator('[data-testid="audit-trail"] tbody tr').count()) > 20);
await page.locator('input[aria-label="Search the trail"]').fill('Oracle ERP');
await settle(2000);
t = await page.locator('[data-testid="audit-trail"]').innerText();
ok('searching finds the key being made and revoked, and its calls', /API key made/.test(t) && /API key revoked/.test(t) && /API call/.test(t), t.slice(0, 300));
await page.locator('input[aria-label="Search the trail"]').fill('');
await page.locator('[data-testid="cat-database"]').click();
await settle(2000);
t = await page.locator('[data-testid="audit-trail"] tbody').innerText();
ok('the database category shows the migration', /Migrated from ManageEngine/.test(t));
await shot('s6-audit-trail');
const xl = await page.evaluate(async (h) => { const r = await fetch(h); const b = new Uint8Array(await r.arrayBuffer()); return { s: r.status, head: String.fromCharCode(b[0], b[1]) }; },
  await page.locator('[data-testid="export-xlsx"]').getAttribute('href'));
ok('the trail exports to Excel', xl.s === 200 && xl.head === 'PK');
ok('...and exporting it is itself recorded', !!(await one(`select 1 x from public.activity_log where tenant_id = $1 and action = 'audit_exported'`, [tenant])));
await page.getByRole('tab', { name: 'Monitoring' }).click();
await settle(3500);
ok('monitoring draws activity, sign-ins, hours, and people', (await page.locator('.recharts-surface').count()) >= 5);
t = await text();
ok('...and counts failed sign-ins and out-of-hours work', /Failed sign-ins\s+\d+/.test(t) && /Out of hours\s+[\d.]+%/.test(t));
await shot('s6-monitoring');
await page.getByRole('tab', { name: 'Retention' }).click();
await settle(2500);
t = await page.locator('[data-testid="retention-preview"]').innerText();
ok('retention says what the next run will do, and what is past twelve years', /Past retention\s+\d+/.test(t) && !/Past retention\s+0\b/.test(t), t.replace(/\s+/g, ' '));
await page.locator('button[name="run-retention"]').click();
await settle(2500);
ok('...and runs on demand, recorded', !!(await one(`select 1 x from public.system_runs where tenant_id = $1 and job = 'retention_run'`, [tenant])));
await shot('s6-retention');

// ------------------------------------------------- the developer page
await page.goto(BASE + '/developers?as=EMP-0445');
await settle(2500);
t = await text();
ok('the API documentation lists every endpoint, the scopes and the webhook signature', (await page.locator('section[id]').count()) >= 14 && t.includes('X-AMS-Signature') && t.includes('approvals:write'));
await shot('s6-developers');

// ------------------------------------------------- a failed sign-in is recorded
const ctx2 = await browser.newContext();
const p2 = await ctx2.newPage();
await ctx2.route(BASE + '/**', async (route) => {
  const q = route.request();
  const u = new URL(q.url());
  if (u.pathname !== '/' && extname(u.pathname)) {
    try { return route.fulfill({ status: 200, body: await readFile(DIST + '/client' + decodeURIComponent(u.pathname)), contentType: TYPES[extname(u.pathname)] ?? 'application/octet-stream' }); } catch {}
  }
  const res = await server.fetch(new Request(q.url(), { method: q.method(), headers: await q.allHeaders(), body: ['GET', 'HEAD'].includes(q.method()) ? undefined : q.postDataBuffer() }));
  const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
  await route.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
});
await p2.goto(BASE + '/login');
await p2.locator('input[autocomplete="username"]').fill(USER);
await p2.locator('input[autocomplete="current-password"]').fill('not-the-password');
await p2.locator('input[autocomplete="current-password"]').press('Enter');
await p2.waitForTimeout(2500);
ok('a wrong password is recorded for the audit trail', !!(await one(`select 1 x from public.activity_log where tenant_id = $1 and action = 'sign_in_failed' and created_at > now() - interval '1 minute'`, [tenant])));
await ctx2.close();

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
receiver.close();
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL STAGE 6 E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
