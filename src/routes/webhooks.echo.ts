// =====================================================================
// A webhook receiver, built in: POST /webhooks/echo
//
// For trying webhooks without standing anything up. Point a webhook at
// /webhooks/echo and each delivery arrives here, has its signature
// checked against the webhook's secret exactly as a real receiver
// should (src/server/webhooks.ts verifySignature), and is answered with
// what was found — which the delivery log then shows.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { getPool } from "@/server/db";
import { verifySignature } from "@/server/webhooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const Route = createFileRoute("/webhooks/echo")({
  server: {
    handlers: {
      GET: async () => reply(200, { receiver: "AMS built-in webhook receiver", accepts: "POST, signed with X-AMS-Signature" }),
      POST: async ({ request }) => {
        const body = await request.text();
        const delivery = request.headers.get("x-ams-delivery") ?? "";
        if (!UUID.test(delivery)) return reply(400, { received: false, error: "no X-AMS-Delivery header" });
        const { rows: [w] } = await getPool().query(
          `select w.secret from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id where d.id = $1`, [delivery]);
        if (!w) return reply(404, { received: false, error: "this receiver does not know that delivery" });
        const check = verifySignature(w.secret, request.headers.get("x-ams-signature"), request.headers.get("x-ams-timestamp"), body);
        if (!check.ok) return reply(401, { received: true, verified: false, reason: check.reason });
        let event: string | null = null;
        try { event = JSON.parse(body).event ?? null; } catch { /* reported below */ }
        return reply(200, { received: true, verified: true, event, bytes: body.length });
      },
    },
  },
});
