// =====================================================================
// Download a report: /exports/report/<id>?format=xlsx|pdf|csv
//
// With the filters, columns and order the screen is showing (f, c, s),
// so what downloads is what was on screen. <id> may be "adhoc", with the
// dataset in d, for a report being built that has not been saved.
// A real URL rather than a server function, because a browser saves a
// download from a link.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { withContext, resolveContext } from "@/server/db";
import { runReport, requireReports, withAnswers, lastRaw, exportRowLimit } from "@/server/reports";
import { exportReport, fileName, CONTENT_TYPES, type ExportFormat } from "@/server/export";
import { columnsOf, describeFilters, isDataset, type ReportFilters } from "@/lib/report-catalogue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plain(status: number, message: string) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export const Route = createFileRoute("/exports/report/$reportId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const url = new URL(request.url);
        const format = (url.searchParams.get("format") ?? "xlsx") as ExportFormat;
        if (!["xlsx", "pdf", "csv"].includes(format)) return plain(400, "Choose xlsx, pdf or csv.");
        const adhoc = params.reportId === "adhoc";
        if (!adhoc && !UUID.test(params.reportId)) return plain(404, "No such report.");

        let ctx;
        try { ctx = await resolveContext(); } catch { return plain(401, "Sign in to download this report."); }

        let filters: ReportFilters | undefined;
        try { filters = url.searchParams.get("f") ? JSON.parse(url.searchParams.get("f")!) : undefined; }
        catch { return plain(400, "Those filters could not be read."); }
        const sortParam = url.searchParams.get("s")?.split(":");
        const sort = sortParam?.[0] ? { key: sortParam[0], dir: (sortParam[1] === "asc" ? "asc" : "desc") as "asc" | "desc" } : undefined;

        try {
          const out = await withContext(ctx, async (c) => {
            await requireReports(c);
            let title = "Report", dataset: string | null = url.searchParams.get("d"), columns: string[] = [], saved: ReportFilters = {};
            if (!adhoc) {
              const { rows: [r] } = await c.query("select name, dataset, columns, filters from public.report_templates where id = $1", [params.reportId]);
              if (!r) return null;
              title = r.name; dataset = r.dataset; columns = r.columns; saved = r.filters;
            }
            if (!isDataset(dataset)) return null;
            const known = new Set(columnsOf(dataset).map((x) => x.key));
            const asked = url.searchParams.get("c")?.split(",").filter((k) => known.has(k));
            if (asked?.length) columns = asked;
            const f = filters ?? saved;
            let result = await runReport(c, dataset, columns, f, sort, undefined, exportRowLimit(format));
            // A spreadsheet of one form's requests carries its answers.
            if (dataset === "requests" && format !== "pdf") result = await withAnswers(c, result, lastRaw.get(c) ?? [], f);
            const { rows: [me] } = await c.query(
              "select coalesce((select name from public.employees where employee_id = app.current_employee() and tenant_id = app.current_tenant()), 'a portal user') as name");
            const at = new Date();
            const bytes = await exportReport(result, { title, filters: describeFilters(f), generatedBy: me.name, generatedAt: at }, format);
            await c.query("select app.audit('report_exported', 'report', $1::uuid, $2)",
              [adhoc ? null : params.reportId, `${title} as ${format.toUpperCase()}, ${result.rows.length} rows`]);
            return { bytes, name: fileName(title, format, at) };
          });
          if (!out) return plain(404, "No such report.");
          return new Response(new Uint8Array(out.bytes), {
            status: 200,
            headers: {
              "content-type": CONTENT_TYPES[format],
              "content-disposition": `attachment; filename="${out.name}"`,
              "x-content-type-options": "nosniff",
              "cache-control": "private, no-store",
            },
          });
        } catch (err) {
          const e = err as { status?: number; message?: string };
          if (e?.status === 403) return plain(403, e.message ?? "Not permitted.");
          console.error("[export]", e?.message ?? err);
          return plain(500, "The report could not be made.");
        }
      },
    },
  },
});
