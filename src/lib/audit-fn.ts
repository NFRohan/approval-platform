// =====================================================================
// The audit centre: one trail over user, application, system and
// database activity (public.audit_events), the monitoring drawn from it
// (public.audit_summary), and retention — what is archived, what is
// purged and when (public.retention_preview and friends).
//
// Reading needs audit.view; retention settings, running it and bringing
// a record back from the archive need records.manage. Both are checked
// in the database.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import type pg from 'pg';
import { withContext, resolveContext } from '@/server/db';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function refusal(err: unknown): { ok: false; error: string } {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.' };
  console.error('[audit]', e?.message || err);
  return { ok: false, error: 'That did not work. Try again.' };
}

async function run<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withContext(await resolveContext(), fn);
}

export type AuditCategory = 'user' | 'application' | 'system' | 'database';
export type AuditRow = {
  at: string; category: AuditCategory; severity: 'info' | 'warning' | 'critical'; source: string; action: string;
  actor_id: string | null; actor: string | null; subject: string | null; subject_id: string | null; detail: string | null;
};
export type AuditQuery = { from?: string | null; to?: string | null; categories?: string[]; severity?: string | null; search?: string | null; limit?: number };

export function auditArgs(q: AuditQuery, limit: number) {
  return [q.from || null, q.to || null, q.categories?.length ? q.categories : null, q.severity || null, q.search || null, limit];
}

export const listAudit = createServerFn({ method: 'POST' })
  .inputValidator((input: AuditQuery) => input ?? {})
  .handler(async ({ data }): Promise<Result<{ rows: AuditRow[]; limited: boolean }>> => {
    try {
      return await run(async (c) => {
        const limit = Math.min(Math.max(Number(data.limit) || 400, 1), 2000);
        const { rows } = await c.query('select * from public.audit_events($1, $2, $3::text[], $4, $5, $6)', auditArgs(data, limit + 1));
        return {
          ok: true as const,
          rows: rows.slice(0, limit).map((r) => ({ ...r, at: new Date(r.at).toISOString() })) as AuditRow[],
          limited: rows.length > limit,
        };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export type AuditSummary = {
  from: string; total: number;
  by_category: Partial<Record<AuditCategory, number>>;
  by_severity: Partial<Record<'info' | 'warning' | 'critical', number>>;
  daily: { day: string; user: number; application: number; system: number; database: number }[];
  security: { day: string; failed_sign_ins: number; refused_api: number; locked: number }[];
  after_hours: { total: number; after: number };
  after_hours_people: { actor_id: string; actor: string | null; n: number }[];
  top_actors: { actor_id: string; actor: string | null; n: number }[];
  by_hour: { hour: number; n: number }[];
};

export const auditSummary = createServerFn({ method: 'GET' })
  .inputValidator((input: { days: number }) => input)
  .handler(async ({ data }): Promise<Result<{ summary: AuditSummary }>> => {
    try {
      return await run(async (c) => {
        const { rows: [r] } = await c.query('select public.audit_summary($1) as s', [Number(data.days) || 30]);
        return { ok: true as const, summary: r.s as AuditSummary };
      });
    } catch (err) {
      return refusal(err);
    }
  });

export type Retention = {
  settings: { retention_years: number; archive_after_months: number; purge_logs_after_months: number };
  archive: number; archived: number; past_retention: number; oldest_archived: string | null;
  logs: Record<'email' | 'api' | 'webhooks' | 'inbound' | 'errors' | 'scheduler', number>;
  by_year: { year: number; archived: number; active: number }[];
  last_run: string | null;
  last_result: { archived: number; purged: number } | null;
  can_manage: boolean;
};

export const retentionPreview = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ retention: Retention }>> => {
    try {
      return await run(async (c) => ({ ok: true as const, retention: (await c.query('select public.retention_preview() as r')).rows[0].r as Retention }));
    } catch (err) {
      return refusal(err);
    }
  });

export const saveRetention = createServerFn({ method: 'POST' })
  .inputValidator((input: { years: number; archiveMonths: number; purgeMonths: number }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.set_retention($1, $2, $3)',
        [Math.round(Number(data.years)), Math.round(Number(data.archiveMonths)), Math.round(Number(data.purgeMonths))]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const runRetentionNow = createServerFn({ method: 'POST' })
  .handler(async (): Promise<Result<{ archived: number; purged: number }>> => {
    try {
      const r = await run(async (c) => (await c.query('select public.run_retention_now() as r')).rows[0].r);
      return { ok: true, archived: r.archived, purged: r.purged };
    } catch (err) {
      return refusal(err);
    }
  });

export const unarchiveSubmission = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.unarchive_submission($1)', [data.id]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });
