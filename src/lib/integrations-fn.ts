// =====================================================================
// Integrations: API keys, webhooks, their deliveries and the API's own
// traffic — and the migration of closed tickets from ManageEngine.
//
// Reading needs integrations.manage or audit.view (row-level security);
// every change goes through a function in db/009_integration.sql that
// checks integrations.manage (records.manage for the migration).
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { withContext, resolveContext } from '@/server/db';
import { hashSecret } from '@/server/api';
import { drainWebhooks } from '@/server/webhooks';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function refusal(err: unknown): { ok: false; error: string } {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.' };
  if (e?.code === '28000') return { ok: false, error: 'Sign in again.' };
  console.error('[integrations]', e?.message || err);
  return { ok: false, error: 'That did not work. Try again.' };
}

async function run<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withContext(await resolveContext(), fn);
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function token(n: number): string {
  const bytes = randomBytes(n);
  let s = '';
  for (const b of bytes) s += BASE62[b % 62];
  return s;
}

export type ApiKeyRow = {
  id: string; name: string; prefix: string; scopes: string[]; created_by: string | null; created_by_name: string | null;
  created_at: string; last_used_at: string | null; revoked_at: string | null; calls_30d: number; errors_30d: number;
};
export type WebhookRow = {
  id: string; name: string; url: string; events: string[]; active: boolean; created_at: string;
  delivered_30d: number; failed_30d: number; last_delivery_at: string | null; last_status: string | null;
};
export type DeliveryRow = {
  id: string; webhook_id: string; webhook: string; event: string; status: string; attempts: number;
  response_status: number | null; response_ms: number | null; response_body: string | null; error: string | null;
  created_at: string; delivered_at: string | null; next_attempt_at: string | null;
};
export type ApiDay = { day: string; ok: number; failed: number };
export type ApiCall = { id: string; key: string | null; method: string; path: string; status: number; ms: number | null; ip: string | null; error: string | null; created_at: string };

