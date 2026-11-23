// =====================================================================
// The daily round: /cron/daily
//
// For every live organisation: overdue reminders, reminders before a
// deadline and escalation after one (app.daily_reminders); then the
// scheduled reports that are due; then everything queued is delivered.
// Vercel Cron calls it with CRON_SECRET; so can any scheduler.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/server/db";
import { drainOutbox } from "@/server/mailer";

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
  let dueSoon = 0, escalated = 0, overdue = 0;
  for (const t of tenants) {
    const client = await pool.connect();
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
      await client.query("commit");
      dueSoon += r.r.due_soon; escalated += r.r.escalated; overdue += r.r.overdue;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      console.error("[cron] daily round failed for a tenant", err instanceof Error ? err.message : err);
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
  return { tenants: tenants.length, dueSoon, escalated, overdue, reportsQueued: q.n, ...delivered };
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
