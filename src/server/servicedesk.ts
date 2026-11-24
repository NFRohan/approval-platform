// =====================================================================
// ManageEngine ServiceDesk Plus (on-premises), REST API v3.
//
// Every call: the technician's API key in an `authtoken` header, Accept
// `application/vnd.manageengine.sdp.v3+json`, and the arguments as a
// form field `input_data` holding JSON — a query parameter on a GET.
// Success is response_status.status = "success".
//
//   GET  /api/v3/requests                     new tickets (newest first)
//   GET  /api/v3/requests/{id}                one ticket in full
//   POST /api/v3/requests/{id}/notes          {note: {description, show_to_requester}}
//   POST /api/v3/requests/{id}/resolutions    {resolution: {content}}
//   PUT  /api/v3/requests/{id}/close          {request: {closure_info: {...}}}
//
// Tickets come in two ways, so the link works whatever the edition
// allows: ServiceDesk's own webhook (a custom trigger on new requests
// posting to /integrations/servicedesk/<organisation>), or this side
// fetching new tickets — on demand and in the daily round.
//
// An on-premises server usually has a self-signed certificate, so a link
// may accept one; and it usually sits on a private network, which an
// outbound call may only reach where OUTBOUND_ALLOW_PRIVATE=1 says so.
// =====================================================================

import http from 'node:http';
import https from 'node:https';
import type pg from 'pg';
import { getPool } from './db';
import { openSecret, sealSecret } from './totp';
import { assertReachable } from './webhooks';

export type Link = {
  tenant_id: string; enabled: boolean; base_url: string | null; token_sealed: string | null; allow_self_signed: boolean;
  poll_cursor: string | null;
  // ServiceDesk Plus Cloud: Zoho OAuth instead of a technician key.
  auth_mode?: 'authtoken' | 'oauth';
  oauth_accounts_url?: string | null; oauth_client_id?: string | null; oauth_secret_sealed?: string | null;
  oauth_refresh_sealed?: string | null; oauth_access_sealed?: string | null; oauth_access_expires?: string | Date | null;
};
type CallLink = Pick<Link, 'base_url' | 'token_sealed' | 'allow_self_signed'> & Partial<Link>;

export type Ticket = {
  id: string; subject: string; description: string; requester_email: string | null; requester_name: string | null;
  category: string | null; template: string | null; priority: string | null; status: string | null;
  created_ms: number | null; fields: Record<string, string>;
};

export type SdpResult = { status: number; body: string; json: Record<string, unknown> | null; ms: number };

const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';

// ---------------------------------------------------------------------
// Zoho OAuth, for ServiceDesk Plus Cloud.
//
// A Self Client in Zoho's API console issues a short-lived code; the
// code is swapped once for a refresh token, which never expires and is
// kept sealed; the refresh token buys an access token for an hour at a
// time (at most ten in ten minutes, so it is kept and reused). Calls
// carry it as "Authorization: Zoho-oauthtoken <token>".
// ---------------------------------------------------------------------
export const ZOHO_ACCOUNTS = /^https:\/\/accounts\.(zoho\.(com|eu|in|com\.au|jp|sa|uk)|zohocloud\.ca)$/;

export type ZohoToken = { access_token?: string; refresh_token?: string; expires_in?: number; api_domain?: string; error?: string };