export const loadIntegrations = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{
    keys: ApiKeyRow[]; webhooks: WebhookRow[]; canManage: boolean; days: ApiDay[]; calls: ApiCall[];
    totals: { calls: number; failed: number; p50: number | null; p95: number | null };
  }>> => {
    try {
      return await run(async (c) => {
        const { rows: keys } = await c.query(
          `select k.id, k.name, k.prefix, k.scopes, k.created_by, e.name as created_by_name, k.created_at, k.last_used_at, k.revoked_at,
                  (select count(*)::int from public.api_requests r where r.key_id = k.id and r.created_at > now() - interval '30 days') as calls_30d,
                  (select count(*)::int from public.api_requests r where r.key_id = k.id and r.status >= 400 and r.created_at > now() - interval '30 days') as errors_30d
             from public.api_keys k
             left join public.employees e on e.employee_id = k.created_by and e.tenant_id = k.tenant_id
            order by k.revoked_at nulls first, k.created_at desc`);
        const { rows: hooks } = await c.query(
          `select w.id, w.name, w.url, w.events, w.active, w.created_at,
                  count(d.*) filter (where d.status = 'delivered' and d.created_at > now() - interval '30 days')::int as delivered_30d,
                  count(d.*) filter (where d.status = 'failed' and d.created_at > now() - interval '30 days')::int as failed_30d,
                  max(d.created_at) as last_delivery_at,
                  (select x.status from public.webhook_deliveries x where x.webhook_id = w.id order by x.created_at desc limit 1) as last_status
             from public.webhooks w left join public.webhook_deliveries d on d.webhook_id = w.id
            group by w.id order by w.created_at`);
        // Complete days only, Dhaka time, the last thirty.
        const { rows: days } = await c.query(
          `with d as (select generate_series(((now() at time zone 'Asia/Dhaka')::date - 30), ((now() at time zone 'Asia/Dhaka')::date - 1), interval '1 day')::date as day)
           select to_char(d.day, 'YYYY-MM-DD') as day,
                  count(r.*) filter (where r.status < 400)::int as ok,
                  count(r.*) filter (where r.status >= 400)::int as failed
             from d left join public.api_requests r on (r.created_at at time zone 'Asia/Dhaka')::date = d.day
            group by d.day order by d.day`);
        const { rows: calls } = await c.query(
          `select r.id, k.name as key, r.method, r.path, r.status, r.ms, r.ip, r.error, r.created_at
             from public.api_requests r left join public.api_keys k on k.id = r.key_id
            order by r.created_at desc limit 100`);
        const { rows: [t] } = await c.query(
          `select count(*)::int as calls, count(*) filter (where status >= 400)::int as failed,
                  percentile_cont(0.5) within group (order by ms)::int as p50,
                  percentile_cont(0.95) within group (order by ms)::int as p95
             from public.api_requests where created_at > now() - interval '30 days'`);
        const { rows: [m] } = await c.query(`select app.has_permission('integrations.manage') as ok`);
        return {
          ok: true as const,
          keys: keys.map((k) => ({ ...k, created_at: iso(k.created_at)!, last_used_at: iso(k.last_used_at), revoked_at: iso(k.revoked_at) })),
          webhooks: hooks.map((w) => ({ ...w, created_at: iso(w.created_at)!, last_delivery_at: iso(w.last_delivery_at) })),
          canManage: m.ok === true,
          days,
          calls: calls.map((r) => ({ ...r, created_at: iso(r.created_at)! })),
          totals: t,
        };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export const createApiKey = createServerFn({ method: 'POST' })
  .inputValidator((input: { name: string; scopes: string[] }) => input)
  .handler(async ({ data }): Promise<Result<{ id: string; key: string }>> => {
    try {
      const prefix = token(8).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 8).padEnd(8, '0');
      const secret = token(40);
      const id = await run(async (c) => (await c.query(
        'select public.create_api_key($1, $2::text[], $3, $4) as id',
        [String(data.name ?? ''), Array.isArray(data.scopes) ? data.scopes.map(String) : [], prefix, hashSecret(secret)])).rows[0].id);
      return { ok: true, id, key: `ams_${prefix}_${secret}` };
    } catch (err) {
      return refusal(err);
    }
  });

export const revokeApiKey = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.revoke_api_key($1)', [data.id]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const saveWebhook = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string | null; name: string; url: string; events: string[]; active: boolean; rotate?: boolean }) => input)
  .handler(async ({ data }): Promise<Result<{ id: string; secret: string | null }>> => {
    try {
      const secret = !data.id || data.rotate ? 'whsec_' + token(32) : null;
      const id = await run(async (c) => (await c.query(
        'select public.save_webhook($1, $2, $3, $4::text[], $5, $6) as id',
        [data.id ?? null, String(data.name ?? ''), String(data.url ?? ''), Array.isArray(data.events) ? data.events.map(String) : [],
         data.active !== false, secret])).rows[0].id);
      return { ok: true, id, secret };
    } catch (err) {
      return refusal(err);
    }
  });

export const deleteWebhook = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.delete_webhook($1)', [data.id]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

/** The signing secret, for somebody who administers integrations. */
export const revealWebhookSecret = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result<{ secret: string }>> => {
    try {
      return await run(async (c) => {
        const { rows: [m] } = await c.query(`select app.has_permission('integrations.manage') as ok`);
        if (!m.ok) throw Object.assign(new Error('you need the integrations.manage permission for that'), { code: 'P0001' });
        // Read as the owner would: the policy lets the secret's row be
        // seen, and this function is the only place that reads the column.
        const { rows: [w] } = await c.query('select secret from public.webhooks where id = $1', [data.id]);
        if (!w) throw Object.assign(new Error('no such webhook'), { code: 'P0001' });
        await c.query(`select app.audit('webhook_secret_viewed', 'webhook', $1, null)`, [data.id]);
        return { ok: true as const, secret: w.secret };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export const sendTestWebhook = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result<{ delivery: DeliveryRow | null }>> => {
    try {
      const ctx = await resolveContext();
      const id = await withContext(ctx, async (c) => (await c.query('select public.test_webhook($1) as id', [data.id])).rows[0].id);
      await drainWebhooks({ tenantId: ctx.tenantId, only: id, limit: 1 });
      const delivery = await withContext(ctx, (c) => oneDelivery(c, id));
      return { ok: true, delivery };
    } catch (err) {
      return refusal(err);
    }
  });

export const redeliverWebhook = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result<{ delivery: DeliveryRow | null }>> => {
    try {
      const ctx = await resolveContext();
      await withContext(ctx, (c) => c.query('select public.redeliver_webhook($1)', [data.id]));
      await drainWebhooks({ tenantId: ctx.tenantId, only: data.id, limit: 1 });
      return { ok: true, delivery: await withContext(ctx, (c) => oneDelivery(c, data.id)) };
    } catch (err) {
      return refusal(err);
    }
  });

const DELIVERY_COLUMNS = `d.id, d.webhook_id, w.name as webhook, d.event, d.status, d.attempts, d.response_status, d.response_ms,
  d.response_body, d.error, d.created_at, d.delivered_at, case when d.status = 'queued' then d.next_attempt_at end as next_attempt_at`;
const deliveryOut = (r: Record<string, unknown>) => ({
  ...r, created_at: iso(r.created_at)!, delivered_at: iso(r.delivered_at), next_attempt_at: iso(r.next_attempt_at),
}) as DeliveryRow;

async function oneDelivery(c: pg.PoolClient, id: string): Promise<DeliveryRow | null> {
  const { rows: [r] } = await c.query(
    `select ${DELIVERY_COLUMNS} from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id where d.id = $1`, [id]);
  return r ? deliveryOut(r) : null;
}

export const listDeliveries = createServerFn({ method: 'POST' })
  .inputValidator((input: { webhook?: string; status?: string; event?: string }) => input ?? {})
  .handler(async ({ data }): Promise<Result<{ deliveries: DeliveryRow[]; counts: Record<string, number> }>> => {
    try {
      return await run(async (c) => {
        const { rows } = await c.query(
          `select ${DELIVERY_COLUMNS} from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id
            where ($1::uuid is null or d.webhook_id = $1) and ($2::text is null or d.status = $2) and ($3::text is null or d.event = $3)
            order by d.created_at desc limit 200`, [data.webhook || null, data.status || null, data.event || null]);
        const { rows: counts } = await c.query(
          `select status, count(*)::int n from public.webhook_deliveries where created_at > now() - interval '30 days' group by status`);
        return { ok: true as const, deliveries: rows.map(deliveryOut), counts: Object.fromEntries(counts.map((r) => [r.status, r.n])) };
      });
    } catch (err) {
      return refusal(err);
    }
  });

/** What was sent, exactly — the body a receiver verified. */
export const getDeliveryPayload = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result<{ payload: string }>> => {
    try {
      return await run(async (c) => {
        const { rows: [d] } = await c.query('select id, payload from public.webhook_deliveries where id = $1', [data.id]);
        if (!d) throw Object.assign(new Error('no such delivery'), { code: 'P0001' });
        return { ok: true as const, payload: JSON.stringify({ id: d.id, ...d.payload }, null, 2) };
      });
    } catch (err) {
      return refusal(err);
    }
  });

// ---------------------------------------------------------------------
// Migration from ManageEngine.
// ---------------------------------------------------------------------
export type LegacyRow = {
  ref: string; subject: string; description?: string; category?: string; requester?: string; technician?: string;
  status?: string; priority?: string; created?: string; closed?: string; resolution?: string;
};
export type LegacyImportResult = {
  imported: number; duplicates: number; open: number; invalid: number; unmatched_requesters: number;
  errors: { row: number; ref?: string; error: string }[];
};

export const importLegacyTickets = createServerFn({ method: 'POST' })
  .inputValidator((input: { source: string; rows: LegacyRow[] }) => input)
  .handler(async ({ data }): Promise<Result<{ result: LegacyImportResult }>> => {
    try {
      if (!Array.isArray(data.rows)) throw Object.assign(new Error('expected a list of tickets'), { code: 'P0001' });
      const result = await run(async (c) => (await c.query(
        'select public.import_legacy_tickets($1, $2::jsonb) as r', [data.source || 'ManageEngine', JSON.stringify(data.rows)])).rows[0].r);
      return { ok: true, result };
    } catch (err) {
      return refusal(err);
    }
  });

/** An export to try the import with: what ManageEngine's "Export as CSV" gives, with fresh references. */
export const sampleLegacyExport = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ rows: LegacyRow[] }>> => {
    try {
      return await run(async (c) => {
        const { rows: [r] } = await c.query('select app.sample_legacy_tickets(24) as r');
        const stamp = Date.now().toString(36).slice(-4).toUpperCase();
        return { ok: true as const, rows: (r.r as LegacyRow[]).map((x, i) => ({ ...x, ref: `${stamp}-${String(i + 1).padStart(3, '0')}` })) };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export const legacySummary = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ sources: { source: string; n: number; first: string | null; last: string | null }[]; canManage: boolean }>> => {
    try {
      return await run(async (c) => {
        const { rows } = await c.query(
          `select legacy_source as source, count(*)::int n, min(submitted_at) as first, max(closed_at) as last
             from public.form_submissions where legacy_ref is not null group by 1 order by 1`);
        const { rows: [m] } = await c.query(`select app.has_permission('records.manage') as ok`);
        return { ok: true as const, sources: rows.map((r) => ({ ...r, first: iso(r.first), last: iso(r.last) })), canManage: m.ok === true };
      });
    } catch (err) {
      return refusal(err);
    }
  });
