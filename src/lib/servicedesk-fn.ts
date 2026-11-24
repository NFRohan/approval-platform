// =====================================================================
// The ServiceDesk Plus link, for the Integrations screen: its settings,
// a connection test, fetching new tickets now, a ticket typed in by hand
// to try it, and every exchange both ways.
//
// Reading needs integrations.manage or audit.view; changing anything
// needs integrations.manage, checked in the database. The technician key
// is sealed before it is stored and never sent back to the browser.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { withContext, resolveContext } from '@/server/db';
import { sealSecret } from '@/server/totp';
import { appUrl, kickMailer } from '@/server/mailer';
import { drainServicedesk, normaliseTicket, pollServicedesk, sdpCall, sdpOk, zohoToken, type Link } from '@/server/servicedesk';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function refusal(err: unknown): { ok: false; error: string } {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.' };
  if (e?.code === '28000') return { ok: false, error: 'Sign in again.' };
  console.error('[servicedesk]', e?.message || err);
  return { ok: false, error: 'That did not work. Try again.' };
}

async function run<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withContext(await resolveContext(), fn);
}

async function needManage(c: pg.PoolClient) {
  const { rows: [m] } = await c.query(`select app.has_permission('integrations.manage') as ok`);
  if (!m.ok) throw Object.assign(new Error('you need the integrations.manage permission for that'), { code: 'P0001' });
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export type FormMapRow = { match: string; form: string };
export type ServicedeskSettings = {
  enabled: boolean; base_url: string | null; has_token: boolean; allow_self_signed: boolean;
  default_form: string | null; form_map: FormMapRow[]; approved_closure: string; rejected_closure: string;
  inbound_url: string; inbound_secret: string | null; last_poll_at: string | null;
  auth_mode: 'authtoken' | 'oauth'; oauth_accounts_url: string | null; oauth_client_id: string | null;
  oauth_signed_in: boolean; oauth_access_expires: string | null;
  last_poll_result: { seen: number; raised: number; ignored: number; refused: number; error?: string } | null;
  // A leaver's IT clearance, raised as a ticket there and cleared from it.
  clearance_enabled: boolean; clearance_form: string | null; clearance_track: string | null; clearance_category: string | null;
};
export type ClearanceTask = {
  id: string; submission_id: string; reference: string | null; leaver: string | null; ticket_id: string | null;
  status: 'opening' | 'open' | 'cleared' | 'failed'; ticket_status: string | null; created_at: string; cleared_at: string | null;
};
export type ServicedeskEvent = {
  id: string; direction: 'in' | 'out'; kind: string; ticket_id: string | null; submission_id: string | null; reference: string | null;
  status: string; attempts: number; http_status: number | null; error: string | null; payload: string; response: string | null;
  created_at: string; done_at: string | null;
};

export const loadServicedesk = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ settings: ServicedeskSettings; events: ServicedeskEvent[]; tasks: ClearanceTask[]; forms: string[]; canManage: boolean; slug: string }>> => {
    try {
      return await run(async (c) => {
        await c.query('select app.seed_servicedesk(app.current_tenant())').catch(() => {});
        const { rows: [l] } = await c.query(`select * from public.servicedesk_links where tenant_id = app.current_tenant()`);
        const { rows: [t] } = await c.query(`select slug from public.tenants where id = app.current_tenant()`);
        const { rows: [m] } = await c.query(`select app.has_permission('integrations.manage') as ok`);
        const { rows: forms } = await c.query(`select name from public.form_templates where status = 'published' order by name`);
        const { rows: ev } = await c.query(
          `select e.id, e.direction, e.kind, e.ticket_id, e.submission_id, s.ref_number as reference, e.status, e.attempts,
                  e.http_status, e.error, e.payload::text as payload, e.response, e.created_at, e.done_at
             from public.servicedesk_events e left join public.form_submissions s on s.id = e.submission_id
            order by e.seq desc limit 150`);
        const { rows: tasks } = await c.query(
          `select k.id, k.submission_id, s.ref_number as reference, e.name as leaver, k.ticket_id, k.status, k.ticket_status,
                  k.created_at, k.cleared_at
             from public.servicedesk_tasks k
             left join public.form_submissions s on s.id = k.submission_id
             left join public.employees e on e.tenant_id = s.tenant_id and e.employee_id = s.submitted_by
            order by k.created_at desc limit 50`);
        if (!l) throw Object.assign(new Error('the ServiceDesk link is not readable with your permissions'), { code: 'P0001' });
        return {
          ok: true as const,
          slug: t.slug,
          canManage: m.ok === true,
          forms: forms.map((f) => f.name),
          settings: {
            enabled: l.enabled, base_url: l.base_url, has_token: !!l.token_sealed, allow_self_signed: l.allow_self_signed,
            default_form: l.default_form, form_map: l.form_map, approved_closure: l.approved_closure, rejected_closure: l.rejected_closure,
            inbound_url: `${appUrl()}/integrations/servicedesk/${t.slug}`,
            // The secret is the caller's to give ServiceDesk: shown to whoever may change the link.
            inbound_secret: m.ok ? l.inbound_secret : null,
            last_poll_at: iso(l.last_poll_at), last_poll_result: l.last_poll_result,
            auth_mode: l.auth_mode, oauth_accounts_url: l.oauth_accounts_url, oauth_client_id: l.oauth_client_id,
            oauth_signed_in: !!l.oauth_refresh_sealed, oauth_access_expires: iso(l.oauth_access_expires),
            clearance_enabled: !!l.clearance_enabled, clearance_form: l.clearance_form, clearance_track: l.clearance_track,
            clearance_category: l.clearance_category,
          },
          tasks: tasks.map((k) => ({ ...k, created_at: iso(k.created_at)!, cleared_at: iso(k.cleared_at) })) as ClearanceTask[],
          events: ev.map((e) => ({ ...e, created_at: iso(e.created_at)!, done_at: iso(e.done_at) })) as ServicedeskEvent[],
        };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export const saveServicedesk = createServerFn({ method: 'POST' })
  .inputValidator((input: {
    enabled: boolean; base_url: string; token?: string | null; allow_self_signed: boolean; default_form: string | null;
    form_map: FormMapRow[]; approved_closure: string; rejected_closure: string; rotate_secret?: boolean;
  }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      const token = typeof data.token === 'string' && data.token.trim() ? sealSecret(data.token.trim()) : null;
      const secret = data.rotate_secret ? randomBytes(24).toString('hex') : null;
      await run((c) => c.query('select public.save_servicedesk($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)', [
        !!data.enabled, data.base_url ?? '', token, !!data.allow_self_signed, data.default_form ?? null,
        JSON.stringify((data.form_map ?? []).filter((r) => r.match?.trim() || r.form)), data.approved_closure ?? '', data.rejected_closure ?? '', secret,
      ]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

/** A leaver's IT clearance through ServiceDesk: on or off, for which form and track. */
export const saveServicedeskClearance = createServerFn({ method: 'POST' })
  .inputValidator((input: { enabled: boolean; form: string | null; track: string | null; category: string | null }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.save_servicedesk_clearance($1, $2, $3, $4)',
        [!!data.enabled, data.form ?? null, data.track ?? null, data.category ?? null]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

/** Can we reach ServiceDesk with this address and key? Asks for one ticket. */
export const testServicedesk = createServerFn({ method: 'POST' })
  .inputValidator((input: { base_url: string; token?: string | null; allow_self_signed: boolean }) => input)
  .handler(async ({ data }): Promise<Result<{ connected: boolean; message: string; ms: number | null; tickets: number | null }>> => {
    try {
      const link = await run(async (c) => {
        await needManage(c);
        return (await c.query<Link>(`select * from public.servicedesk_links where tenant_id = app.current_tenant()`)).rows[0];
      });
      const typedKey = !!data.token?.trim();
      const trial = {
        ...link,
        base_url: (data.base_url ?? '').trim().replace(/\/$/, '') || link?.base_url || null,
        token_sealed: typedKey ? sealSecret(data.token!.trim()) : link?.token_sealed ?? null,
        allow_self_signed: !!data.allow_self_signed,
        // A key typed in is tried as a key; otherwise the link signs in as it is set to.
        auth_mode: typedKey ? 'authtoken' as const : link?.auth_mode ?? 'authtoken',
      };
      try {
        const r = await sdpCall(trial, 'GET', '/api/v3/requests', { list_info: { row_count: 1, start_index: 1, get_total_count: true } });
        const ok = sdpOk(r);
        const total = Number((r.json?.list_info as { total_count?: unknown } | undefined)?.total_count);
        return { ok: true, connected: ok.ok, message: ok.ok ? 'Connected.' : ok.message, ms: r.ms, tickets: Number.isFinite(total) ? total : null };
      } catch (err) {
        return { ok: true, connected: false, message: err instanceof Error ? err.message : String(err), ms: null, tickets: null };
      }
    } catch (err) {
      return refusal(err);
    }
  });

export const fetchServicedeskNow = createServerFn({ method: 'POST' })
  .handler(async (): Promise<Result<{ seen: number; raised: number; ignored: number; refused: number; error?: string }>> => {
    try {
      const ctx = await resolveContext();
      await withContext(ctx, needManage);
      const r = await pollServicedesk(ctx.tenantId!);
      await kickMailer(ctx.tenantId);
      return { ok: true, ...r };
    } catch (err) {
      return refusal(err);
    }
  });

/** A ticket typed in, as ServiceDesk would send it. */
export const simulateServicedeskTicket = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string; subject: string; description: string; requester_email: string; category: string; priority: string }) => input)
  .handler(async ({ data }): Promise<Result<{ outcome: string; reference?: string; submission_id?: string; reason?: string }>> => {
    try {
      const ctx = await resolveContext();
      const t = normaliseTicket({
        id: data.id, subject: data.subject, description: data.description, requester: { email_id: data.requester_email },
        category: { name: data.category }, priority: { name: data.priority },
      });
      if (!t) throw Object.assign(new Error('a ticket needs an id of letters and digits'), { code: 'P0001' });
      const r = await withContext(ctx, async (c) => (await c.query('select public.receive_servicedesk_ticket($1::jsonb) as r', [JSON.stringify(t)])).rows[0].r);
      await kickMailer(ctx.tenantId);
      return { ok: true, ...r };
    } catch (err) {
      return refusal(err);
    }
  });

export const retryServicedeskEvent = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result<{ status: string; error: string | null }>> => {
    try {
      const ctx = await resolveContext();
      await withContext(ctx, (c) => c.query('select public.retry_servicedesk_event($1)', [data.id]));
      await drainServicedesk({ tenantId: ctx.tenantId, only: data.id });
      const { rows: [e] } = await withContext(ctx, (c) => c.query('select status, error from public.servicedesk_events where id = $1', [data.id]));
      return { ok: true, status: e.status, error: e.error };
    } catch (err) {
      return refusal(err);
    }
  });

/**
 * ServiceDesk Plus Cloud: swap the code a Zoho Self Client generated for
 * a refresh token, and keep it — with the client secret — sealed. The
 * code lasts minutes and works once.
 */
export const connectServicedeskCloud = createServerFn({ method: 'POST' })
  .inputValidator((input: { accounts_url: string; client_id: string; client_secret: string; code: string }) => input)
  .handler(async ({ data }): Promise<Result<{ expires_in: number | null }>> => {
    try {
      const ctx = await resolveContext();
      await withContext(ctx, needManage);
      const accounts = String(data.accounts_url ?? '').trim().replace(/\/$/, '');
      const clientId = String(data.client_id ?? '').trim();
      const secret = String(data.client_secret ?? '').trim();
      const code = String(data.code ?? '').trim();
      if (!clientId || !secret || !code) throw Object.assign(new Error('the client id, client secret and a freshly generated code are all needed'), { code: 'P0001' });
      let t;
      try {
        t = await zohoToken(accounts, { grant_type: 'authorization_code', client_id: clientId, client_secret: secret, code }, true);
      } catch (err) {
        throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { code: 'P0001' });
      }
      if (!t.refresh_token) {
        const why = t.error === 'invalid_code' ? 'the code has expired or was used already — generate a new one'
          : t.error === 'invalid_client' ? 'Zoho does not know that client id here — check the data centre'
          : t.error === 'invalid_client_secret' ? 'the client secret is not right'
          : t.error ?? 'Zoho gave no refresh token';
        throw Object.assign(new Error(why), { code: 'P0001' });
      }
      await withContext(ctx, (c) => c.query('select public.save_servicedesk_oauth($1, $2, $3, $4)',
        [accounts, clientId, sealSecret(secret), sealSecret(t.refresh_token!)]));
      return { ok: true, expires_in: t.expires_in ?? null };
    } catch (err) {
      return refusal(err);
    }
  });
