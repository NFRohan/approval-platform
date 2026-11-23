// =====================================================================
// Download the audit trail: /exports/audit?format=csv|xlsx
//
// With the filters on screen (from, to, categories, severity, q), so
// what downloads is what was shown — up to 20,000 entries. Downloading
// it is itself recorded.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { withContext, resolveContext } from "@/server/db";
import { exportReport, fileName, CONTENT_TYPES, type ExportFormat } from "@/server/export";
import { auditArgs } from "@/lib/audit-fn";
import type { ReportResult } from "@/lib/report-catalogue";

function plain(status: number, message: string) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export const Route = createFileRoute("/exports/audit")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const format = (url.searchParams.get("format") ?? "xlsx") as ExportFormat;
        if (!["xlsx", "csv", "pdf"].includes(format)) return plain(400, "Choose xlsx, csv or pdf.");
        let ctx;
        try { ctx = await resolveContext(); } catch { return plain(401, "Sign in to download the audit trail."); }
        const q = {
          from: url.searchParams.get("from"), to: url.searchParams.get("to"),
          categories: (url.searchParams.get("categories") ?? "").split(",").filter(Boolean),
          severity: url.searchParams.get("severity"), search: url.searchParams.get("q"),
        };
        try {
          const out = await withContext(ctx, async (c) => {
            const { rows } = await c.query("select * from public.audit_events($1, $2, $3::text[], $4, $5, $6)", auditArgs(q, 20000));
            const result: ReportResult = {
              columns: [
                { key: "at", label: "When", type: "datetime" }, { key: "category", label: "Category", type: "text" },
                { key: "severity", label: "Severity", type: "text" }, { key: "source", label: "Source", type: "text" },
                { key: "action", label: "Action", type: "text" }, { key: "actor_id", label: "Actor id", type: "text" },
                { key: "actor", label: "Actor", type: "text" }, { key: "subject", label: "Subject", type: "text" },
                { key: "detail", label: "Detail", type: "text" },
              ],
              rows: rows.map((r) => ({ ...r, at: new Date(r.at).toISOString(), subject_id: undefined })),
              truncated: rows.length >= 20000,
            };
            const { rows: [me] } = await c.query(
              "select coalesce((select name from public.employees where employee_id = app.current_employee() and tenant_id = app.current_tenant()), 'a portal user') as name");
            const describe = [
              q.from ? `from ${q.from.slice(0, 10)}` : "last 30 days", q.to ? `to ${q.to.slice(0, 10)}` : null,
              q.categories.length ? q.categories.join(", ") : "every category", q.severity ? `${q.severity} and above` : null,
              q.search ? `matching "${q.search}"` : null,
            ].filter(Boolean).join(" · ");
            const at = new Date();
            const bytes = await exportReport(result, { title: "Audit trail", filters: describe, generatedBy: me.name, generatedAt: at }, format);
            await c.query("select app.audit('audit_exported', 'tenant', null::uuid, $1)", [`${rows.length} entries as ${format.toUpperCase()} — ${describe}`]);
            return { bytes, name: fileName("Audit trail", format, at) };
          });
          return new Response(new Uint8Array(out.bytes), {
            status: 200,
            headers: {
              "content-type": CONTENT_TYPES[format], "content-disposition": `attachment; filename="${out.name}"`,
              "x-content-type-options": "nosniff", "cache-control": "private, no-store",
            },
          });
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e?.code === "P0001") return plain(403, e.message ?? "Not permitted.");
          console.error("[export audit]", e?.message ?? err);
          return plain(500, "The audit trail could not be exported.");
        }
      },
    },
  },
});
