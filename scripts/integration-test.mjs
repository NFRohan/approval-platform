// =====================================================================
// The open API, webhooks and the ManageEngine import, without a database.
//
//   npm run test:integration
//
// Webhook signatures as a receiver checks them — tampered, replayed and
// unsigned deliveries refused; the API's own answers before a key is
// looked up; the OpenAPI document made from the catalogue, and the
// catalogue agreeing with the database's scopes and events; and a
// ServiceDesk export read whichever way it spells its columns and dates.
// =====================================================================

import { createServer } from 'vite';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
process.env.JWT_SECRET ||= 'integration-test-secret-that-is-long-enough';
process.env.APP_URL = 'https://ams.example.test';
let passed = 0;
const failures = [];
function check(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { passed += 1; console.log(`  pass: ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
const hooks = await vite.ssrLoadModule('/src/server/webhooks.ts');
const api = await vite.ssrLoadModule('/src/server/api.ts');
const cat = await vite.ssrLoadModule('/src/lib/api-catalogue.ts');
const legacy = await vite.ssrLoadModule('/src/lib/legacy-file.ts');
const work = await vite.ssrLoadModule('/src/lib/workdays.ts');
const sd = await vite.ssrLoadModule('/src/server/servicedesk.ts');
const totp = await vite.ssrLoadModule('/src/server/totp.ts');
const { startMock } = await import('./servicedesk-mock.mjs');

console.log(NL + 'integration' + NL);

// ------------------------------------------------------------ signatures
{
  const secret = 'whsec_test_0123456789abcdefghijklmnop';
  const body = JSON.stringify({ id: 'd1', event: 'request.completed', data: { request: { reference: 'AMS-2026-00001' } } });
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const sig = hooks.signPayload(secret, ts, body);
  check('a signature is sha256= and 64 hex digits', /^sha256=[0-9a-f]{64}$/.test(sig), true);
  check('a delivery signed with the secret verifies', hooks.verifySignature(secret, sig, String(ts), body, now), { ok: true });
  check('a changed body does not', hooks.verifySignature(secret, sig, String(ts), body.replace('00001', '00002'), now).ok, false);
  check('another secret does not', hooks.verifySignature(secret + 'x', sig, String(ts), body, now).ok, false);
  check('a delivery replayed ten minutes later is refused', hooks.verifySignature(secret, sig, String(ts), body, now + 600_000), { ok: false, reason: 'too old' });
  check('an unsigned one is refused', hooks.verifySignature(secret, null, String(ts), body, now), { ok: false, reason: 'unsigned' });
  check('a timestamp moved to match is caught by the signature', hooks.verifySignature(secret, sig, String(ts + 1), body, now).ok, false);
  check('a path is this server', hooks.resolveTarget('/webhooks/echo'), 'https://ams.example.test/webhooks/echo');
  check('an address is used as given', hooks.resolveTarget('https://erp.example.test/h'), 'https://erp.example.test/h');
  check('loopback, private, link-local and metadata addresses are private',
    ['127.0.0.1', '10.2.3.4', '172.20.0.1', '192.168.1.9', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0'].every(hooks.isPrivateAddress), true);
  check('public addresses are not', ['8.8.8.8', '172.32.0.1', '203.0.113.7', '2606:4700::1111'].some(hooks.isPrivateAddress), false);
}

// ------------------------------------------------------------ the API before a key is looked up
{
  const call = async (path, init = {}) => {
    const res = await api.handleApi(new Request(`https://ams.example.test/api/v1/${path}`, init), path);
    return { status: res.status, body: await res.json() };
  };
  const index = await call('');
  check('the index names the OpenAPI document and the docs', [index.status, index.body.openapi, index.body.docs], [200, '/api/v1/openapi.json', '/developers']);
  const spec = await call('openapi.json');
  check('the OpenAPI document needs no key', [spec.status, spec.body.openapi], [200, '3.1.0']);
  check('its server is this one', spec.body.servers[0].url, 'https://ams.example.test/api/v1');
  const none = await call('requests');
  check('no key is a 401 with a reason', [none.status, none.body.error.message], [401, 'send an API key: Authorization: Bearer ams_…']);
  const bad = await call('requests', { headers: { authorization: 'Bearer sk_live_nonsense' } });
  check('something that is not a key is a 401', [bad.status, bad.body.error.message], [401, 'that is not an API key']);
  check('a key is hashed with SHA-256', api.hashSecret('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
}

// ------------------------------------------------------------ the OpenAPI document
{
  const doc = cat.openApiDocument('https://x.test');
  const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
  check('every endpoint is in the document', ops.length, cat.ENDPOINTS.length);
  check('operation ids are unique', new Set(ops.map((o) => o.operationId)).size, ops.length);
  const pathParamsDeclared = Object.entries(doc.paths).every(([path, p]) => Object.values(p).every((o) =>
    [...path.matchAll(/\{(\w+)\}/g)].every((m) => o.parameters.some((x) => x.in === 'path' && x.name === m[1] && x.required))));
  check('every {param} in a path is declared and required', pathParamsDeclared, true);
  const posts = Object.values(doc.paths).map((p) => p.post).filter(Boolean);
  check('every POST says what it takes', posts.length > 0 && posts.every((o) => o.requestBody?.content?.['application/json']?.example), true);
  check('every scoped endpoint names its scope', cat.ENDPOINTS.filter((e) => e.scope).every((e) => cat.API_SCOPES.some((s) => s.key === e.scope)), true);
  check('401 is documented on every operation', ops.every((o) => o.responses['401']), true);
}

// ------------------------------------------------------------ the catalogue agrees with the database
{
  const sql = readFileSync('db/009_integration.sql', 'utf8');
  const list = (fn) => {
    const m = new RegExp(`function app\\.${fn}\\(\\)[\\s\\S]*?array\\[([\\s\\S]*?)\\]`).exec(sql);
    return [...m[1].matchAll(/'([a-z_.:]+)'/g)].map((x) => x[1]).sort();
  };
  check('the scopes are the database\'s', cat.API_SCOPES.map((s) => s.key).sort(), list('api_scopes'));
  check('the events are the database\'s', cat.WEBHOOK_EVENTS.map((e) => e.key).sort(), list('webhook_events'));
}

// ------------------------------------------------------------ ServiceDesk dates
{
  const d = legacy.legacyDate;
  check('day-first with a time, read as Dhaka', d('12/03/2019 10:15'), '2019-03-12T04:15:00.000Z');
  check('a month name and AM/PM', d('Mar 12, 2019 10:15 AM'), '2019-03-12T04:15:00.000Z');
  check('12:05 AM is just after midnight', d('Mar 12, 2019 12:05 AM'), '2019-03-11T18:05:00.000Z');
  check('12:30 PM is just after noon', d('12/03/2019 12:30 PM'), '2019-03-12T06:30:00.000Z');
  check('year first with seconds', d('2019-03-12 10:15:00'), '2019-03-12T04:15:00.000Z');
  check('milliseconds, as the API gives them', d('1552364100000'), '2019-03-12T04:15:00.000Z');
  check('ISO with a zone kept', d('2019-03-12T04:15:00Z'), '2019-03-12T04:15:00.000Z');
  check('a bare date is Dhaka midnight', d('2019-03-12'), '2019-03-11T18:00:00.000Z');
  check('nothing, a dash and nonsense are no date', [d(''), d('-'), d('soon'), d('31/31/2019')], [null, null, null, null]);
}

// ------------------------------------------------------------ ServiceDesk exports
{
  const csv = '﻿Request ID,Subject,Requester Name,Request Status,Created Time,Completed Time,Technician,Resolution' + '\r\n'
    + '10237,"Printer, 4th floor",Sam Lindqvist,Closed,12/03/2019 10:15,13/03/2019 09:00,Rafiq,"Replaced the ""fuser"""' + '\r\n'
    + '10238,VPN,EMP-1134,Open,14/03/2019 11:00,,,' + '\r\n'
    + ',,,,,,,' + '\r\n';
  const p = legacy.readLegacyFile(csv);
  check('the columns are found under ServiceDesk\'s names', [p.columns.ref, p.columns.requester, p.columns.closed], ['Request ID', 'Requester Name', 'Completed Time']);
  check('nothing required is missing', p.missing, []);
  check('blank lines are dropped', p.rows.length, 2);
  check('a quoted comma and quotes survive', [p.rows[0].subject, p.rows[0].resolution], ['Printer, 4th floor', 'Replaced the "fuser"']);
  check('dates become ISO', [p.rows[0].created, p.rows[0].closed], ['2019-03-12T04:15:00.000Z', '2019-03-13T03:00:00.000Z']);
  check('an open ticket keeps its status for the import to refuse', p.rows[1].status, 'Open');
  const other = legacy.readLegacyFile('Ticket ID,Title,Status' + NL + 'A-1,Laptop,Resolved' + NL);
  check('an export without a created date says so', other.missing, ['Created Time']);
  check('other spellings of the columns are read', [other.rows[0].ref, other.rows[0].subject], ['A-1', 'Laptop']);
  const rows = [{ ref: 'SR-1', subject: 'Mailbox, full', requester: 'EMP-2847', status: 'Closed', created: '2020-01-05T04:00:00.000Z', closed: '2020-01-06T04:00:00.000Z', resolution: 'Archived "old" mail' }];
  const back = legacy.readLegacyFile(legacy.legacyCsv(rows)).rows[0];
  check('a sample export reads back as it was written', [back.ref, back.subject, back.created, back.closed, back.resolution],
    ['SR-1', 'Mailbox, full', '2020-01-05T04:00:00.000Z', '2020-01-06T04:00:00.000Z', 'Archived "old" mail']);
}

// ------------------------------------------------------------ the working calendar, as the browser previews it
{
  const day = (d) => work.todayInOrg(d);
  const at = (s) => new Date(`${s}T12:00:00+06:00`);
  const eid = new Set(['2027-03-05', '2027-03-07', '2027-03-08', '2027-03-09', '2027-03-10', '2027-03-11', '2027-03-12']);
  check('three working days from Thursday 4 March 2027, over the Eid break, is Tuesday the 16th', day(work.addWorkingDays(at('2027-03-04'), 3, eid)), '2027-03-16');
  check('without holidays, only the weekend is skipped', day(work.addWorkingDays(at('2027-03-04'), 3, new Set())), '2027-03-09');
  check('a holiday on a weekend costs nothing extra', day(work.addWorkingDays(at('2027-03-04'), 1, new Set(['2027-03-05']))), '2027-03-07');
  check('a working day is not Friday, Saturday or a holiday', [at('2027-03-07'), at('2027-03-05'), at('2027-03-14')].map((d) => work.isWorkingDay(d, eid)), [false, false, true]);
  work.setOrgHolidays(['2027-12-16']);
  check('the loaded calendar is the default', day(work.addWorkingDays(at('2027-12-15'), 1)), '2027-12-19');
  work.setOrgHolidays([]);
}

// ------------------------------------------------------------ ServiceDesk Plus
{
  const t = sd.normaliseTicket({ request: {
    id: '4812', subject: 'Ledger access', description: '<div>Need <b>read</b> access.<br>Thanks &amp; regards</div>',
    requester: { name: 'Tom Bexley', email_id: 'tom.bexley@example.com' }, category: { name: 'Access' },
    template: { name: 'Access Request' }, priority: { name: 'High' }, status: { name: 'Open' },
    created_time: { value: '1795423272000', display_value: 'Nov 23, 2026 08:41 AM' },
  } });
  check('a v3 request object is read', [t.id, t.requester_email, t.category, t.template, t.priority, t.created_ms],
    ['4812', 'tom.bexley@example.com', 'Access', 'Access Request', 'High', 1795423272000]);
  check('its HTML description becomes text', t.description, 'Need read access.' + NL + 'Thanks & regards');
  check('a webhook sending only the id is read', sd.normaliseTicket({ id: 4813 })?.id, '4813');
  check('a flat webhook body is read', sd.normaliseTicket({ id: '9', requester_email: 'a@b.c', category: 'Access' })?.requester_email, 'a@b.c');
  check('no id, or one that could carry a path, is no ticket', [sd.normaliseTicket({ subject: 'x' }), sd.normaliseTicket({ id: '../admin' })], [null, null]);
  check('success is read from either shape of response_status',
    [sd.sdpOk({ status: 200, json: { response_status: { status: 'success' } } }).ok, sd.sdpOk({ status: 200, json: { response_status: [{ status: 'success' }] } }).ok,
     sd.sdpOk({ status: 401, json: { response_status: { status: 'failed', messages: [{ message: 'UNAUTHORISED' }] } } })],
    [true, true, { ok: false, message: 'UNAUTHORISED' }]);

  process.env.OUTBOUND_ALLOW_PRIVATE = '1';
  const mock = await startMock({ tickets: [{ id: '7001', subject: 'Ledger', requester_email: 'tom.bexley@example.com', category: 'Access' }] });
  const link = { base_url: mock.url, token_sealed: totp.sealSecret(mock.key), allow_self_signed: false };
  let r = await sd.sdpCall(link, 'GET', '/api/v3/requests', { list_info: { row_count: 5 } });
  check('the list is fetched with the technician key', [sd.sdpOk(r).ok, r.json.requests[0].id], [true, '7001']);
  check('...input_data on a GET is a query parameter', mock.calls.at(-1).input, { list_info: { row_count: 5 } });
  r = await sd.sdpCall(link, 'POST', '/api/v3/requests/7001/notes', { note: { description: 'Approved by Sam', show_to_requester: true } });
  check('a note is added, input_data as a form field', [sd.sdpOk(r).ok, mock.store.get('7001').notes[0].description], [true, 'Approved by Sam']);
  r = await sd.sdpCall(link, 'PUT', '/api/v3/requests/7001/close', { request: { closure_info: { closure_code: { name: 'Success' } } } });
  check('a ticket is closed', [sd.sdpOk(r).ok, mock.store.get('7001').status.name], [true, 'Closed']);
  r = await sd.sdpCall({ ...link, token_sealed: totp.sealSecret('wrong') }, 'GET', '/api/v3/requests');
  check('a wrong key is refused, and says so', sd.sdpOk(r), { ok: false, message: 'UNAUTHORISED' });
  let threw = null;
  try { await sd.sdpCall({ ...link, token_sealed: null }, 'GET', '/api/v3/requests'); } catch (e) { threw = e.message; }
  check('without a key nothing is sent', /not connected/.test(threw ?? ''), true);

  // The cloud: a Zoho sign-in rather than a technician key.
  const code = await sd.zohoToken(mock.url, { grant_type: 'authorization_code', client_id: 'mock-client', client_secret: 'mock-secret', code: 'mock-code' }, true);
  check('a Self Client code is swapped for a refresh token', typeof code.refresh_token, 'string');
  check('...once', (await sd.zohoToken(mock.url, { grant_type: 'authorization_code', client_id: 'mock-client', client_secret: 'x', code: 'mock-code' }, true)).error, 'invalid_client_secret');
  const cloud = {
    base_url: mock.url + '/app/itdesk', token_sealed: null, allow_self_signed: false, auth_mode: 'oauth',
    oauth_accounts_url: mock.url, oauth_client_id: 'mock-client', oauth_secret_sealed: totp.sealSecret('mock-secret'),
    oauth_refresh_sealed: totp.sealSecret(code.refresh_token),
  };
  r = await sd.sdpCall(cloud, 'GET', '/api/v3/requests', { list_info: { row_count: 1 } });
  check('a cloud portal is called with a Zoho access token', sd.sdpOk(r).ok, true);
  r = await sd.sdpCall(cloud, 'GET', '/api/v3/requests', { list_info: { row_count: 1 } });
  check('...kept for its hour rather than renewed each call', mock.oauth.refreshes, 1);
  mock.expireAccessTokens();
  r = await sd.sdpCall(cloud, 'GET', '/api/v3/requests', { list_info: { row_count: 1 } });
  check('...and renewed when ServiceDesk stops taking it', [sd.sdpOk(r).ok, mock.oauth.refreshes], [true, 2]);
  // The cloud's shapes: each write-back as the cloud documents it, and
  // the on-premises shape if refused.
  const tryAll = async (link, kind, payload) => {
    for (const a of sd.attemptsFor(kind, '7001', payload, link.auth_mode === 'oauth')) {
      const res = await sd.sdpCall(link, a.method, a.path, a.input);
      if (sd.sdpOk(res).ok) return a.label;
    }
    return null;
  };
  mock.add({ id: '7001', subject: 'again', requester_email: 'tom.bexley@example.com' });
  check('a cloud note goes as request_note', await tryAll(cloud, 'note', { note: { description: 'Approved by Sam', show_to_requester: true } }), 'request_note');
  check('...an on-premises one as note', await tryAll({ ...link }, 'note', { note: { description: 'x' } }), 'note');
  check('a cloud resolution is set on the request', await tryAll(cloud, 'resolution', { resolution: { content: 'Approved by: Sam' } }), 'request.resolution');
  check('a cloud ticket is closed by its status, with the closure details',
    [await tryAll(cloud, 'close', { request: { closure_info: { closure_code: { name: 'Success' }, closure_comments: 'ok' } } }),
     mock.store.get('7001').status.name, mock.store.get('7001').closure_info?.closure_code?.name],
    ['status Closed', 'Closed', 'Success']);
  check('the client secret is sent to Zoho\'s accounts servers only',
    ['https://accounts.zoho.in', 'https://accounts.zohocloud.ca', 'https://accounts.zoho.in.evil.test', 'http://accounts.zoho.com'].map((u) => sd.ZOHO_ACCOUNTS.test(u)),
    [true, true, false, false]);

  delete process.env.OUTBOUND_ALLOW_PRIVATE;
  threw = null;
  try { await sd.sdpCall(link, 'GET', '/api/v3/requests'); } catch (e) { threw = e.message; }
  check('a private address is refused unless the deployment allows it', /private network/.test(threw ?? ''), true);
  await mock.close();
}

await vite.close();
console.log('');
if (failures.length) {
  console.log(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL INTEGRATION CHECKS PASSED (${passed})`);
process.exit(0);
