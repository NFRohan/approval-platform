// =====================================================================
// A stand-in for ServiceDesk Plus (on-premises), REST API v3.
//
//   node scripts/servicedesk-mock.mjs [port]          # default 8085
//
// Enough of the API for the link to run against when no real server is
// to hand: the authtoken header, input_data as a form field or query
// parameter, and these, answered in ServiceDesk's shapes —
//
//   GET  /api/v3/requests                    newest first, list_info.row_count
//   GET  /api/v3/requests/{id}
//   POST /api/v3/requests                    {request: {subject, requester, category, template, ...}}
//   POST /api/v3/requests/{id}/notes
//   POST /api/v3/requests/{id}/resolutions
//   PUT  /api/v3/requests/{id}/close
//
// GET /mock/state shows every ticket with its notes, resolution and
// closure. The technician key is MOCK_SDP_KEY (default "mock-technician-key").
//
// It stands in for the cloud's sign-in too: POST /oauth/v2/token swaps the
// code "mock-code" (client "mock-client", secret "mock-secret") for a
// refresh token, and a refresh token for an access token, which the API
// then takes as "Authorization: Zoho-oauthtoken <token>". Portal paths
// (/app/<portal>/api/v3/...) are answered as the plain ones.
// Imported by the tests as startMock().
// =====================================================================

