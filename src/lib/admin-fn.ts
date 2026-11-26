// =====================================================================
// Administering people: accounts, roles, and the org chart.
//
// Server functions rather than whitelisted RPCs, because two of them
// handle a password — one is generated here, shown once and stored only
// as a hash — and the directory sync reaches a server the browser must
// never be told how to reach. The rest sit here so administration is in
// one place.
//
// None of these decides who may do what. Each calls a database function
// that checks the acting employee's permission and, for creating or
// changing an account or a role, that whoever approves it is not whoever
// asked. This file only carries the request and the answer.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import type pg from 'pg';
import { withContext, resolveContext } from '@/server/db';
import { generatePassword, hashPassword } from '@/server/auth';
import { directoryConfig, directoryPeople } from '@/server/ldap';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** A database refusal, in the words the function raised it with. */
function refusal(err: unknown): { ok: false; error: string } {
  const e = err as { code?: string; message?: string; status?: number };
  if (e?.code === 'P0001' && e.message) return { ok: false, error: e.message };
  if (e?.code === '23505') return { ok: false, error: 'That already exists.' };
  if (e?.code === '28000' || e?.status === 401) return { ok: false, error: 'Your session has ended. Sign in again.' };
  if (e?.status === 403) return { ok: false, error: e.message ?? 'Not permitted.' };
  console.error('[admin]', e?.message || err);
  return { ok: false, error: 'That did not work. Try again.' };
}

async function run<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const ctx = await resolveContext();
  return withContext(ctx, fn);
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------
export type Account = {
  id: string;
  username: string;
  full_name: string | null;
  employee_id: string | null;
  employee_name: string | null;
  department: string | null;
  email: string | null;
  status: 'active' | 'disabled' | 'deactivated';
  approval_state: 'pending' | 'approved' | 'rejected';
  auth_source: 'local' | 'ldap';
  locked: boolean;
  failed_attempts: number;
  mfa_enabled: boolean;
  must_change_pw: boolean;
  password_changed_at: string | null;
  last_login_at: string | null;
  pending_profile: { full_name?: string; email?: string; by?: string; at?: string } | null;
  created_by_employee: string | null;
  approved_by_employee: string | null;
  deactivated_at: string | null;
  created_at: string;
};

export const listAccounts = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ accounts: Account[] }>> => {
    try {
      const rows = await run(async (c) => (await c.query('select * from public.list_accounts()')).rows);
      return {
        ok: true,
        accounts: rows.map((r) => ({
          ...r,
          password_changed_at: r.password_changed_at ? new Date(r.password_changed_at).toISOString() : null,
          last_login_at: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
          deactivated_at: r.deactivated_at ? new Date(r.deactivated_at).toISOString() : null,
          created_at: new Date(r.created_at).toISOString(),
        })) as Account[],
      };
    } catch (err) {
      return refusal(err);
    }
  });

/**
 * Register an account. A local one gets a generated password, returned
 * this once and never again; a directory one has none here. Either way it
 * waits for somebody else to approve it.
 */
export const registerAccount = createServerFn({ method: 'POST' })
  .inputValidator((input: { employeeId: string; username: string; directory: boolean }) => input)
  .handler(async ({ data }): Promise<Result<{ password: string | null }>> => {
    const username = String(data?.username ?? '').trim().toLowerCase();
    const password = data?.directory ? null : generatePassword();
    try {
      const hash = password ? await hashPassword(password) : null;
      await run((c) => c.query('select public.create_account($1, $2, $3)', [String(data?.employeeId ?? ''), username, hash]));
      return { ok: true, password };
    } catch (err) {
      return refusal(err);
    }
  });

export const decideAccount = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: string; approve: boolean }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.decide_account($1, $2)', [data.userId, data.approve === true]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const proposeProfile = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: string; fullName: string; email: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.propose_profile($1, $2, $3)',
        [data.userId, String(data.fullName ?? '').trim() || null, String(data.email ?? '').trim() || null]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const decideProfile = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: string; approve: boolean }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.decide_profile($1, $2)', [data.userId, data.approve === true]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const setAccountStatus = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: string; status: 'active' | 'disabled' | 'deactivated' }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.set_account_status($1, $2)', [data.userId, data.status]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const unlockAccount = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.unlock_account($1)', [data.userId]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