export async function zohoToken(accountsUrl: string, params: Record<string, string>, inQuery = false): Promise<ZohoToken> {
  // The client secret goes to Zoho and nowhere else. (A test's stand-in
  // accounts server is allowed where private addresses are.)
  if (!ZOHO_ACCOUNTS.test(accountsUrl) && process.env.OUTBOUND_ALLOW_PRIVATE !== '1') throw new Error('that is not a Zoho accounts server');
  const form = new URLSearchParams(params).toString();
  const res = await fetch(accountsUrl + '/oauth/v2/token' + (inQuery ? '?' + form : ''), {
    method: 'POST',
    headers: inQuery ? {} : { 'content-type': 'application/x-www-form-urlencoded' },
    body: inQuery ? undefined : form,
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as ZohoToken;
  if (!res.ok && !json.error) json.error = `Zoho answered ${res.status}`;
  return json;
}

/** An access token for a cloud link: the one kept, or a fresh one. */
async function accessToken(link: CallLink, force: boolean): Promise<string> {
  const expires = link.oauth_access_expires ? new Date(link.oauth_access_expires).getTime() : 0;
  const kept = openSecret(link.oauth_access_sealed);
  if (!force && kept && expires > Date.now() + 120_000) return kept;
  const refresh = openSecret(link.oauth_refresh_sealed);
  if (!refresh || !link.oauth_accounts_url || !link.oauth_client_id) throw new Error('ServiceDesk is not connected: sign in with Zoho first');
  const t = await zohoToken(link.oauth_accounts_url, {
    grant_type: 'refresh_token', client_id: link.oauth_client_id, client_secret: openSecret(link.oauth_secret_sealed) ?? '', refresh_token: refresh,
  });
  if (!t.access_token) {
    throw new Error(t.error === 'invalid_code' ? 'Zoho no longer accepts the sign-in (the refresh token was revoked) — sign in again'
      : `Zoho would not renew the sign-in: ${t.error ?? 'no token'}`);
  }
  const until = new Date(Date.now() + (t.expires_in ?? 3600) * 1000);
  link.oauth_access_sealed = sealSecret(t.access_token);
  link.oauth_access_expires = until;
  if (link.tenant_id) {
    await getPool().query('update public.servicedesk_links set oauth_access_sealed = $2, oauth_access_expires = $3 where tenant_id = $1',
      [link.tenant_id, link.oauth_access_sealed, until]).catch(() => {});
  }
  return t.access_token;
}

async function authHeaders(link: CallLink, force: boolean): Promise<Record<string, string>> {
  if (link.auth_mode === 'oauth') return { authorization: `Zoho-oauthtoken ${await accessToken(link, force)}` };
  const token = openSecret(link.token_sealed);
  if (!token) throw new Error('ServiceDesk is not connected: no technician key');
  return { authtoken: token };
}

/** One call to ServiceDesk. Throws only when nothing came back at all. */
export async function sdpCall(link: CallLink, method: 'GET' | 'POST' | 'PUT', path: string, inputData?: unknown): Promise<SdpResult> {
  if (!link.base_url) throw new Error('ServiceDesk is not connected: no address');
  const first = await sdpOnce(link, method, path, inputData, await authHeaders(link, false));
  if (first.status !== 401 || link.auth_mode !== 'oauth') return first;
  // A cloud token can be withdrawn before its hour is up: renew it once.
  const fresh = await authHeaders(link, true);
  const second = await sdpOnce(link, method, path, inputData, fresh);
  if (second.status !== 401) return second;
  // Zoho's own pages write the header "Bearer"; ServiceDesk's write
  // "Zoho-oauthtoken". The second is tried first.
  return sdpOnce(link, method, path, inputData, { authorization: fresh.authorization.replace('Zoho-oauthtoken', 'Bearer') });
}

async function sdpOnce(link: CallLink, method: 'GET' | 'POST' | 'PUT', path: string, inputData: unknown, auth: Record<string, string>): Promise<SdpResult> {
  const url = new URL(link.base_url!.replace(/\/$/, '') + path);
  await assertReachable(url.toString(), 'the ServiceDesk link');
  const encoded = inputData === undefined ? null : 'input_data=' + encodeURIComponent(JSON.stringify(inputData));
  if (encoded && method === 'GET') url.search = encoded;
  const body = encoded && method !== 'GET' ? encoded : null;
  const started = Date.now();
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method,
      headers: {
        ...auth,
        accept: ACCEPT,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'AMS-ServiceDesk/1.0',
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
      timeout: 10_000,
      ...(url.protocol === 'https:' ? { rejectUnauthorized: !link.allow_self_signed } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null = null;
        try { json = JSON.parse(text); } catch { /* not JSON: reported as text */ }
        resolve({ status: res.statusCode ?? 0, body: text.slice(0, 2000), json, ms: Date.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error('ServiceDesk did not answer within 10 seconds')));
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      reject(new Error(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)
        ? `ServiceDesk's certificate is not trusted (${code}) — allow a self-signed certificate if it is your own server`
        : err.message));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Did ServiceDesk say yes? Its status sits in response_status, as an object or a list. */
export function sdpOk(r: SdpResult): { ok: boolean; message: string } {
  const rs = r.json?.response_status as unknown;
  const first = (Array.isArray(rs) ? rs[0] : rs) as { status?: string; messages?: { message?: string; type?: string }[] } | undefined;
  const ok = r.status >= 200 && r.status < 300 && (first ? first.status === 'success' : !!r.json);
  const message = first?.messages?.map((m) => m.message).filter(Boolean).join('; ')
    || (ok ? 'success' : r.status === 401 ? 'the sign-in was refused' : `ServiceDesk answered ${r.status}`);
  return { ok, message };
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return text(o.name ?? o.email_id ?? o.display_value ?? o.value ?? null);
  }
  const s = String(v).trim();
  return s ? s : null;
};

/** ServiceDesk writes descriptions as HTML. */
export function plainText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A ticket, whichever shape it arrived in: a v3 request object, one
 * wrapped as {request: …}, or the flat body a webhook was set up to send
 * ({id, subject, requester_email, …}). Null without an id.
 */
export function normaliseTicket(raw: unknown): Ticket | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, unknown>;
  const r = (outer.request && typeof outer.request === 'object' ? outer.request : outer) as Record<string, unknown>;
  const id = text(r.id ?? r.request_id ?? r.workorderid ?? r.WORKORDERID);
  if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const requester = (r.requester && typeof r.requester === 'object' ? r.requester : {}) as Record<string, unknown>;
  const created = r.created_time as { value?: unknown } | string | number | undefined;
  const createdMs = typeof created === 'object' && created ? Number(created.value) : created !== undefined ? Number(created) : NaN;
  const fields: Record<string, string> = {};
  const extra = (r.fields ?? r.udf_fields ?? r.custom_fields) as Record<string, unknown> | undefined;
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) { const t = text(v); if (t) fields[k] = t; }
  }
  return {
    id,
    subject: text(r.subject) ?? '(no subject)',
    description: plainText(text(r.description) ?? text(r.short_description) ?? ''),
    requester_email: text(r.requester_email ?? requester.email_id ?? requester.email),
    requester_name: text(r.requester_name ?? requester.name),
    category: text(r.category),
    template: text(r.template ?? r.request_template),
    priority: text(r.priority),
    status: text(r.status),
    created_ms: Number.isFinite(createdMs) ? createdMs : null,
    fields,
  };
}

