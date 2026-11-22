// =====================================================================
// Download an attachment.
//
// A server route rather than a server function, because a download has
// to be a real URL: the browser saves what comes back from a link, and a
// function result would have to be reassembled into a file by script.
//
// Every response is a download, never a page. A file somebody uploaded
// is served with Content-Disposition: attachment and nosniff, so an
// uploaded .html or .svg cannot run as this site's own script in the
// next person's browser.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { withContext, resolveContext } from "@/server/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plain(status: number, message: string) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/files/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const id = params.attachmentId;
        // Who is opening it, for the access log: the session's employee.
        // The link's ?by= is used only where the session names nobody.
        const claimed = new URL(request.url).searchParams.get("by")?.slice(0, 40) || null;
        if (!UUID.test(id)) return plain(404, "No such file.");

        let ctx;
        try {
          ctx = await resolveContext();
        } catch {
          return plain(401, "Sign in to download this file.");
        }

        try {
          const row = await withContext(ctx, async (client) => {
            // The policies confine this to the caller's tenant: a file
            // from another evaluation is simply not found.
            const { rows } = await client.query(
              `select file_name, content_type, data
                 from public.attachments where id = $1`,
              [id],
            );
            // "Keep track of accessed or modified specific documents."
            if (rows[0]) {
              await client.query(
                "insert into public.attachment_access (attachment_id, actor_id) values ($1, $2)",
                [id, ctx.employeeId ?? claimed],
              );
            }
            return rows[0] as { file_name: string; content_type: string; data: Buffer } | undefined;
          });
          if (!row) return plain(404, "No such file.");

          const ascii = row.file_name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
          return new Response(new Uint8Array(row.data), {
            status: 200,
            headers: {
              "content-type": row.content_type || "application/octet-stream",
              "content-length": String(row.data.length),
              "content-disposition":
                `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
              "x-content-type-options": "nosniff",
              "cache-control": "private, no-store",
            },
          });
        } catch (err) {
          // 28000 is app.assert_tenant_live refusing a withdrawn or
          // expired evaluation; anything else is a fault worth logging.
          if ((err as { code?: string })?.code === "28000") {
            return plain(401, "This evaluation is no longer available.");
          }
          console.error("[files] download failed", err instanceof Error ? err.message : err);
          return plain(500, "The file could not be read.");
        }
      },
    },
  },
});
