// =====================================================================
// Running a report.
//
// The SQL is assembled from src/lib/report-catalogue.ts and nothing
// else: column expressions come from the catalogue by key, filter values
// are bound as parameters, and a key the catalogue does not list is an
// error rather than an identifier. It runs inside withContext, over the
// security_invoker views, so a report sees exactly what row-level
// security lets the person running it see.
// =====================================================================

import type pg from 'pg';
import {
  DATASETS, columnsOf, isDataset, type Dataset, type ReportFilters, type ReportResult, type ReportValue,
} from '@/lib/report-catalogue';
import { HttpError } from './tables';

export const REPORT_ROW_LIMIT = 5000;

export type { ReportResult, ReportValue } from '@/lib/report-catalogue';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 120).slice(0, 50) : [];

/** The period as a [from, to) pair of SQL expressions over bound parameters. */
function periodClause(f: ReportFilters, column: string, bind: (v: unknown) => string): string | null {
  const local = `(${column} at time zone 'Asia/Dhaka')`;
  switch (f.period ?? 'all') {
    case 'last_30': return `${column} >= now() - interval '30 days'`;
    case 'last_90': return `${column} >= now() - interval '90 days'`;
    case 'this_month': return `${local} >= date_trunc('month', now() at time zone 'Asia/Dhaka')`;
    case 'last_month':
      return `${local} >= date_trunc('month', now() at time zone 'Asia/Dhaka') - interval '1 month'
              and ${local} < date_trunc('month', now() at time zone 'Asia/Dhaka')`;
    case 'this_year': return `${local} >= date_trunc('year', now() at time zone 'Asia/Dhaka')`;
    case 'custom': {
      const parts: string[] = [];
      if (f.from && DAY.test(f.from)) parts.push(`${local} >= ${bind(f.from)}::date`);
      if (f.to && DAY.test(f.to)) parts.push(`${local} < ${bind(f.to)}::date + 1`);
      return parts.length ? parts.join(' and ') : null;
    }
    default: return null;
  }
}

export function buildReportQuery(
  dataset: Dataset, columnKeys: string[], filters: ReportFilters,
  sort?: { key: string; dir: 'asc' | 'desc' }, tenantId?: string,
) {
  if (!isDataset(dataset)) throw new HttpError(400, 'no such dataset');
  const catalogue = columnsOf(dataset);
  const cols = columnKeys.map((k) => {
    const c = catalogue.find((x) => x.key === k);
    if (!c) throw new HttpError(400, `no column ${k} in ${dataset}`);
    return c;
  });
  if (!cols.length) throw new HttpError(400, 'a report needs at least one column');

  const params: unknown[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  const f = filters ?? {};
  const def = DATASETS[dataset];

  // Without a session (the mailer, the daily round) row-level security
  // has no tenant to apply, so the tenant is named here instead.
  if (tenantId) where.push(`tenant_id = ${bind(tenantId)}::uuid`);

  const period = periodClause(f, def.dateColumn, bind);
  if (period) where.push(period);

  const inList = (column: string, values: string[]) => { if (values.length) where.push(`${column} = any (${bind(values)}::text[])`); };
  inList('status', strings(f.status));
  inList('form', strings(f.form));
  inList(dataset === 'requests' ? 'department' : 'approver_department', strings(f.department));
  inList('priority', strings(f.priority));
  if (dataset === 'requests') inList('category', strings(f.category));
  if (typeof f.overdue === 'boolean') where.push(f.overdue ? 'overdue' : 'not coalesce(overdue, false)');
  if (typeof f.on_time === 'boolean' && dataset === 'steps') where.push(`on_time = ${bind(f.on_time)}`);
  if (typeof f.search === 'string' && f.search.trim()) {
    const like = '%' + f.search.trim().slice(0, 80).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const hay = dataset === 'approvers' ? ['approver'] : ['reference', 'form', 'requester'].concat(dataset === 'steps' ? ['approver'] : []);
    where.push('(' + hay.map((h) => `lower(coalesce(${h}, '')) like ${bind(like)}`).join(' or ') + ')');
  }

  const select = cols.map((c) => `${c.sql} as "${c.key}"`).join(', ');
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  let order = def.defaultSort;
  if (sort) {
    const c = catalogue.find((x) => x.key === sort.key);
    if (c) order = `${dataset === 'approvers' ? `"${c.key}"` : c.sql} ${sort.dir === 'asc' ? 'asc' : 'desc'} nulls last`;
  }

  const text = dataset === 'approvers'
    ? `select ${select} from public.report_steps ${whereSql}
         ${where.length ? 'and' : 'where'} approver_id is not null and status not in ('waiting', 'skipped')
        group by approver_id order by ${order} limit ${REPORT_ROW_LIMIT + 1}`
    : `select ${select} from public.report_${dataset} ${whereSql} order by ${order} limit ${REPORT_ROW_LIMIT + 1}`;
  return { text, params, cols };
}

export async function runReport(
  client: pg.PoolClient, dataset: Dataset, columnKeys: string[], filters: ReportFilters,
  sort?: { key: string; dir: 'asc' | 'desc' }, tenantId?: string,
): Promise<ReportResult> {
  const { text, params, cols } = buildReportQuery(dataset, columnKeys, filters, sort, tenantId);
  const { rows } = await client.query(text, params);
  const truncated = rows.length > REPORT_ROW_LIMIT;
  return {
    columns: cols.map((c) => ({ key: c.key, label: c.label, type: c.type })),
    rows: (truncated ? rows.slice(0, REPORT_ROW_LIMIT) : rows).map((r) => {
      const out: Record<string, ReportValue> = {};
      for (const c of cols) {
        const v = r[c.key];
        // pg returns numeric as a string, to keep its precision; these are
        // counts, days and amounts, which a number holds exactly enough.
        out[c.key] = v instanceof Date ? v.toISOString()
          : typeof v === 'string' && ['money', 'number', 'percent'].includes(c.type) ? Number(v)
          : v === undefined ? null : (v as ReportValue);
      }
      return out;
    }),
    truncated,
  };
}

/** Reading reports in bulk needs reports.view (or reports.manage), whatever row-level security would let through. */
export async function requireReports(client: pg.PoolClient) {
  const { rows } = await client.query(
    `select app.has_permission('reports.view') or app.has_permission('reports.manage') as ok`);
  if (!rows[0]?.ok) throw new HttpError(403, 'Reports need the reports.view permission.');
}
