// =====================================================================
// Pushing the audit trail to a SIEM (SOW §6: "integration with the SIEM").
//
// Beside the pull feed (GET /api/v1/audit), the trail can be pushed: every
// few minutes /cron/siem sends what was recorded since the last push to
// SIEM_URL, as newline-delimited JSON (ELK, Splunk HEC raw, any HTTP
// input) or as ArcSight CEF lines (SIEM_FORMAT=cef). Where each
// organisation's last push reached is kept in system_runs, so nothing is
// sent twice and nothing is skipped; a failed push is recorded as a
// failed run, which alerts the administrators.
//
//   SIEM_URL      where to POST (unset: the push does nothing)
//   SIEM_AUTH     the Authorization header's value, e.g. "Splunk <token>"
//   SIEM_FORMAT   json (default) or cef
// =====================================================================

import { getPool } from './db';

type AuditRow = {
  at: Date; category: string; severity: string; source: string; action: string;
  actor_id: string | null; actor: string | null; subject: string | null; subject_id: string | null; detail: string | null;
};

const SEVERITY: Record<string, number> = { info: 3, notice: 5, warning: 6, high: 8, critical: 10 };

/** One line of ArcSight Common Event Format. */
export function toCef(r: AuditRow, tenant: string): string {
  const head = (v: string) => v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const ext = (v: string) => v.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r?\n/g, ' ');
  const fields = [
    `rt=${new Date(r.at).getTime()}`,
    r.actor_id ? `suser=${ext(r.actor_id)}` : '',
    r.actor ? `suid=${ext(r.actor)}` : '',
    `cs1Label=organisation cs1=${ext(tenant)}`,
    `cs2Label=category cs2=${ext(r.category)}`,
    r.subject ? `cs3Label=subject cs3=${ext(r.subject)}` : '',
    r.detail ? `msg=${ext(r.detail.slice(0, 1000))}` : '',
  ].filter(Boolean).join(' ');
  return `CEF:0|Intelligent Machines|AMS|1.0|${head(r.action)}|${head(r.action.replace(/_/g, ' '))}|${SEVERITY[r.severity] ?? 3}|${fields}`;
}

export async function pushToSiem(): Promise<{ tenants: number; sent: number; skipped?: string }> {
  const url = process.env.SIEM_URL;
  if (!url) return { tenants: 0, sent: 0, skipped: 'SIEM_URL is not set' };
  const format = process.env.SIEM_FORMAT === 'cef' ? 'cef' : 'json';
  const pool = getPool();
  const { rows: tenants } = await pool.query(
    "select id, slug from public.tenants where kind in ('demo', 'internal') and app.tenant_status(id) = 'active'");
  let sent = 0;
  for (const t of tenants) {
    const started = new Date();
    try {
      const { rows: [last] } = await pool.query(
        `select (result ->> 'until')::timestamptz as until from public.system_runs
          where tenant_id = $1 and job = 'siem_push' and error is null order by started_at desc limit 1`, [t.id]);
      // The first push starts a day back; none covers more than a day.
      const since: Date = last?.until ?? new Date(Date.now() - 86_400_000);
      const until = new Date(Math.min(Date.now(), since.getTime() + 86_400_000));
      const { rows } = await pool.query<AuditRow>(
        `select at, category, severity, source, action, actor_id, actor, subject, subject_id, detail
           from app.audit_rows($1, $2, $3) where at > $2 order by at limit 5000`, [t.id, since, until]);
      // A full batch moves the mark only as far as it reached.
      const reached = rows.length === 5000 ? rows[rows.length - 1].at : until;
      if (rows.length) {
        const body = rows.map((r) => (format === 'cef' ? toCef(r, t.slug) : JSON.stringify({ ...r, organisation: t.slug, product: 'AMS' }))).join('\n') + '\n';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': format === 'cef' ? 'text/plain; charset=utf-8' : 'application/x-ndjson',
            ...(process.env.SIEM_AUTH ? { authorization: process.env.SIEM_AUTH } : {}),
          },
          body,
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`the SIEM answered ${res.status}`);
        sent += rows.length;
      }
      await pool.query(
        "insert into public.system_runs (tenant_id, job, started_at, finished_at, result) values ($1, 'siem_push', $2, now(), $3)",
        [t.id, started, JSON.stringify({ sent: rows.length, until: new Date(reached).toISOString(), format })]);
    } catch (err) {
      await pool.query(
        "insert into public.system_runs (tenant_id, job, started_at, finished_at, error) values ($1, 'siem_push', $2, now(), $3)",
        [t.id, started, (err instanceof Error ? err.message : String(err)).slice(0, 500)]).catch(() => {});
    }
  }
  return { tenants: tenants.length, sent };
}
