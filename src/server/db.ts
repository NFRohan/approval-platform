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
import { liveSession } from './session';

const { Pool } = pg;

// A date column is a calendar date — no time, no zone — so it stays the
// "2026-11-23" Postgres sends. pg would otherwise make it a Date at local
// midnight, which reaches the browser as an object rather than a string
// and, on a server east of UTC, as the day before once it is written out.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

let pool: pg.Pool | undefined;

// TLS to the database, verified: the server's certificate must chain to a
// trusted authority (Neon's does). DATABASE_CA (PEM) trusts an on-prem
// database's own authority; DATABASE_SSL_INSECURE=1 is the explicit,
// logged way out, never the default.
export function dbSsl(connectionString: string): false | { rejectUnauthorized: boolean; ca?: string } {
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
  if (process.env.DATABASE_SSL_INSECURE === '1') {
    console.warn('[db] DATABASE_SSL_INSECURE=1: the database certificate is not verified');
    return { rejectUnauthorized: false };
  }
  // An env var often carries the PEM's line breaks as the two characters \n.
  const ca = process.env.DATABASE_CA?.replace(/\\n/g, '\n');
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString,
      ssl: dbSsl(connectionString),
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
  /** Who is acting. The chain functions take the actor from this, not from their arguments. */
  employeeId?: string | null;
  /** Did the session pass two-step sign-in? Administrative permissions may depend on it. */
  mfa?: boolean;
  /**
   * A call through the open API: the key's id, which is also userId.
   * The database then checks the key rather than an account is live.
   */
  apiKeyId?: string | null;
};

const ROLES = new Set(['admin', 'creator', 'viewer', 'anon']);
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMPLOYEE = /^[A-Za-z0-9._-]{1,40}$/;

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
  const employee = ctx.employeeId ?? '';
  if (employee && !EMPLOYEE.test(employee)) throw new HttpError(400, 'employee id has an unexpected shape');
  const mfa = ctx.mfa ? 'true' : 'false';
  const apiKey = id(ctx.apiKeyId ?? null, 'api key id');

  // The liveness checks ride along in the same batch, so enforcing them
  // on every request costs no extra round trip. They raise 28000 when
  // the evaluation has been withdrawn or has run out, or the account has
  // been disabled, deactivated or locked since the session was issued.
  return `begin;
          set local role app_api;
          select set_config('app.tenant_id', '${tenant}', true),
                 set_config('app.user_id',   '${user}',   true),
                 set_config('app.role',      '${role}',   true),
                 set_config('app.is_staff',  '${staff}',  true),
                 set_config('app.employee_id', '${employee}', true),
                 set_config('app.mfa',       '${mfa}',    true),
                 set_config('app.api_key',   '${apiKey}', true);
          select app.assert_tenant_live(), app.assert_account_live();`;
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
// The signed session says so, and nothing else does. Before sign-in
// existed this came from configuration; either way the browser has
// never been allowed to name its own tenant, because that value is what
// every row-level security policy reads.
//
// No session is a 401 rather than a fallback. A data endpoint that
// quietly serves some default tenant to anonymous callers is the thing
// this sprint exists to remove.
// ---------------------------------------------------------------------
//
// So does who is acting: the session's employee, which the chain
// functions use in place of whatever actor the caller passed.
//
// A password that has to be changed first — the first sign-in, or one
// past its 90 days — opens nothing until it is.
// ---------------------------------------------------------------------
export async function resolveContext(): Promise<RequestContext> {
  const session = await liveSession();
  if (!session) throw new HttpError(401, "not signed in");
  if (session.mustChangePassword) throw new HttpError(403, "change your password first");

  return {
    tenantId: session.tenantId,
    userId: session.userId,
    role: session.role,
    isStaff: session.isStaff,
    employeeId: session.employeeId,
    mfa: session.mfa,
  };
}
