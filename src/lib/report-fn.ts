// =====================================================================
// Reports: templates, running them, and sending them.
//
// The data behind a report is readable by any member row by row — the
// status pages need it — so reading it in bulk is gated here, in the
// database, on reports.view. Templates are changed through the
// functions in db/007_reports.sql, which check reports.manage and the
// maker-checker on column changes.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import type pg from 'pg';
import { withContext, resolveContext } from '@/server/db';
import { runReport, requireReports, type ReportResult } from '@/server/reports';
import { kickMailer } from '@/server/mailer';
import { HttpError } from '@/server/tables';
import { columnsOf, isDataset, type Dataset, type ReportFilters } from '@/lib/report-catalogue';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function refusal(err: unknown): { ok: false; error: string } {
  const e = err as { code?: string; message?: string; status?: number };
  if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message };
  if (e?.code === '23505') return { ok: false, error: 'A report with that name already exists.' };
  if (e?.status && e.message) return { ok: false, error: e.message };
  console.error('[reports]', e?.message || err);
  return { ok: false, error: 'That did not work. Try again.' };
}

async function run<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const ctx = await resolveContext();
  return withContext(ctx, fn);
}


export type ReportTemplate = {
  id: string; name: string; description: string | null; dataset: Dataset; columns: string[]; filters: ReportFilters;
  standard: boolean; pending_columns: string[] | null; change_note: string | null; change_requested_by: string | null;
  change_requested_by_name: string | null; schedule: 'none' | 'weekly' | 'monthly'; recipients: string[];
  format: 'xlsx' | 'pdf' | 'csv'; last_sent_at: string | null; updated_at: string;
};

const TEMPLATE_SQL = `
  select rt.id, rt.name, rt.description, rt.dataset, rt.columns, rt.filters, rt.standard, rt.pending_columns,
         rt.change_note, rt.change_requested_by, e.name as change_requested_by_name, rt.schedule, rt.recipients,
         rt.format, rt.last_sent_at, rt.updated_at
    from public.report_templates rt
    left join public.employees e on e.employee_id = rt.change_requested_by and e.tenant_id = rt.tenant_id`;

const shape = (r: Record<string, unknown>) => ({
  ...r,
  last_sent_at: r.last_sent_at ? new Date(r.last_sent_at as string).toISOString() : null,
  updated_at: new Date(r.updated_at as string).toISOString(),
}) as ReportTemplate;

export const listReports = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ reports: ReportTemplate[] }>> => {
    try {
      const rows = await run(async (c) => {
        await requireReports(c);
        return (await c.query(`${TEMPLATE_SQL} order by rt.standard desc, rt.name`)).rows;
      });
      return { ok: true, reports: rows.map(shape) };
    } catch (err) {
      return refusal(err);
    }
  });

export const getReport = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result<{ report: ReportTemplate }>> => {
    try {
      const row = await run(async (c) => {
        await requireReports(c);
        return (await c.query(`${TEMPLATE_SQL} where rt.id = $1`, [data.id])).rows[0];
      });
      if (!row) return { ok: false, error: 'There is no such report.' };
      return { ok: true, report: shape(row) };
    } catch (err) {
      return refusal(err);
    }
  });

function cleanColumns(dataset: string, columns: unknown): string[] {
  if (!isDataset(dataset)) throw new HttpError(400, 'no such dataset');
  const known = new Set(columnsOf(dataset).map((c) => c.key));
  const cols = Array.isArray(columns) ? columns.filter((c): c is string => typeof c === 'string' && known.has(c)) : [];
  if (!cols.length) throw new HttpError(400, 'Choose at least one column.');
  return [...new Set(cols)];
}

export const runReportFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { dataset: Dataset; columns: string[]; filters: ReportFilters; sort?: { key: string; dir: 'asc' | 'desc' } }) => input)
  .handler(async ({ data }): Promise<Result<{ result: ReportResult }>> => {
    try {
      const columns = cleanColumns(data.dataset, data.columns);
      const result = await run(async (c) => {
        await requireReports(c);
        return runReport(c, data.dataset, columns, data.filters ?? {}, data.sort);
      });
      return { ok: true, result };
    } catch (err) {
      return refusal(err);
    }
  });

export type FilterOptions = { forms: string[]; departments: string[]; categories: string[]; people: { id: string; name: string; designation: string | null }[] };

export const reportFilterOptions = createServerFn({ method: 'GET' })
  .handler(async (): Promise<FilterOptions> => {
    return run(async (c) => {
      // One connection answers one query at a time.
      const forms = await c.query(`select distinct name from public.form_templates where status = 'published' order by 1`);
      const depts = await c.query(`select distinct department from public.employees where department is not null order by 1`);
      const cats = await c.query(`select distinct category from public.form_templates where category is not null order by 1`);
      const people = await c.query(`select employee_id as id, name, designation from public.employees where active order by name`);
      return {
        forms: forms.rows.map((r) => r.name),
        departments: depts.rows.map((r) => r.department),
        categories: cats.rows.map((r) => r.category),
        people: people.rows,
      };
    });
  });

export const saveReport = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string | null; name: string; description: string; dataset: Dataset; columns: string[]; filters: ReportFilters }) => input)
  .handler(async ({ data }): Promise<Result<{ id: string }>> => {
    try {
      const columns = cleanColumns(data.dataset, data.columns);
      const id = await run(async (c) => (await c.query('select public.save_report($1, $2, $3, $4, $5, $6) as id',
        [data.id, data.name, data.description, data.dataset, columns, JSON.stringify(data.filters ?? {})])).rows[0].id as string);
      return { ok: true, id };
    } catch (err) {
      return refusal(err);
    }
  });

export const deleteReport = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.delete_report($1)', [data.id]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const requestReportChange = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string; dataset: Dataset; columns: string[]; note: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      const columns = cleanColumns(data.dataset, data.columns);
      await run((c) => c.query('select public.request_report_change($1, $2, $3)', [data.id, columns, data.note ?? null]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const decideReportChange = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string; approve: boolean }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.decide_report_change($1, $2)', [data.id, data.approve === true]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const setReportSchedule = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string; schedule: 'none' | 'weekly' | 'monthly'; recipients: string[]; format: 'xlsx' | 'pdf' | 'csv' }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      if (!['none', 'weekly', 'monthly'].includes(data.schedule) || !['xlsx', 'pdf', 'csv'].includes(data.format)) {
        return { ok: false, error: 'That schedule is not one of the choices.' };
      }
      await run((c) => c.query('select public.set_report_schedule($1, $2, $3, $4)', [data.id, data.schedule, data.recipients ?? [], data.format]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

/** Email the report to these people now; it goes out with the file attached. */
export const emailReport = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string; recipients: string[] }) => input)
  .handler(async ({ data }): Promise<Result<{ queued: number }>> => {
    try {
      const ctx = await resolveContext();
      const queued = await withContext(ctx, async (c) =>
        (await c.query('select public.queue_report_email($1, $2) as n', [data.id, data.recipients ?? []])).rows[0].n as number);
      await kickMailer(ctx.tenantId);
      return { ok: true, queued };
    } catch (err) {
      return refusal(err);
    }
  });