import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function startMock({ port = 0, key = process.env.MOCK_SDP_KEY || 'mock-technician-key', tickets = [] } = {}) {
  let next = 1000;
  const store = new Map();
  const calls = [];
  const oauth = { refresh: new Set(), access: new Map(), refreshes: 0 };
  const add = (t) => {
    const id = String(t.id ?? ++next);
    const now = Date.now();
    store.set(id, {
      id, subject: t.subject ?? '(no subject)', description: t.description ?? '',
      requester: { name: t.requester_name ?? null, email_id: t.requester_email ?? null },
      category: t.category ? { name: t.category } : null, template: { name: t.template ?? 'Default Request' },
      priority: t.priority ? { name: t.priority } : null, status: { name: 'Open' },
      created_time: { value: String(t.created_ms ?? now), display_value: new Date(t.created_ms ?? now).toISOString() },
      notes: [], resolution: null, closure_info: null,
    });
    return store.get(id);
  };
  tickets.forEach(add);

  const ok = (res, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message) => ok(res, { response_status: { status_code: code, status: 'failed', messages: [{ status_code: code, type: 'failed', message }] } }, status);
  const success = (message) => ({ status_code: 2000, status: 'success', messages: [{ status_code: 2000, type: 'success', message }] });
  const brief = ({ notes, resolution, closure_info, description, ...t }) => t;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/mock/state') return ok(res, { tickets: [...store.values()], calls, oauth: { refreshes: oauth.refreshes } });
    if (url.pathname === '/oauth/v2/token' && req.method === 'POST') {
      const p = new URLSearchParams(raw);
      url.searchParams.forEach((v, k) => p.set(k, v));
      if (p.get('client_id') !== 'mock-client') return ok(res, { error: 'invalid_client' });
      if (p.get('client_secret') !== 'mock-secret') return ok(res, { error: 'invalid_client_secret' });
      const issue = () => { const t = 'mock-access-' + Math.random().toString(36).slice(2); oauth.access.set(t, Date.now() + 3600_000); return t; };
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'mock-code') return ok(res, { error: 'invalid_code' });
        const refresh = 'mock-refresh-' + Math.random().toString(36).slice(2);
        oauth.refresh.add(refresh);
        return ok(res, { access_token: issue(), refresh_token: refresh, api_domain: 'https://www.zohoapis.com', token_type: 'Bearer', expires_in: 3600 });
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (!oauth.refresh.has(p.get('refresh_token'))) return ok(res, { error: 'invalid_code' });
        oauth.refreshes++;
        return ok(res, { access_token: issue(), api_domain: 'https://www.zohoapis.com', token_type: 'Bearer', expires_in: 3600 });
      }
      return ok(res, { error: 'unsupported_grant_type' });
    }
    // A cloud portal's path, answered as the plain one.
    url.pathname = url.pathname.replace(/^\/app\/[^/]+(?=\/api\/)/, '');
    if (req.method === 'POST' && url.pathname === '/mock/tickets') {
      return ok(res, { request: brief(add(JSON.parse(raw || '{}'))) });
    }
    let input = null;
    const field = url.searchParams.get('input_data') ?? new URLSearchParams(raw).get('input_data');
    try { input = field ? JSON.parse(field) : null; } catch { return fail(res, 400, 4001, 'input_data is not JSON'); }
    calls.push({ method: req.method, path: url.pathname, input, at: new Date().toISOString() });
    const bearer = /^Zoho-oauthtoken (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const signedIn = bearer ? (oauth.access.get(bearer) ?? 0) > Date.now() : req.headers.authtoken === key;
    if (!signedIn) return fail(res, 401, 4002, 'UNAUTHORISED');
    if (!String(req.headers.accept ?? '').includes('application/vnd.manageengine.sdp.v3+json')) return fail(res, 400, 4000, 'Accept header missing');

    const m = /^\/api\/v3\/requests(?:\/([^/]+))?(?:\/(notes|resolutions|close))?$/.exec(url.pathname);
    if (!m) return fail(res, 404, 4007, 'Invalid URL');
    const [, id, sub] = m;
    if (!id) {
      if (req.method === 'POST') return ok(res, { request: brief(add({ ...(input?.request ?? {}), requester_email: input?.request?.requester?.email_id, category: input?.request?.category?.name, template: input?.request?.template?.name })), response_status: success('Request added successfully') }, 201);
      const rows = Number(input?.list_info?.row_count ?? 10);
      const all = [...store.values()].sort((a, b) => Number(b.created_time.value) - Number(a.created_time.value));
      return ok(res, {
        requests: all.slice(0, rows).map(brief),
        list_info: { row_count: rows, start_index: 1, has_more_rows: all.length > rows, total_count: all.length },
        response_status: [{ status_code: 2000, status: 'success' }],
      });
    }
    const t = store.get(id);
    if (!t) return fail(res, 404, 4007, 'Request not found');
    if (!sub && req.method === 'GET') { const { notes, resolution, closure_info, ...full } = t; return ok(res, { request: full, response_status: success('fetched') }); }
    if (sub === 'notes' && req.method === 'POST') {
      const note = { id: String(t.notes.length + 1), ...(input?.note ?? {}), added_time: { value: String(Date.now()) } };
      t.notes.push(note);
      return ok(res, { note, response_status: { status: 'success', statuscode: '2000' } });
    }
    if (sub === 'resolutions' && req.method === 'POST') {
      t.resolution = input?.resolution ?? null;
      t.status = { name: 'Resolved' };
      return ok(res, { response_status: success('Resolution added successfully.') });
    }
    if (sub === 'close' && req.method === 'PUT') {
      if (t.status.name === 'Closed') return fail(res, 400, 4000, 'Request is already closed');
      t.closure_info = input?.request?.closure_info ?? null;
      t.status = { name: 'Closed' };
      return ok(res, { response_status: success('Request(s) closed successfully.') });
    }
    return fail(res, 405, 4000, 'Method not allowed');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, key, store, calls, add, oauth,
    expireAccessTokens: () => { for (const k of oauth.access.keys()) oauth.access.set(k, 0); },
    close: () => new Promise((r) => server.close(r)),
  })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const m = await startMock({ port: Number(process.argv[2] || 8085) });
  console.log(`ServiceDesk stand-in at ${m.url} — technician key "${m.key}"`);
  console.log(`  add a ticket: curl -X POST ${m.url}/mock/tickets -d '{"subject":"Access to the ledger","requester_email":"tom.bexley@example.com","category":"Access"}'`);
  console.log(`  see them:     ${m.url}/mock/state`);
}
