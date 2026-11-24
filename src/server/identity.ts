// =====================================================================
// Building a session from the database.
//
// Sign-in, the second step, switching persona and changing a password
// all end the same way: read the account, its tenant and whoever it acts
// as, and issue a session. Doing it in one place means no path can forget
// to recompute the permissions or to check the persona still works here.
//
// Runs as the connecting role (no RLS), so every statement names the
// tenant itself — the same discipline as the security-definer functions.
// =====================================================================

import type pg from 'pg';
import { nowSeconds, type Session } from './auth';
import { PASSWORD_MAX_AGE_DAYS } from '@/lib/password-policy';

export const EMPLOYEE_ID = /^[A-Za-z0-9._-]{1,40}$/;

export type AccountRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string | null;
  is_staff: boolean;
  status: string;
  approval_state: string;
  must_change_pw: boolean;
  password_changed_at: Date | null;
  password_history: string[];
  failed_attempts: number;
  locked_at: Date | null;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  mfa_last_step: string | number | null;
  auth_source: string;
  employee_id: string | null;
  tenant_id: string | null;
  slug: string | null;
  expires_at: Date | null;
  tenant_state: string;
  persona_switching: boolean | null;
  require_admin_mfa: boolean | null;
  default_persona: string | null;
};

// The password and its history are kept apart from the account, in
// vault.credentials (db/009_sow_gaps.sql); the account's own copy is the
// fallback while a release that moves them rolls out.
const ACCOUNT_COLUMNS = `
  u.id, u.username, coalesce(c.password_hash, u.password_hash) as password_hash, u.role, u.is_staff, u.status, u.approval_state,
  u.must_change_pw, u.password_changed_at, coalesce(c.password_history, u.password_history, '{}') as password_history,
  u.failed_attempts, u.locked_at,
  u.mfa_enabled, u.mfa_secret, u.mfa_last_step, u.auth_source, u.employee_id, u.tenant_id,
  t.slug, t.expires_at, t.persona_switching, t.require_admin_mfa, t.default_persona,
  case when u.tenant_id is null then 'active' else app.tenant_status(u.tenant_id) end as tenant_state`;

export async function accountByUsername(client: pg.PoolClient, username: string): Promise<AccountRow | null> {
  const { rows } = await client.query(
    `select ${ACCOUNT_COLUMNS}
       from public.app_users u left join public.tenants t on t.id = u.tenant_id
       left join vault.credentials c on c.user_id = u.id
      where lower(u.username) = lower($1)`, [username]);
  return (rows[0] as AccountRow) ?? null;
}

export async function accountById(client: pg.PoolClient, id: string): Promise<AccountRow | null> {
  const { rows } = await client.query(
    `select ${ACCOUNT_COLUMNS}
       from public.app_users u left join public.tenants t on t.id = u.tenant_id
       left join vault.credentials c on c.user_id = u.id
      where u.id = $1`, [id]);
  return (rows[0] as AccountRow) ?? null;
}

/** Why this account may not have a session at all, or null. */
export function accountRefusal(row: AccountRow): string | null {
  if (row.approval_state === 'pending') return 'This account is waiting for approval.';
  if (row.approval_state === 'rejected') return 'This account was not approved.';
  if (row.status === 'deactivated') return 'This account has been deactivated.';
  if (row.status !== 'active') return 'This account has been disabled.';
  if (row.tenant_state === 'revoked') return 'This evaluation has been withdrawn. Get in touch for a new one.';
  if (row.tenant_state === 'expired') return 'This evaluation has expired. Get in touch for an extension.';
  return null;
}

export function canSwitchPersona(row: AccountRow): boolean {
  return !row.is_staff && !row.employee_id && row.persona_switching === true;
}

/**
 * Issue a session for an account.
 *
 * `persona` is who an evaluation's login wants to act as; anybody else
 * acts as themselves whatever is asked. A persona that is not an active
 * employee of this tenant falls back to the tenant's default.
 */
export async function buildSession(
  client: pg.PoolClient,
  row: AccountRow,
  opts: { persona?: string | null; mfa: boolean; mustChangePassword?: boolean },
): Promise<Session> {
  const canSwitch = canSwitchPersona(row);
  const wanted = row.employee_id
    ?? (canSwitch ? (opts.persona && EMPLOYEE_ID.test(opts.persona) ? opts.persona : row.default_persona) : null);

  let employeeId: string | null = null;
  let personaName: string | null = null;
  let personaTitle: string | null = null;
  let personaDepartment: string | null = null;

  if (wanted && row.tenant_id) {
    const { rows } = await client.query(
      `select employee_id, name, designation, department, active from public.employees
        where tenant_id = $1 and employee_id = any ($2::text[])`,
      [row.tenant_id, [wanted, row.default_persona].filter(Boolean)]);
    const pick = rows.find((r) => r.employee_id === wanted && r.active)
      ?? (canSwitch ? rows.find((r) => r.employee_id === row.default_persona && r.active) : undefined);
    if (pick) {
      employeeId = pick.employee_id;
      personaName = pick.name;
      personaTitle = pick.designation;
      personaDepartment = pick.department;
    }
  }

  // A person whose employee record has gone acts as nobody. They keep a
  // session (to read what they can) but app.acting() will not let them
  // act as anybody, and they hold no permissions.
  if (row.employee_id && !employeeId) {
    employeeId = row.employee_id;
  }

  let permissions: string[] = [];
  if (employeeId && row.tenant_id) {
    const { rows } = await client.query(
      // Roles given to the person or to a group they are in (app.held_roles).
      `select distinct unnest(r.permissions) as p
         from public.roles r
        where r.tenant_id = $1 and r.id in (select app.held_roles($2, $1))
        order by 1`, [row.tenant_id, employeeId]);
    permissions = rows.map((r) => String(r.p));
  } else if (row.is_staff || (row.role ?? 'admin') === 'admin') {
    const { rows } = await client.query('select unnest(app.permission_catalogue()) as p');
    permissions = rows.map((r) => String(r.p));
  }

  const passwordExpired = row.auth_source === 'local'
    && !!row.password_changed_at
    && Date.now() - new Date(row.password_changed_at).getTime() > PASSWORD_MAX_AGE_MS;

  return {
    tenantId: row.tenant_id,
    tenantSlug: row.slug ?? '',
    userId: row.id,
    username: row.username,
    role: row.role ?? 'admin',
    isStaff: row.is_staff === true,
    mustChangePassword: opts.mustChangePassword ?? (row.must_change_pw === true || passwordExpired),
    tenantExpiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    employeeId,
    personaName,
    personaTitle,
    personaDepartment,
    canSwitch,
    permissions,
    mfa: opts.mfa,
    requireAdminMfa: row.require_admin_mfa === true,
    seen: nowSeconds(),
  };
}

const PASSWORD_MAX_AGE_MS = PASSWORD_MAX_AGE_DAYS * 86_400_000;

/** Admin permissions only count after two-step sign-in where the organisation requires it. */
export function effectivePermissions(session: Session, adminPermissions: readonly string[] = ADMIN_PERMISSIONS): string[] {
  if (!session.requireAdminMfa || session.mfa) return session.permissions;
  return session.permissions.filter((p) => !adminPermissions.includes(p));
}

export const ADMIN_PERMISSIONS = ['users.manage', 'users.approve', 'roles.manage', 'roles.approve', 'org.manage'] as const;
