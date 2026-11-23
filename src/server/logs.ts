// =====================================================================
// The system's own logs: what went wrong in the application, and what
// the scheduler did. Read in the audit centre (public.audit_events).
//
// Written as the owner, outside any request's transaction, so a failure
// that rolled the request back is still recorded — and recording never
// fails the request it describes.
// =====================================================================

import { getPool } from './db';

export async function logAppError(source: string, err: unknown, status = 500, tenantId?: string | null): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await getPool().query(
      'insert into public.app_errors (tenant_id, source, message, status) values ($1, $2, $3, $4)',
      [tenantId ?? null, source.slice(0, 80), message.slice(0, 1000), status]);
  } catch (e) {
    console.error('[logs] could not record an error', e instanceof Error ? e.message : e);
  }
}

/** Run a scheduled job and record it: when, how long, what it did, or why it failed. */
export async function recordRun<T extends Record<string, unknown>>(
  job: string, tenantId: string | null, fn: () => Promise<T>,
): Promise<T> {
  const started = new Date();
  try {
    const result = await fn();
    await getPool().query(
      'insert into public.system_runs (tenant_id, job, started_at, finished_at, result) values ($1, $2, $3, now(), $4)',
      [tenantId, job, started, JSON.stringify(result)]).catch(() => {});
    return result;
  } catch (err) {
    await getPool().query(
      'insert into public.system_runs (tenant_id, job, started_at, finished_at, error) values ($1, $2, $3, now(), $4)',
      [tenantId, job, started, (err instanceof Error ? err.message : String(err)).slice(0, 1000)]).catch(() => {});
    throw err;
  }
}