/** A new password, shown once; the person must change it when they next sign in. */
export const resetAccountPassword = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: string }) => input)
  .handler(async ({ data }): Promise<Result<{ password: string }>> => {
    const password = generatePassword();
    try {
      const hash = await hashPassword(password);
      await run((c) => c.query('select public.set_account_password($1, $2)', [data.userId, hash]));
      return { ok: true, password };
    } catch (err) {
      return refusal(err);
    }
  });

// ---------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------
export const createRole = createServerFn({ method: 'POST' })
  .inputValidator((input: { name: string; description: string; permissions: string[]; scope?: string | null }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.create_role($1, $2, $3, $4)',
        [String(data.name ?? '').trim(), String(data.description ?? '').trim() || null, data.permissions ?? [], data.scope?.trim() || null]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const proposeRoleChange = createServerFn({ method: 'POST' })
  .inputValidator((input: { roleId: string; name: string | null; permissions: string[] | null; scope?: string | null }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.propose_role_change($1, $2, $3, $4)',
        [data.roleId, data.name?.trim() || null, data.permissions ?? null, data.scope?.trim() || null]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const decideRole = createServerFn({ method: 'POST' })
  .inputValidator((input: { roleId: string; approve: boolean }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.decide_role($1, $2)', [data.roleId, data.approve === true]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

export const assignRole = createServerFn({ method: 'POST' })
  .inputValidator((input: { employeeId: string; roleId: string; assign: boolean }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.assign_role($1, $2, $3)', [data.employeeId, data.roleId, data.assign === true]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

/** A role for everybody in a department, kept in step as people move. */
export const assignRoleGroup = createServerFn({ method: 'POST' })
  .inputValidator((input: { department: string; roleId: string; assign: boolean }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      await run((c) => c.query('select public.assign_role_group($1, $2, $3)', [data.department, data.roleId, data.assign === true]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });

// ---------------------------------------------------------------------
// The org chart: the HR master file and the directory.
// ---------------------------------------------------------------------
export type ImportRow = {
  employee_id: string;
  name: string;
  department?: string | null;
  designation?: string | null;
  line_manager_id?: string | null;
  email?: string | null;
};
export type ImportOutcome = { added: number; updated: number; managers: number; left: number; skipped: string[]; departments?: number };

/**
 * Run the import. A preview runs it for real inside a savepoint and rolls
 * back, so what it reports is exactly what applying it would do.
 */
async function importRows(client: pg.PoolClient, rows: ImportRow[], markMissingLeft: boolean, preview: boolean): Promise<ImportOutcome> {
  if (preview) await client.query('savepoint preview');
  const { rows: out } = await client.query('select public.import_employees($1::jsonb, $2) as r',
    [JSON.stringify(rows), markMissingLeft]);
  if (preview) await client.query('rollback to savepoint preview');
  return out[0].r as ImportOutcome;
}

const MAX_IMPORT_ROWS = 20_000;

export const importEmployees = createServerFn({ method: 'POST' })
  .inputValidator((input: { rows: ImportRow[]; markMissingLeft: boolean; preview: boolean }) => {
    if (!Array.isArray(input?.rows)) throw new Error('expected rows');
    if (input.rows.length > MAX_IMPORT_ROWS) throw new Error(`at most ${MAX_IMPORT_ROWS} rows at a time`);
    return input;
  })
  .handler(async ({ data }): Promise<Result<{ outcome: ImportOutcome }>> => {
    try {
      const outcome = await run(async (c) => {
        const r = await importRows(c, data.rows, data.markMissingLeft === true, data.preview === true);
        if (!data.preview) {
          await c.query('select public.record_directory_sync($1, $2::jsonb, null)', ['csv', JSON.stringify(r)]);
        }
        return r;
      });
      return { ok: true, outcome };
    } catch (err) {
      return refusal(err);
    }
  });

export type DirectoryStatus = { configured: boolean; host: string | null };

/** Whether this tenant has a directory. Says where, not how to get in. */
export const directoryStatus = createServerFn({ method: 'GET' })
  .handler(async (): Promise<DirectoryStatus> => {
    const ctx = await resolveContext();
    const cfg = directoryConfig();
    if (!cfg) return { configured: false, host: null };
    const slug = await withContext(ctx, async (c) =>
      (await c.query('select slug from public.tenants where id = app.current_tenant()')).rows[0]?.slug);
    if (slug !== cfg.tenant) return { configured: false, host: null };
    let host: string | null = null;
    try { host = new URL(cfg.url).host; } catch { host = null; }
    return { configured: true, host };
  });

export const syncDirectory = createServerFn({ method: 'POST' })
  .inputValidator((input: { markMissingLeft: boolean; preview: boolean }) => input)
  .handler(async ({ data }): Promise<Result<{ outcome: ImportOutcome; people: number }>> => {
    const status = await directoryStatus();
    if (!status.configured) return { ok: false, error: 'This organisation has no directory connected.' };
    let people;
    try {
      people = await directoryPeople();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!data.preview) {
        await run((c) => c.query('select public.record_directory_sync($1, null, $2)', ['ldap', message])).catch(() => {});
      }
      return { ok: false, error: `The directory did not answer: ${message}` };
    }
    try {
      const outcome = await run(async (c) => {
        const r = await importRows(c, people, data.markMissingLeft === true, data.preview === true);
        if (!data.preview) {
          await c.query('select public.record_directory_sync($1, $2::jsonb, null)', ['ldap', JSON.stringify(r)]);
        }
        return r;
      });
      return { ok: true, outcome, people: people.length };
    } catch (err) {
      return refusal(err);
    }
  });

export type SyncRun = { id: string; source: string; result: ImportOutcome | null; error: string | null; run_by: string | null; created_at: string };

export const listSyncs = createServerFn({ method: 'GET' })
  .handler(async (): Promise<SyncRun[]> => {
    try {
      const rows = await run(async (c) => (await c.query(
        'select id, source, result, error, run_by, created_at from public.directory_syncs order by created_at desc limit 20')).rows);
      return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) as SyncRun[];
    } catch {
      return [];
    }
  });

// ---------------------------------------------------------------------
// What waits on an administrator
//
// New accounts, profile changes, roles and report column changes, each
// waiting for somebody other than whoever asked (public.admin_queue).
// Shown in Pending Approvals; decided there or on the item's own page.
// ---------------------------------------------------------------------
export type AdminItem = {
  kind: 'account' | 'profile' | 'role' | 'report';
  id: string;
  title: string;
  detail: string | null;
  note: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string | null;
};

export const adminQueue = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Result<{ items: AdminItem[] }>> => {
    try {
      const { rows } = await run((c) => c.query('select * from public.admin_queue()'));
      return { ok: true, items: rows as AdminItem[] };
    } catch (err) {
      return refusal(err);
    }
  });

const DECIDE: Record<AdminItem['kind'], string> = {
  account: 'select public.decide_account($1, $2, $3)',
  profile: 'select public.decide_profile($1, $2, $3)',
  role: 'select public.decide_role($1, $2, $3)',
  report: 'select public.decide_report_change($1, $2, $3)',
};

export const decideAdminItem = createServerFn({ method: 'POST' })
  .inputValidator((input: { kind: AdminItem['kind']; id: string; approve: boolean; reason?: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const sql = DECIDE[data.kind];
    if (!sql) return { ok: false, error: 'Nothing of that kind waits for a decision.' };
    try {
      await run((c) => c.query(sql, [data.id, data.approve === true, String(data.reason ?? '').trim() || null]));
      return { ok: true };
    } catch (err) {
      return refusal(err);
    }
  });
