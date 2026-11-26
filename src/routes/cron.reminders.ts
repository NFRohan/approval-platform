// =====================================================================
// The half-day round: /cron/reminders
//
// "T+2 working days for review with a reminder every 12 hours." The
// daily round runs at 08:00 in Dhaka; this one at 20:00, so a step that
// reminds every 12 hours is reminded on time. It sends only those
// (app.interval_reminders), then delivers what it queued.
// Vercel Cron calls it with CRON_SECRET; so can any scheduler.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/server/db";
import { drainOutbox } from "@/server/mailer";
import { drainPush } from "@/server/push";
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

export async function reminderRound() {
  const pool = getPool();
  const { rows: tenants } = await pool.query(
    "select id from public.tenants where kind in ('demo', 'internal') and app.tenant_status(id) = 'active'");
  let reminded = 0;
  for (const t of tenants) {
    const client = await pool.connect();
    const started = new Date();
    try {
      await client.query("begin");
      await client.query(
        `select set_config('app.tenant_id', $1, true), set_config('app.role', 'admin', true),
                set_config('app.employee_id', '', true), set_config('app.user_id', '', true)`, [t.id]);
      const { rows: [r] } = await client.query("select app.interval_reminders() as n");
      await client.query("commit");
      reminded += r.n;
      if (r.n > 0) {
        await pool.query(
          "insert into public.system_runs (tenant_id, job, started_at, finished_at, result) values ($1, 'reminders', $2, now(), $3)",
          [t.id, started, JSON.stringify({ reminders: r.n })]);
      }
    } catch (err) {
      await client.query("rollback").catch(() => {});
      await logAppError("cron reminders", err, 500, t.id);
      // Recorded as a failed run, so the administrators are alerted
      // (app.alert_on_run, db/009_integration.sql).
      await pool.query(
        "insert into public.system_runs (tenant_id, job, started_at, finished_at, error) values ($1, 'reminders', $2, now(), $3)",
        [t.id, started, (err instanceof Error ? err.message : String(err)).slice(0, 500)]).catch(() => {});
    } finally {
      client.release();
    }
  }
  let delivered = { sent: 0, captured: 0, failed: 0 };
  for (let i = 0; i < 20; i++) {
    const d = await drainOutbox({ limit: 25 });
    delivered = { sent: delivered.sent + d.sent, captured: delivered.captured + d.captured, failed: delivered.failed + d.failed };
    if (d.sent + d.captured + d.failed === 0) break;
  }
  const push = await drainPush();
  return { tenants: tenants.length, reminded, ...delivered, push };
}

export const Route = createFileRoute("/cron/reminders")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorised(request)) return reply(401, { error: "not authorised" });
        try { return reply(200, await reminderRound()); }
        catch (err) {
          console.error("[cron] reminders", err instanceof Error ? err.message : err);
          return reply(500, { error: "reminder round failed" });
        }
      },
    },
  },
});
