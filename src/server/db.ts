// =====================================================================
// Database access.
//
// Every query runs inside a transaction that first drops to an
// unprivileged role and sets the request's identity. That identity is
// what row-level security reads, and it is transaction-local, so it
// cannot leak to the next request sharing a pooled connection — which on
// a serverless platform is the failure mode that matters.
//
// The tenant is never taken from the browser. Until sign-in lands it
// comes from configuration; after that it will come from a verified
// token. Either way the client cannot choose it.
// =====================================================================

import pg from 'pg';
import { HttpError } from './tables';

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString)
        ? false
        : { rejectUnauthorized: false },
      max: Number(process.env.PGPOOL_MAX || 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
    pool.on('error', (err) => console.error('[db] idle client error', err.message));
  }
  return pool;
}

export type RequestContext = {
  tenantId: string | null;
  userId: string | null;
  role?: string;
  isStaff?: boolean;
};

const ROLES = new Set(['admin', 'creator', 'viewer', 'anon']);
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The session preamble, as one statement.
 *
 * Sent as a batch rather than four round trips, because against a
 * database in another region the round trips are most of the response
 * time. Batching means no bind parameters, so every value is validated
 * to a shape that cannot contain a quote before it is embedded: two
 * UUIDs, a role from a fixed set, and a boolean.
 */
function preamble(ctx: RequestContext): string {
  const id = (v: string | null, what: string) => {
    if (v === null || v === undefined || v === '') return '';
    if (!UUID.test(String(v))) throw new HttpError(400, `${what} is not a uuid`);
    return String(v);
  };
  const tenant = id(ctx.tenantId, 'tenant id');
  const user = id(ctx.userId, 'user id');
  const role = ctx.role && ROLES.has(ctx.role) ? ctx.role : 'anon';
  const staff = ctx.isStaff ? 'true' : 'false';

  return `begin;
          set local role app_api;
          select set_config('app.tenant_id', '${tenant}', true),
                 set_config('app.user_id',   '${user}',   true),
                 set_config('app.role',      '${role}',   true),
                 set_config('app.is_staff',  '${staff}',  true);`;
}

/** Run `fn` with the given identity applied to the session. */
export async function withContext<T>(
  ctx: RequestContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  // `begin` is the first statement of the batch below, so from the
  // moment it is sent this connection may be inside a transaction —
  // including when a later statement in the same batch raises.
  let open = true;
  let poisoned = false;

  try {
    // Dropping to app_api is not decoration. The role this connects as
    // owns the tables and carries BYPASSRLS, so without this every
    // policy is skipped and every tenant sees everything.
    try {
      await client.query(preamble(ctx));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/set role|app_api/i.test(message)) {
        throw new Error(
          'cannot assume the app_api role — the role this process connects as must be '
          + `a member of it: grant app_api to "<runtime_role>". (${message})`,
        );
      }
      throw err;
    }

    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    if (open) {
      try {
        await client.query('rollback');
      } catch {
        // The connection cannot be cleaned up, so it must not be reused.
        poisoned = true;
      }
    }
    open = false;
    throw err;
  } finally {
    client.release(poisoned);
  }
}

// ---------------------------------------------------------------------
// Which tenant is this?
//
// Sign-in arrives in a later sprint. Until then the server acts as one
// configured evaluation, resolved here and never sent by the browser —
// so the guarantee that a client cannot choose its tenant holds from the
// first day of the cutover rather than from the day auth lands.
// ---------------------------------------------------------------------
let cached: RequestContext | null = null;

export async function resolveContext(): Promise<RequestContext> {
  if (cached) return cached;

  const slug = process.env.DEMO_TENANT_SLUG || 'template';
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `select t.id as tenant_id, u.id as user_id, u.role
         from public.tenants t
         left join public.app_users u on u.tenant_id = t.id
        where t.slug = $1
        order by u.created_at
        limit 1`,
      [slug],
    );
    if (!rows.length) {
      throw new Error(
        `no tenant with slug "${slug}" — set DEMO_TENANT_SLUG, or seed one with db/004_seed_template.sql`,
      );
    }
    const row = rows[0];
    if (!row.user_id) {
      throw new Error(`tenant "${slug}" has no account; every policy requires a signed-in member`);
    }
    cached = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role || 'admin',
      isStaff: false,
    };
    return cached;
  } finally {
    client.release();
  }
}