/** Has the link somewhere to call, and a way to sign in there? */
export function connected(link: Partial<Link> | null | undefined): boolean {
  if (!link?.base_url) return false;
  return link.auth_mode === 'oauth' ? !!link.oauth_refresh_sealed : !!link.token_sealed;
}

/** Set the organisation for a transaction run as the owner, as the inbound routes do. */
export async function asTenant(client: pg.PoolClient, tenantId: string) {
  await client.query(
    `select set_config('app.tenant_id', $1, true), set_config('app.role', 'admin', true),
            set_config('app.employee_id', '', true), set_config('app.user_id', '', true)`, [tenantId]);
}

/** A ticket, in full: the webhook may have sent only its id. */
export async function completeTicket(link: Link, t: Ticket): Promise<Ticket> {
  if (t.requester_email || t.requester_name) return t;
  if (!connected(link)) return t;
  const r = await sdpCall(link, 'GET', `/api/v3/requests/${encodeURIComponent(t.id)}`);
  const ok = sdpOk(r);
  if (!ok.ok) throw new Error(`fetching ticket #${t.id}: ${ok.message}`);
  return normaliseTicket(r.json) ?? t;
}

/** One transaction as the organisation, run as the owner, as the inbound routes do. */
async function inTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await asTenant(client, tenantId);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// IT clearance (db/009_sow_gaps.sql)
//
// A leaver's IT track raises a ticket here (a queued 'create'); what
// ServiceDesk then says of that ticket — by its webhook, or when this
// side looks — clears the track once it is resolved or closed.
// ---------------------------------------------------------------------

/** Ticket numbers that are clearance tickets still open, so the intake leaves them alone. */
async function clearanceTickets(tenantId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ ticket_id: string }>(
    `select ticket_id from public.servicedesk_tasks where tenant_id = $1 and ticket_id is not null`, [tenantId]);
  return new Set(rows.map((r) => r.ticket_id));
}

