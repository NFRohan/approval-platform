// =====================================================================
// The daily round: /cron/daily
//
// For every live organisation: overdue reminders, reminders before a
// deadline and escalation after one (app.daily_reminders); campaigns
// starting and finishing; retention — settled requests archived, old
// logs purged (app.run_retention). Then the scheduled reports that are
// due, and everything queued — email and webhooks — is delivered. Each
// organisation's round is recorded for its audit centre.
// Vercel Cron calls it with CRON_SECRET; so can any scheduler.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/server/db";
import { drainOutbox } from "@/server/mailer";
import { drainWebhooks } from "@/server/webhooks";
import { drainServicedesk, pollServicedesk } from "@/server/servicedesk";
import { logAppError } from "@/server/logs";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function dailyRound() {
  const pool = getPool();
  const { rows: tenants } = await pool.query(
    "select id from public.tenants where kind in ('demo', 'internal') and app.tenant_status(id) = 'active'");
  let dueSoon = 0, escalated = 0, overdue = 0, archived = 0, purged = 0;
  for (const t of tenants) {
    const client = await pool.connect();
    const started = new Date();
    try {
      await client.query("begin");
      await client.query(
        `select set_config('app.tenant_id', $1, true), set_config('app.role', 'admin', true),
                set_config('app.employee_id', '', true), set_config('app.user_id', '', true)`, [t.id]);
      // Tenant-scoped in every statement. remind_overdue() is not called
      // here: it relies on row-level security, which does not apply to
      // the owner this runs as, so it would remind across organisations.
      const { rows: [r] } = await client.query("select app.daily_reminders() as r");
      // Campaigns start on their day and finish after their last.
      await client.query("select app.campaign_daily()");
      // "Archiving yearly, purging at 10 years": settled requests past
      // the organisation's archive age, logs past their purge age.
      const { rows: [k] } = await client.query("select app.run_retention($1, null) as r", [t.id]);
      await client.query("commit");
      dueSoon += r.r.due_soon; escalated += r.r.escalated; overdue += r.r.overdue;
      archived += k.r.archived; purged += k.r.purged;
      await pool.query(
        "insert into public.system_runs (tenant_id, job, started_at, finished_at, result) values ($1, 'daily_round', $2, now(), $3)",
        [t.id, started, JSON.stringify({ reminders: r.r.due_soon + r.r.overdue, escalated: r.r.escalated, archived: k.r.archived, purged: k.r.purged })]);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      console.error("[cron] daily round failed for a tenant", err instanceof Error ? err.message : err);
      await pool.query(
        "insert into public.system_runs (tenant_id, job, started_at, finished_at, error) values ($1, 'daily_round', $2, now(), $3)",
        [t.id, started, (err instanceof Error ? err.message : String(err)).slice(0, 1000)]).catch(() => {});
      await logAppError("cron daily", err, 500, t.id);
    } finally {
      client.release();
    }
  }
  const { rows: [q] } = await pool.query("select app.queue_due_reports() as n");
  let delivered = { sent: 0, captured: 0, failed: 0 };
  for (let i = 0; i < 20; i++) {
    const d = await drainOutbox({ limit: 25 });
    delivered = { sent: delivered.sent + d.sent, captured: delivered.captured + d.captured, failed: delivered.failed + d.failed };
    if (d.sent + d.captured + d.failed === 0) break;
  }
  // ServiceDesk Plus: new tickets fetched where the link is connected,
  // then everything queued for it written back.
  let tickets = 0;
  const { rows: linked } = await pool.query(
    "select l.tenant_id from public.servicedesk_links l join public.tenants t on t.id = l.tenant_id where l.enabled and app.tenant_status(t.id) = 'active'");
  for (const l of linked) {
    const p = await pollServicedesk(l.tenant_id);
    tickets += p.raised;
    await pool.query(
      "insert into public.system_runs (tenant_id, job, finished_at, result, error) values ($1, 'servicedesk_fetch', now(), $2, $3)",
      [l.tenant_id, JSON.stringify(p), p.error ?? null]).catch(() => {});
  }
  const servicedesk = await drainServicedesk();
  let hooks = { delivered: 0, failed: 0, retrying: 0 };
  for (let i = 0; i < 20; i++) {
    const d = await drainWebhooks({ limit: 25 });
    hooks = { delivered: hooks.delivered + d.delivered, failed: hooks.failed + d.failed, retrying: hooks.retrying + d.retrying };
    if (d.delivered + d.failed + d.retrying === 0) break;
  }
  return { tenants: tenants.length, dueSoon, escalated, overdue, archived, purged, reportsQueued: q.n, ...delivered, webhooks: hooks, servicedesk: { tickets, ...servicedesk } };
}

export const Route = createFileRoute("/cron/daily")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorised(request)) return reply(401, { error: "not authorised" });
        try { return reply(200, await dailyRound()); }
        catch (err) {
          console.error("[cron] daily", err instanceof Error ? err.message : err);
          return reply(500, { error: "daily round failed" });
        }
      },
    },
  },
});
