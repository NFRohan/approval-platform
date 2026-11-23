// =====================================================================
// Analytics: the organisation at a glance.
//
// "KPI and analytics dashboard (approval time, SLA breach trends,
// executive export)" and "track approvals for admin / super admin /
// team". One call returns everything the dashboard draws, computed in
// the database over the same views the reports use, for a window of
// time and optionally one department (the requester's) or one form.
// Needs reports.view.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { withContext, resolveContext } from '@/server/db';
import { requireReports } from '@/server/reports';

export type AnalyticsInput = { days: 30 | 90 | 180 | 365; department?: string | null; form?: string | null };

export type Analytics = {
  window: { days: number; from: string };
  kpis: {
    raised: number; raisedPrev: number;
    completed: number; completedPrev: number;
    rejected: number; open: number;
    avgCycle: number | null; avgCyclePrev: number | null; medianCycle: number | null;
    onTimePct: number | null; onTimePctPrev: number | null;
    overdueNow: number; pendingNow: number;
  };
  weekly: { week: string; raised: number; completed: number; rejected: number }[];
  sla: { week: string; decided: number; late: number; onTimePct: number | null }[];
  byForm: { form: string; raised: number; completed: number; avgCycle: number | null }[];
  byDepartment: { department: string; raised: number; avgCycle: number | null }[];
  status: { status: string; count: number }[];
  approvers: { approver: string; completed: number; onTimePct: number | null; avgResponse: number | null }[];
  bottlenecks: { approver: string; pending: number; overdue: number; oldestDays: number | null }[];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export const analytics = createServerFn({ method: 'POST' })
  .inputValidator((input: AnalyticsInput) => {
    const days = [30, 90, 180, 365].includes(Number(input?.days)) ? Number(input.days) as AnalyticsInput['days'] : 90;
    const str = (v: unknown) => (typeof v === 'string' && v.length <= 120 && v ? v : null);
    return { days, department: str(input?.department), form: str(input?.form) };
  })
  .handler(async ({ data }): Promise<{ ok: true; analytics: Analytics } | { ok: false; error: string }> => {
    try {
      const ctx = await resolveContext();
      const a = await withContext(ctx, async (c) => {
        await requireReports(c);
        const p = [`${data.days} days`, data.department, data.form];
        // Requests in the window ($1), for one department ($2) and form ($3) when given.
        // Every query names all three parameters, so each has a type even
        // where the window does not apply.
        const R = `from public.report_requests where $1::interval is not null and ($2::text is null or department = $2) and ($3::text is null or form = $3)`;
        const S = `from public.report_steps where $1::interval is not null and ($2::text is null or requester_department = $2) and ($3::text is null or form = $3)`;
        // One connection answers one query at a time.
        const q = (() => { let chain = Promise.resolve() as Promise<unknown>; return (sql: string) => {
          const next = chain.then(() => c.query(sql, p)); chain = next.catch(() => {}); return next; }; })();

        const [k, kp, steps, stepsPrev, now, weekly, sla, byForm, byDept, status, approvers, bottlenecks] = await Promise.all([
          q(`select count(*)::int raised,
                          count(*) filter (where status = 'completed')::int completed,
                          count(*) filter (where status = 'rejected')::int rejected,
                          count(*) filter (where status in ('submitted', 'in_progress', 'on_hold'))::int open,
                          round(avg(cycle_days) filter (where status = 'completed'), 1) avg_cycle,
                          round((percentile_cont(0.5) within group (order by cycle_days) filter (where status = 'completed'))::numeric, 1) median_cycle
                     ${R} and submitted_at >= now() - $1::interval`),
          q(`select count(*)::int raised,
                          count(*) filter (where status = 'completed')::int completed,
                          round(avg(cycle_days) filter (where status = 'completed'), 1) avg_cycle
                     ${R} and submitted_at >= now() - 2 * $1::interval and submitted_at < now() - $1::interval`),
          q(`select round(100.0 * count(*) filter (where on_time) / nullif(count(*), 0)) pct
                     ${S} and acted_at >= now() - $1::interval`),
          q(`select round(100.0 * count(*) filter (where on_time) / nullif(count(*), 0)) pct
                     ${S} and acted_at >= now() - 2 * $1::interval and acted_at < now() - $1::interval`),
          q(`select count(*) filter (where overdue)::int overdue, count(*) filter (where status in ('pending', 'clarification'))::int pending
                     ${S}`),
          q(`with w as (select generate_series(date_trunc('week', now() - $1::interval), date_trunc('week', now()) - interval '1 week', interval '1 week') as week)
                   select to_char(w.week, 'YYYY-MM-DD') week,
                          (select count(*)::int ${R} and date_trunc('week', submitted_at) = w.week) raised,
                          (select count(*)::int ${R} and status = 'completed' and date_trunc('week', decided_at) = w.week) completed,
                          (select count(*)::int ${R} and status = 'rejected' and date_trunc('week', decided_at) = w.week) rejected
                     from w order by w.week`),
          q(`with w as (select generate_series(date_trunc('week', now() - $1::interval), date_trunc('week', now()) - interval '1 week', interval '1 week') as week)
                   select to_char(w.week, 'YYYY-MM-DD') week, x.decided, x.late,
                          case when x.decided > 0 then round(100.0 * (x.decided - x.late) / x.decided) end on_time_pct
                     from w, lateral (select count(*)::int decided, count(*) filter (where not on_time)::int late
                                        ${S} and acted_at is not null and date_trunc('week', acted_at) = w.week) x
                    order by w.week`),
          q(`select form, count(*)::int raised, count(*) filter (where status = 'completed')::int completed,
                          round(avg(cycle_days) filter (where status = 'completed'), 1) avg_cycle
                     ${R} and submitted_at >= now() - $1::interval group by form order by raised desc limit 10`),
          q(`select coalesce(department, 'Unassigned') department, count(*)::int raised,
                          round(avg(cycle_days) filter (where status = 'completed'), 1) avg_cycle
                     ${R} and submitted_at >= now() - $1::interval group by 1 order by raised desc`),
          q(`select status, count(*)::int count ${R} and submitted_at >= now() - $1::interval group by status order by count desc`),
          q(`select max(approver) approver, count(*)::int completed,
                          round(100.0 * count(*) filter (where on_time) / nullif(count(*), 0)) on_time_pct,
                          round(avg(response_days), 1) avg_response
                     ${S} and acted_at >= now() - $1::interval and approver_id is not null
                    group by approver_id having count(*) >= 3 order by avg_response desc nulls last limit 10`),
          q(`select max(approver) approver, count(*)::int pending, count(*) filter (where overdue)::int overdue,
                          max(response_days) oldest_days
                     ${S} and status in ('pending', 'clarification') and approver_id is not null
                    group by approver_id order by overdue desc, pending desc limit 8`),
        ]);

        const K = k.rows[0], KP = kp.rows[0];
        return {
          window: { days: data.days, from: new Date(Date.now() - data.days * 86_400_000).toISOString() },
          kpis: {
            raised: K.raised, raisedPrev: KP.raised, completed: K.completed, completedPrev: KP.completed,
            rejected: K.rejected, open: K.open,
            avgCycle: num(K.avg_cycle), avgCyclePrev: num(KP.avg_cycle), medianCycle: num(K.median_cycle),
            onTimePct: num(steps.rows[0].pct), onTimePctPrev: num(stepsPrev.rows[0].pct),
            overdueNow: now.rows[0].overdue, pendingNow: now.rows[0].pending,
          },
          // A window reaching back before anything was raised starts at
          // the first week that has something in it.
          weekly: weekly.rows.slice(Math.max(0, weekly.rows.findIndex((r) => r.raised + r.completed + r.rejected > 0))),
          sla: sla.rows.slice(Math.max(0, sla.rows.findIndex((r) => r.decided > 0))).map((r) => ({ week: r.week, decided: r.decided, late: r.late, onTimePct: num(r.on_time_pct) })),
          byForm: byForm.rows.map((r) => ({ form: r.form, raised: r.raised, completed: r.completed, avgCycle: num(r.avg_cycle) })),
          byDepartment: byDept.rows.map((r) => ({ department: r.department, raised: r.raised, avgCycle: num(r.avg_cycle) })),
          status: status.rows,
          approvers: approvers.rows.map((r) => ({ approver: r.approver, completed: r.completed, onTimePct: num(r.on_time_pct), avgResponse: num(r.avg_response) })),
          bottlenecks: bottlenecks.rows.map((r) => ({ approver: r.approver, pending: r.pending, overdue: r.overdue, oldestDays: num(r.oldest_days) })),
        } satisfies Analytics;
      });
      return { ok: true, analytics: a };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 403) return { ok: false, error: e.message ?? 'Not permitted.' };
      console.error('[analytics]', e?.message ?? err);
      return { ok: false, error: 'The analytics could not be worked out. Try again.' };
    }
  });