/** What ServiceDesk says of a clearance ticket; null if it is not one. */
export async function clearanceUpdate(tenantId: string, ticketId: string, status: string | null): Promise<Record<string, unknown> | null> {
  return inTenant(tenantId, async (c) =>
    (await c.query('select app.servicedesk_clearance_update($1, $2) as r', [ticketId, status ?? ''])).rows[0].r);
}

/**
 * A ticket ServiceDesk told us about, if it is a clearance ticket: its
 * status is fetched (a webhook may send only the id) and acted on.
 */
export async function handleClearanceTicket(tenantId: string, link: Link, t: Ticket): Promise<Record<string, unknown> | null> {
  if (!(await clearanceTickets(tenantId)).has(t.id)) return null;
  let status = t.status;
  if (connected(link)) {
    const r = await sdpCall(link, 'GET', `/api/v3/requests/${encodeURIComponent(t.id)}`);
    if (sdpOk(r).ok) status = normaliseTicket(r.json)?.status ?? status;
  }
  return clearanceUpdate(tenantId, t.id, status);
}

/** Look at each open clearance ticket: resolved there, the track clears here. */
export async function checkClearances(tenantId: string, link: Link): Promise<{ checked: number; cleared: number }> {
  const out = { checked: 0, cleared: 0 };
  const { rows } = await getPool().query<{ ticket_id: string }>(
    `select ticket_id from public.servicedesk_tasks where tenant_id = $1 and status = 'open' and ticket_id is not null`, [tenantId]);
  for (const k of rows) {
    const r = await sdpCall(link, 'GET', `/api/v3/requests/${encodeURIComponent(k.ticket_id)}`);
    if (!sdpOk(r).ok) continue;
    out.checked++;
    const res = await clearanceUpdate(tenantId, k.ticket_id, normaliseTicket(r.json)?.status ?? null);
    if (res?.outcome === 'cleared') out.cleared++;
  }
  return out;
}

export async function receiveTicket(tenantId: string, t: Ticket, via: string): Promise<Record<string, unknown>> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await asTenant(client, tenantId);
    const { rows: [r] } = await client.query('select app.servicedesk_ticket($1::jsonb, $2) as r', [JSON.stringify(t), via]);
    await client.query('commit');
    return r.r;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const CLOSED = /^(closed|resolved|cancel+ed|completed|rejected)$/i;

