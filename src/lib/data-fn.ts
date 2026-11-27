// =====================================================================
// The one server function the client talks to.
//
// This file sits outside src/server/ on purpose. The client shim has to
// import the RPC stub, and the framework denies client imports of
// anything under **/server/** — a guard worth keeping, since that is
// where the database driver lives. The build strips the handler body and
// its imports from the client bundle; what ships is the call, not the
// query engine.
//
// Everything the browser used to send straight to the database now
// arrives here instead. Two things are never taken from the client: the
// tenant, and the SQL. The tenant is resolved server-side; the SQL is
// assembled from the whitelist in tables.ts.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { withContext, resolveContext } from '@/server/db';
import { build, type QueryBody } from '@/server/query';
import { RPCS, HttpError } from '@/server/tables';
import { kickMailer } from '@/server/mailer';
import { logAppError } from '@/server/logs';

export type DataRequest =
  | ({ kind: 'query' } & QueryBody)
  | { kind: 'rpc'; fn: string; args: Record<string, unknown> };

export type DataResponse = {
  // Deliberately `any`. There are no generated row types behind this
  // endpoint, so the honest description of what comes back is "whatever
  // the whitelist let through" — and `unknown` fails the framework's
  // serialization check besides. Call sites narrow it themselves.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  count?: number | null;
  error: { message: string; status: number } | null;
  /** True when a select came back exactly at the row ceiling. */
  truncated?: boolean;
};

function fail(err: unknown, tenantId?: string | null): DataResponse {
  if (err instanceof HttpError) {
    return { data: null, error: { message: err.message, status: err.status } };
  }
  const e = err as { code?: string; message?: string };

  // Postgres refuses a write that row-level security forbids with 42501.
  // Reporting it as 403 keeps the client honest without describing the
  // policy that stopped it.
  // 28000 is what app.assert_tenant_live() raises when the evaluation
  // has been withdrawn or has expired mid-session. The message is
  // written for the person holding the login.
  if (e?.code === '28000') {
    return { data: null, error: { message: e.message ?? 'this evaluation is no longer available', status: 401 } };
  }
  if (e?.code === '42501') {
    return { data: null, error: { message: 'not permitted', status: 403 } };
  }
  // P0001 is what a plain `raise exception` in our own functions uses.
  // Those messages are written for the person on screen — "only 3
  // available, 5 requested" — so they are passed through rather than
  // flattened into "internal error".
  if (e?.code === 'P0001' && e.message) {
    return { data: null, error: { message: e.message, status: 409 } };
  }
  if (e?.code === '23505') {
    return { data: null, error: { message: 'already exists', status: 409 } };
  }
  if (e?.code === '23503') {
    return { data: null, error: { message: 'referenced record does not exist', status: 409 } };
  }
  if (e?.code === '23514') {
    return { data: null, error: { message: 'value is not allowed here', status: 400 } };
  }

  console.error('[data]', e?.message || err);
  void logAppError('data', err, 500, tenantId);
  return { data: null, error: { message: 'internal error', status: 500 } };
}

/** One request, for a context already resolved. Never throws: errors come back as values. */
async function execute(ctx: Awaited<ReturnType<typeof resolveContext>>, body: DataRequest): Promise<DataResponse & { wrote?: boolean }> {
  try {
    if (body.kind === 'rpc') {
      const allowed = RPCS[body.fn];
      if (!allowed) throw new HttpError(400, `unknown function: ${body.fn}`);

      // Arguments are matched by name and passed in the order the
      // function declares them, so a caller cannot reorder or add any.
      // An omitted one is refused rather than bound as null: that is
      // exactly how a call site spelling its arguments differently
      // from the whitelist went unnoticed, silently transferring
      // stock from nowhere to nowhere.
      const params = allowed.map((name) => {
        if (!body.args || !(name in body.args)) {
          throw new HttpError(400, `${body.fn} requires ${name}`);
        }
        return body.args[name] ?? null;
      });
      const holes = allowed.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await withContext(ctx, async (client) =>
        (await client.query(`select public.${body.fn}(${holes}) as result`, params)).rows);
      return { data: rows[0]?.result ?? null, error: null, wrote: true };
    }

    const { text, params, limit } = build(body);
    const result = await withContext(ctx, async (client) => client.query(text, params));

    if (body.countOnly) {
      return { data: null, count: result.rows[0]?.count ?? 0, error: null, wrote: body.op !== 'select' };
    }

    const rows = result.rows;
    return {
      data: rows,
      error: null,
      // Hitting the ceiling exactly is indistinguishable from a result
      // that happens to be that size, so this is "may be incomplete"
      // rather than a claim.
      truncated: limit !== undefined && rows.length >= limit,
      wrote: body.op !== 'select',
    };
  } catch (err) {
    return fail(err, ctx.tenantId);
  }
}

export const runData = createServerFn({ method: 'POST' })
  .inputValidator((input: DataRequest) => input)
  .handler(async ({ data: body }): Promise<DataResponse> => {
    let ctx;
    try {
      ctx = await resolveContext();
    } catch (err) {
      return fail(err, null);
    }
    const { wrote, ...res } = await execute(ctx, body);
    // Approving, forwarding, noting — most of these tell somebody,
    // and telling them is now also an email.
    if (wrote && !res.error) await kickMailer(ctx.tenantId);
    return res;
  });

/**
 * Several reads in one round trip. A screen asks for its counts and
 * lists at the same moment; each used to be a request of its own, and on
 * a serverless host every request is an invocation, a session check and
 * a connection. The client gathers the reads issued in the same tick
 * (src/lib/db.ts) and sends them here; each runs on its own, as it would
 * have alone, and answers for itself — one refusal does not fail the
 * others. Reads only: writes keep their own requests and their order.
 */
export const runDataBatch = createServerFn({ method: 'POST' })
  .inputValidator((input: DataRequest[]) => {
    if (!Array.isArray(input) || input.length === 0 || input.length > 25) throw new HttpError(400, 'a batch is 1 to 25 reads');
    if (input.some((b) => b.kind !== 'query' || b.op !== 'select')) throw new HttpError(400, 'a batch holds reads only');
    return input;
  })
  .handler(async ({ data: bodies }): Promise<DataResponse[]> => {
    let ctx;
    try {
      ctx = await resolveContext();
    } catch (err) {
      const f = fail(err, null);
      return bodies.map(() => f);
    }
    const out: DataResponse[] = [];
    for (const b of bodies) {
      const { wrote: _wrote, ...res } = await execute(ctx, b);
      out.push(res);
    }
    return out;
  });
