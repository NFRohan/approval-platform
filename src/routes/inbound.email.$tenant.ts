// =====================================================================
// Inbound mail: POST /inbound/email/<organisation slug>
//
// Point a mail provider's inbound webhook here (Postmark, or anything
// that can post {from, subject, text, attachments}), with the shared
// secret INBOUND_SECRET in the x-inbound-secret header or as ?key=. Each
// message becomes a ticket, a note on one, or a logged refusal — see
// src/server/inbound.ts.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/server/db";
import { normaliseInbound, receiveMail } from "@/server/inbound";
import { kickMailer } from "@/server/mailer";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function authorised(request: Request): boolean {
  const secret = process.env.INBOUND_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(request.headers.get("x-inbound-secret") ?? new URL(request.url).searchParams.get("key") ?? "");
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

export const Route = createFileRoute("/inbound/email/$tenant")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!authorised(request)) return reply(401, { error: "not authorised" });
        let body: Record<string, unknown>;
        try { body = await request.json(); } catch { return reply(400, { error: "expected JSON" }); }
        const msg = normaliseInbound(body);
        if (!msg) return reply(400, { error: "a message needs a sender" });

        const client = await getPool().connect();
        try {
          const { rows: [t] } = await client.query(
            "select id from public.tenants where slug = $1 and app.tenant_status(id) = 'active'", [params.tenant]);
          if (!t) return reply(404, { error: "no such organisation" });
          await client.query("begin");
          await client.query(
            `select set_config('app.tenant_id', $1, true), set_config('app.role', 'admin', true),
                    set_config('app.employee_id', '', true), set_config('app.user_id', '', true)`, [t.id]);
          const out = await receiveMail(client, msg);
          await client.query("commit");
          await kickMailer(t.id);
          return reply(200, out);
        } catch (err) {
          await client.query("rollback").catch(() => {});
          console.error("[inbound]", err instanceof Error ? err.message : err);
          return reply(500, { error: "the message could not be taken in" });
        } finally {
          client.release();
        }
      },
    },
  },
});
