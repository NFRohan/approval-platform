// =====================================================================
// Push the audit trail to the SIEM: /cron/siem
//
// Called every few minutes by the scheduler (deploy/k8s/ams.yaml, or the
// VM's crontab) with CRON_SECRET. See src/server/siem.ts.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { pushToSiem } from "@/server/siem";

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

export const Route = createFileRoute("/cron/siem")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorised(request)) return reply(401, { error: "not authorised" });
        try { return reply(200, await pushToSiem()); }
        catch (err) {
          console.error("[cron] siem", err instanceof Error ? err.message : err);
          return reply(500, { error: "SIEM push failed" });
        }
      },
    },
  },
});