/** New tickets since the last look, newest first, until one already seen. */
export async function pollServicedesk(tenantId: string): Promise<{ seen: number; raised: number; ignored: number; refused: number; error?: string }> {
  const pool = getPool();
  const { rows: [link] } = await pool.query<Link>('select * from public.servicedesk_links where tenant_id = $1', [tenantId]);
  const out = { seen: 0, raised: 0, ignored: 0, refused: 0 } as { seen: number; raised: number; ignored: number; refused: number; error?: string };
  if (!link?.enabled) return { ...out, error: 'not connected' };
  // The first look goes back a week; after that, from the newest seen.
  let cursor = link.poll_cursor ? Number(link.poll_cursor) : Date.now() - 7 * 86_400_000;
  let newest = cursor;
  try {
    const r = await sdpCall(link, 'GET', '/api/v3/requests', {
      list_info: { row_count: 50, start_index: 1, sort_field: 'created_time', sort_order: 'desc', get_total_count: false },
    });
    const ok = sdpOk(r);
    if (!ok.ok) throw new Error(ok.message);
    const list = ((r.json?.requests as unknown[]) ?? []).map(normaliseTicket).filter(Boolean) as Ticket[];
    // Tickets this side raised for a leaver's IT clearance are not requests for approval.
    const ours = await clearanceTickets(tenantId);
    for (const brief of list) {
      if (brief.created_ms !== null && brief.created_ms <= cursor) break;
      if (brief.created_ms !== null) newest = Math.max(newest, brief.created_ms);
      if (ours.has(brief.id)) continue;
      out.seen++;
      if (brief.status && CLOSED.test(brief.status)) { out.ignored++; continue; }
      const full = await sdpCall(link, 'GET', `/api/v3/requests/${encodeURIComponent(brief.id)}`);
      const t = sdpOk(full).ok ? normaliseTicket(full.json) ?? brief : brief;
      const res = await receiveTicket(tenantId, t, 'fetched');
      if (res.outcome === 'raised') out.raised++;
      else if (res.outcome === 'refused') out.refused++;
      else out.ignored++;
    }
    cursor = newest;
    await checkClearances(tenantId, link);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  await pool.query(
    `update public.servicedesk_links set poll_cursor = $2, last_poll_at = now(), last_poll_result = $3 where tenant_id = $1`,
    [tenantId, Math.round(cursor), JSON.stringify(out)]);
  return out;
}

type Claimed = { id: string; tenant_id: string; kind: string; ticket_id: string; payload: Record<string, unknown>; attempts: number };
const RETRY_MINUTES = [1, 5, 30];

/**
 * Write back what is queued, oldest first, one ticket's in order: a
 * ticket's close never overtakes its resolution. Not connected, each is
 * marked skipped — kept with what would have been sent.
 */
export async function drainServicedesk(opts: { tenantId?: string | null; only?: string } = {})
  : Promise<{ sent: number; failed: number; skipped: number; retrying: number }> {
  const pool = getPool();
  const out = { sent: 0, failed: 0, skipped: 0, retrying: 0 };
  for (let round = 0; round < 10; round++) {
    const { rows } = await pool.query<Claimed>(
      `update public.servicedesk_events e set status = 'sending', attempts = e.attempts + 1
        where e.id in (
          select x.id from public.servicedesk_events x
           where x.direction = 'out' and x.status = 'queued' and x.next_attempt_at <= now()
             and ($1::uuid is null or x.tenant_id = $1) and ($2::uuid is null or x.id = $2)
             and not exists (select 1 from public.servicedesk_events y
                              where y.tenant_id = x.tenant_id and y.ticket_id = x.ticket_id and y.direction = 'out'
                                and y.status in ('queued', 'sending') and y.seq < x.seq)
           order by x.seq limit 20 for update skip locked)
       returning e.id, e.tenant_id, e.kind, e.ticket_id, e.payload, e.attempts, e.seq`,
      [opts.tenantId ?? null, opts.only ?? null]);
    if (!rows.length) break;
    for (const e of rows) {
      const { rows: [link] } = await pool.query<Link>('select * from public.servicedesk_links where tenant_id = $1', [e.tenant_id]);
      if (!link?.enabled || !connected(link)) {
        await pool.query(`update public.servicedesk_events set status = 'skipped', error = 'ServiceDesk is not connected', done_at = now() where id = $1`, [e.id]);
        out.skipped++;
        continue;
      }
      let status: number | null = null, body = '', error: string | null = null, json: Record<string, unknown> | null = null;
      // The forms this edition documents first; the other's if refused.
      for (const a of attemptsFor(e.kind, e.ticket_id, e.payload, link.auth_mode === 'oauth')) {
        try {
          const r = await sdpCall(link, a.method, a.path, a.input);
          status = r.status; body = r.body; json = r.json;
          const ok = sdpOk(r);
          error = ok.ok ? null : ok.message;
          if (ok.ok) { body = `[${a.label}] ${body}`; break; }
          // Signing in or the server failing is not a question of shape.
          if (r.status === 401 || r.status >= 500) break;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      // A ticket raised is only raised once its number is known.
      let created: string | null = null;
      if (!error && e.kind === 'create') {
        const id = (json?.request as { id?: unknown } | undefined)?.id;
        created = id !== undefined && id !== null && /^[A-Za-z0-9_-]{1,40}$/.test(String(id)) ? String(id) : null;
        if (!created) error = 'ServiceDesk did not say what the new ticket is';
      }
      if (!error) {
        await pool.query(`update public.servicedesk_events set status = 'sent', http_status = $2, response = $3, error = null, done_at = now(),
                                 ticket_id = coalesce($4, ticket_id) where id = $1`,
          [e.id, status, body.slice(0, 1000), created]);
        if (created) await pool.query('select app.servicedesk_task_opened($1, $2)', [e.payload.task, created]);
        out.sent++;
      } else {
        const last = e.attempts > RETRY_MINUTES.length;
        await pool.query(
          `update public.servicedesk_events set status = $2, http_status = $3, response = $4, error = $5,
                  next_attempt_at = now() + make_interval(mins => $6) where id = $1`,
          [e.id, last ? 'failed' : 'queued', status, body.slice(0, 1000) || null, error.slice(0, 500),
           RETRY_MINUTES[Math.min(e.attempts - 1, RETRY_MINUTES.length - 1)]]);
        if (last && e.kind === 'create') await pool.query('select app.servicedesk_task_failed($1)', [e.payload.task]);
        if (last) out.failed++; else out.retrying++;
      }
    }
    if (opts.only) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// The two editions take the same things in different shapes:
//
//   note        on premises {note: …} at /notes; the cloud {request_note: …}
//   resolution  on premises {resolution: …} at /resolutions; the cloud on
//               the request itself, {request: {resolution: …}}
//   close       on premises PUT /close with closure_info; the cloud's
//               documentation has no close call, so the request's status
//               is set to Closed with the closure details on it
//
// Each is tried in the order the edition documents, and the other's
// shape if it is refused for its shape.
// ---------------------------------------------------------------------
type Attempt = { label: string; method: 'POST' | 'PUT'; path: string; input: unknown };

export function attemptsFor(kind: string, ticket: string, payload: Record<string, unknown>, cloud: boolean): Attempt[] {
  const base = `/api/v3/requests/${encodeURIComponent(ticket)}`;
  if (kind === 'note') {
    const note = (payload.note ?? payload.request_note) as Record<string, unknown>;
    const onprem: Attempt = { label: 'note', method: 'POST', path: `${base}/notes`, input: { note } };
    const inCloud: Attempt = { label: 'request_note', method: 'POST', path: `${base}/notes`, input: { request_note: note } };
    return cloud ? [inCloud, onprem] : [onprem, inCloud];
  }
  if (kind === 'resolution') {
    const resolution = payload.resolution as Record<string, unknown>;
    const onprem: Attempt = { label: 'resolutions', method: 'POST', path: `${base}/resolutions`, input: { resolution } };
    const inCloud: Attempt = { label: 'request.resolution', method: 'PUT', path: base, input: { request: { resolution } } };
    return cloud ? [inCloud, onprem] : [onprem, inCloud];
  }
  if (kind === 'create') {
    // A new ticket for a leaver's IT clearance: as the requester if
    // ServiceDesk knows them, else as the technician; with its category
    // if the desk has it, else without.
    const request = (payload.request ?? {}) as Record<string, unknown>;
    const { requester, category, ...bare } = request;
    const tries: Attempt[] = [{ label: 'request', method: 'POST', path: '/api/v3/requests', input: { request } }];
    if (category) tries.push({ label: 'request without category', method: 'POST', path: '/api/v3/requests', input: { request: { ...bare, ...(requester ? { requester } : {}) } } });
    if (requester) tries.push({ label: 'request as the technician', method: 'POST', path: '/api/v3/requests', input: { request: bare } });
    return tries;
  }
  if (kind === 'close') {
    const info = ((payload.request as Record<string, unknown> | undefined)?.closure_info ?? {}) as Record<string, unknown>;
    const viaClose: Attempt = { label: 'close', method: 'PUT', path: `${base}/close`, input: { request: { closure_info: info } } };
    const viaStatus: Attempt = {
      label: 'status Closed', method: 'PUT', path: base,
      input: { request: { status: { name: 'Closed' }, closure_info: info } },
    };
    // Closed with its status alone, if the closure details are what is refused.
    const bare: Attempt = { label: 'status Closed only', method: 'PUT', path: base, input: { request: { status: { name: 'Closed' } } } };
    return cloud ? [viaClose, viaStatus, bare] : [viaClose, viaStatus];
  }
  return [];
}

/** After a write: send what it queued for ServiceDesk, if anything is due. */
export async function kickServicedesk(tenantId: string | null | undefined): Promise<void> {
  if (!tenantId) return;
  try {
    const { rows } = await getPool().query(
      `select exists (select 1 from public.servicedesk_events where tenant_id = $1 and direction = 'out'
                       and status = 'queued' and next_attempt_at <= now()) as any`, [tenantId]);
    if (rows[0]?.any) await drainServicedesk({ tenantId });
  } catch (err) {
    console.error('[servicedesk] kick failed', err instanceof Error ? err.message : err);
  }
}
