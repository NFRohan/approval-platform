// =====================================================================
// ServiceDesk Plus, inbound: POST /integrations/servicedesk/<organisation>
//
// What ServiceDesk's webhook calls when a ticket is raised (Admin →
// Developer Space → Webhooks, run by a custom trigger on new requests).
// The organisation's link secret goes in an X-AMS-Secret header, or as
// ?key=. The body can be the whole ticket, or only its id — the rest is
// then fetched from ServiceDesk's API. See src/server/servicedesk.ts.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/server/db";
import { completeTicket, normaliseTicket, receiveTicket, type Link } from "@/server/servicedesk";
import { kickMailer } from "@/server/mailer";
import { logAppError } from "@/server/logs";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function same(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const Route = createFileRoute("/integrations/servicedesk/$tenant")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { rows: [link] } = await getPool().query<Link & { inbound_secret: string | null; tenant_id: string }>(
          `select l.* from public.servicedesk_links l join public.tenants t on t.id = l.tenant_id
            where t.slug = $1 and app.tenant_status(t.id) = 'active'`, [params.tenant]);
        const given = request.headers.get("x-ams-secret") ?? new URL(request.url).searchParams.get("key") ?? "";
        if (!link?.inbound_secret || !same(given, link.inbound_secret)) return reply(401, { error: "not authorised" });

        const raw = await request.text();
        let body: unknown;
        try { body = JSON.parse(raw); } catch {
          // A webhook set up as a form post: id=123&subject=…
          body = Object.fromEntries(new URLSearchParams(raw));
        }
        // ServiceDesk's "Parameters" may arrive on the address instead
        // (?id=…); what the body says wins.
        const query = Object.fromEntries([...new URL(request.url).searchParams].filter(([k]) => k !== "key"));
        if (body && typeof body === "object" && !Array.isArray(body)) body = { ...query, ...(body as object) };
        else body = query;
        const ticket = normaliseTicket(body);
        if (!ticket) return reply(400, { error: "the body names no ticket id" });
        try {
          const full = await completeTicket(link, ticket);
          const out = await receiveTicket(link.tenant_id, full, "webhook");
          await kickMailer(link.tenant_id);
          return reply(200, out);
        } catch (err) {
          console.error("[servicedesk] inbound", err instanceof Error ? err.message : err);
          await logAppError("servicedesk inbound", err, 500, link.tenant_id);
          return reply(502, { error: err instanceof Error ? err.message : "the ticket could not be taken in" });
        }
      },
    },
  },
});
