// =====================================================================
// The approval record of a request, as a PDF: /records/<submission id>
//
// Anybody who can see the request can download its record; row-level
// security decides that, as for the status page itself.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { withContext, resolveContext } from "@/server/db";
import { loadRecord, recordPdf } from "@/server/record";
import { appUrl } from "@/server/mailer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plain(status: number, message: string) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export const Route = createFileRoute("/records/$submissionId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!UUID.test(params.submissionId)) return plain(404, "No such request.");
        let ctx;
        try { ctx = await resolveContext(); } catch { return plain(401, "Sign in to download this record."); }
        try {
          const out = await withContext(ctx, async (c) => {
            const data = await loadRecord(c, params.submissionId);
            if (!data) return null;
            return { bytes: await recordPdf(data, `${appUrl()}/status/${params.submissionId}`), ref: data.req.reference ?? "approval-record" };
          });
          if (!out) return plain(404, "No such request.");
          return new Response(new Uint8Array(out.bytes), {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="${String(out.ref).replace(/[^A-Za-z0-9-]/g, "")}.pdf"`,
              "x-content-type-options": "nosniff",
              "cache-control": "private, no-store",
            },
          });
        } catch (err) {
          console.error("[record]", err instanceof Error ? err.message : err);
          return plain(500, "The record could not be made.");
        }
      },
    },
  },
});
