// =====================================================================
// The payment top sheet of a request, as a PDF: /topsheet/<submission id>
// Anybody who can see the request can print it; row-level security
// decides that, as for the status page.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { withContext, resolveContext } from "@/server/db";
import { loadTopSheet, topSheetPdf } from "@/server/topsheet";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (status: number, message: string) =>
  new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export const Route = createFileRoute("/topsheet/$submissionId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!UUID.test(params.submissionId)) return plain(404, "No such request.");
        let ctx;
        try { ctx = await resolveContext(); } catch { return plain(401, "Sign in to print this top sheet."); }
        try {
          const out = await withContext(ctx, async (c) => {
            const data = await loadTopSheet(c, params.submissionId);
            return data ? { bytes: await topSheetPdf(data), ref: data.req.reference ?? "top-sheet" } : null;
          });
          if (!out) return plain(404, "No such request.");
          return new Response(new Uint8Array(out.bytes), {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="top-sheet-${String(out.ref).replace(/[^A-Za-z0-9-]/g, "")}.pdf"`,
              "x-content-type-options": "nosniff",
              "cache-control": "private, no-store",
            },
          });
        } catch (err) {
          console.error("[topsheet]", err instanceof Error ? err.message : err);
          return plain(500, "The top sheet could not be made.");
        }
      },
    },
  },
});
