// =====================================================================
// The daily people sync.
//
// "Daily or on-demand sync from AD or HR sources, with monitoring." The
// on-demand half is the People screen; this is the daily half. Any
// scheduler can call it — Vercel Cron does, from vercel.json, and sends
// the CRON_SECRET it is configured with — and every run, good or bad,
// lands in directory_syncs where the People screen shows it.
//
// It runs with no session, as the tenant's administrator: the import and
// the record are security-definer functions that name the tenant
// explicitly, and the tenant is the one the directory is configured for.
// Nothing about it is taken from the request beyond the secret.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/server/db";
import { directoryConfig, directoryPeople } from "@/server/ldap";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function run(request: Request) {
  if (!authorised(request)) return reply(401, { error: "not authorised" });
  const cfg = directoryConfig();
  if (!cfg) return reply(200, { skipped: "no directory is configured" });

  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      "select id from public.tenants where slug = $1 and app.tenant_status(id) = 'active'", [cfg.tenant]);
    if (!rows[0]) return reply(200, { skipped: "the directory's tenant is not active" });

    const scope = async () => {
      await client.query(
        `select set_config('app.tenant_id', $1, true), set_config('app.role', 'admin', true),
                set_config('app.employee_id', '', true), set_config('app.user_id', '', true)`,
        [rows[0].id]);
    };

    let people;
    try {
      people = await directoryPeople(cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.query("begin");
      await scope();
      await client.query("select public.record_directory_sync('scheduled', null, $1)", [message]);
      await client.query("commit");
      return reply(502, { error: message });
    }

    await client.query("begin");
    await scope();
    // A directory sync retires whoever is no longer in it: that is what
    // makes it the source of truth for leavers.
    const { rows: out } = await client.query(
      "select public.import_employees($1::jsonb, true) as r", [JSON.stringify(people)]);
    await client.query("select public.record_directory_sync('scheduled', $1::jsonb, null)", [JSON.stringify(out[0].r)]);
    await client.query("commit");
    return reply(200, { people: people.length, ...out[0].r });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error("[cron] directory sync failed", err instanceof Error ? err.message : err);
    return reply(500, { error: "sync failed" });
  } finally {
    client.release();
  }
}

export const Route = createFileRoute("/cron/directory-sync")({
  server: {
    handlers: {
      GET: ({ request }) => run(request),
      POST: ({ request }) => run(request),
    },
  },
});
