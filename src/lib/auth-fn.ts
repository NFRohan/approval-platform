// =====================================================================
// Signing in, and who you are once you have.
//
// Outside src/server/ for the same reason as data-fn.ts: the client has
// to import the RPC stub, and the framework denies client imports of
// **/server/**. The handler bodies and everything they import are
// stripped from the browser bundle — what ships is the call.
//
// The password policy lives here: 12 characters with upper, lower, a
// number and a special character; not one of the last five; changed every
// 90 days; ten wrong attempts lock the account for 30 minutes or until an
// administrator unlocks it. A directory account's password is the
// directory's, and none of that applies to it — except the lock, which
// stops this service being used to guess directory passwords.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { getCookie, setCookie, deleteCookie } from '@tanstack/react-start/server';
import { getPool } from '@/server/db';
import {
  SESSION_COOKIE, MFA_PENDING_COOKIE, mfaPendingCookieOptions, IDLE_SECONDS,
  hashPassword, verifyPassword, signMfaPending, verifyMfaPending, type Session,
} from '@/server/auth';
import { liveSession, issueSession } from '@/server/session';
import {
  accountById, accountByUsername, accountRefusal, buildSession, effectivePermissions,
  ADMIN_PERMISSIONS, EMPLOYEE_ID, type AccountRow,
} from '@/server/identity';
import { directoryAuthenticate, directoryConfig } from '@/server/ldap';
import {
  newTotpSecret, otpauthUrl, openSecret, sealSecret, verifyTotp,
} from '@/server/totp';
import {
  LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES, PASSWORD_HISTORY, passwordProblem,
} from '@/lib/password-policy';

export type SignInResult =
  | { ok: true; mustChangePassword: boolean; isStaff: boolean; mfaRequired?: false }
  | { ok: true; mfaRequired: true }
  | { ok: false; error: string };

export type PublicSession = {
  username: string;
  role: string;
  isStaff: boolean;
  tenantSlug: string;
  mustChangePassword: boolean;
  tenantExpiresAt: string | null;
  daysLeft: number | null;
  /** Who is acting, and whether this login may act as somebody else. */
  employeeId: string | null;
  personaName: string | null;
  personaTitle: string | null;
  personaDepartment: string | null;
  canSwitch: boolean;
  /** What the acting employee may do, after the two-step rule. */
  permissions: string[];
  mfa: boolean;
  /** Holds an administrative role the organisation will not honour without two-step sign-in. */
  mfaSetupRequired: boolean;
  idleSeconds: number;
};

function toPublic(session: Session): PublicSession {
  const expires = session.tenantExpiresAt ? new Date(session.tenantExpiresAt) : null;
  const permissions = effectivePermissions(session);
  return {
    username: session.username,
    role: session.role,
    isStaff: session.isStaff,
    tenantSlug: session.tenantSlug,
    mustChangePassword: session.mustChangePassword,
    tenantExpiresAt: session.tenantExpiresAt,
    daysLeft: expires ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86_400_000)) : null,
    employeeId: session.employeeId,
    personaName: session.personaName,
    personaTitle: session.personaTitle,
    personaDepartment: session.personaDepartment ?? null,
    canSwitch: session.canSwitch,
    permissions,
    mfa: session.mfa,
    mfaSetupRequired: session.requireAdminMfa && !session.mfa
      && session.permissions.some((p) => (ADMIN_PERMISSIONS as readonly string[]).includes(p)),
    idleSeconds: IDLE_SECONDS,
  };
}

/** Into the tenant's own trail, as the owner: there is no session yet. */
async function trail(client: import('pg').PoolClient, row: AccountRow, action: string, detail: string) {
  if (!row.tenant_id) return;
  await client.query(
    `insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
     values ($1, (select employee_id from public.employees where tenant_id = $1 and employee_id = $2), $3, 'app_user', $4, $5)`,
    [row.tenant_id, row.employee_id, action, row.id, detail]);
}

function lockedNow(row: AccountRow): boolean {
  return !!row.locked_at && Date.now() - new Date(row.locked_at).getTime() < LOCKOUT_MINUTES * 60_000;
}

export const signIn = createServerFn({ method: 'POST' })
  .inputValidator((input: { username: string; password: string }) => input)
  .handler(async ({ data }): Promise<SignInResult> => {
    const username = String(data?.username ?? '').trim();
    const password = String(data?.password ?? '');
    if (!username || !password) {
      return { ok: false, error: 'Enter a username and password.' };
    }

    // One message for "no such user" and "wrong password", because
    // telling them apart tells an attacker which usernames exist.
    const generic = { ok: false as const, error: 'That username and password do not match.' };

    const client = await getPool().connect();
    try {
      const row = await accountByUsername(client, username);
      if (!row) {
        // Still spend the time, so a missing user is not measurably
        // faster than a wrong password.
        await verifyPassword(password, 'scrypt$00$00');
        return generic;
      }

      const directory = row.auth_source === 'ldap';
      const correct = directory
        ? (directoryConfig()?.tenant === row.slug && await directoryAuthenticate(row.username, password))
        : await verifyPassword(password, row.password_hash);

      // Locked: say so only to somebody who knows the password. Anybody
      // else learns nothing they did not already know, and a lock does
      // not count further failures against itself.
      if (lockedNow(row)) {
        return correct
          ? { ok: false, error: `This account is locked after ${LOCKOUT_ATTEMPTS} wrong attempts. It unlocks in ${LOCKOUT_MINUTES} minutes, or an administrator can unlock it now.` }
          : generic;
      }

      if (!correct) {
        // A lock that has lifted starts the count again.
        const { rows } = await client.query(
          `update public.app_users
              set failed_attempts = case when locked_at is not null then 1 else failed_attempts + 1 end,
                  locked_at = case when (case when locked_at is not null then 1 else failed_attempts + 1 end) >= $2
                                   then now() end
            where id = $1
          returning failed_attempts, locked_at`, [row.id, LOCKOUT_ATTEMPTS]);
        if (rows[0]?.locked_at) {
          await trail(client, row, 'account_locked', `${row.username} locked after ${LOCKOUT_ATTEMPTS} wrong attempts`);
        }
        return generic;
      }

      const refusal = accountRefusal(row);
      if (refusal) return { ok: false, error: refusal };

      if (row.failed_attempts || row.locked_at) {
        await client.query('update public.app_users set failed_attempts = 0, locked_at = null where id = $1', [row.id]);
      }

      if (row.mfa_enabled && row.mfa_secret) {
        setCookie(MFA_PENDING_COOKIE, await signMfaPending(row.id), mfaPendingCookieOptions);
        return { ok: true, mfaRequired: true };
      }

      const session = await buildSession(client, row, { mfa: false });
      await issueSession(session);
      await client.query('update public.app_users set last_login_at = now() where id = $1', [row.id]);
      await trail(client, row, 'signed_in', `${row.username} signed in`);

      return { ok: true, mustChangePassword: session.mustChangePassword, isStaff: session.isStaff };
    } catch (err) {
      console.error('[auth] sign-in failed', err instanceof Error ? err.message : err);
      return { ok: false, error: 'Something went wrong signing in. Try again.' };
    } finally {
      client.release();
    }
  });

/** The second step: a code from the authenticator app. */
export const verifySignInCode = createServerFn({ method: 'POST' })
  .inputValidator((input: { code: string }) => input)
  .handler(async ({ data }): Promise<SignInResult> => {
    const userId = await verifyMfaPending(getCookie(MFA_PENDING_COOKIE));
    if (!userId) return { ok: false, error: 'That took too long. Sign in again.' };

    const client = await getPool().connect();
    try {
      const row = await accountById(client, userId);
      if (!row || !row.mfa_enabled) return { ok: false, error: 'Sign in again.' };
      if (lockedNow(row)) return { ok: false, error: 'This account is locked. An administrator can unlock it.' };
      const refusal = accountRefusal(row);
      if (refusal) return { ok: false, error: refusal };

      const secret = openSecret(row.mfa_secret);
      const step = secret ? verifyTotp(secret, data?.code ?? '', row.mfa_last_step == null ? null : Number(row.mfa_last_step)) : null;
      if (step === null) {
        // Wrong codes count towards the same lock as wrong passwords.
        await client.query(
          `update public.app_users set failed_attempts = failed_attempts + 1,
                  locked_at = case when failed_attempts + 1 >= $2 then now() end
            where id = $1`, [row.id, LOCKOUT_ATTEMPTS]);
        return { ok: false, error: 'That code is not right. Codes change every 30 seconds.' };
      }

      await client.query(
        'update public.app_users set mfa_last_step = $2, failed_attempts = 0, last_login_at = now() where id = $1',
        [row.id, step]);
      deleteCookie(MFA_PENDING_COOKIE, { path: '/' });

      const session = await buildSession(client, row, { mfa: true });
      await issueSession(session);
      await trail(client, row, 'signed_in', `${row.username} signed in with two-step verification`);
      return { ok: true, mustChangePassword: session.mustChangePassword, isStaff: session.isStaff };
    } finally {
      client.release();
    }
  });

export const signOut = createServerFn({ method: 'POST' }).handler(async () => {
  deleteCookie(SESSION_COOKIE, { path: '/' });
  deleteCookie(MFA_PENDING_COOKIE, { path: '/' });
  return { ok: true };
});

/** What the interface may know about who is signed in. No token, no ids. */
export const currentSession = createServerFn({ method: 'GET' })
  .handler(async (): Promise<PublicSession | null> => {
    // Asked on every navigation and by the idle watcher when somebody is
    // using the page: both are activity.
    const session = await liveSession({ touch: true });
    return session ? toPublic(session) : null;
  });

/**
 * Act as somebody else. An evaluation's login only, and only within its
 * own tenant: the persona must be an active employee there. Every switch
 * goes into the trail, under the persona switched to.
 */
export const switchPersona = createServerFn({ method: 'POST' })
  .inputValidator((input: { employeeId: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true; session: PublicSession } | { ok: false; error: string }> => {
    const session = await liveSession();
    if (!session) return { ok: false, error: 'You are not signed in.' };
    if (!session.canSwitch) return { ok: false, error: 'This account acts only as its own person.' };
    const wanted = String(data?.employeeId ?? '');
    if (!EMPLOYEE_ID.test(wanted)) return { ok: false, error: 'That is not an employee.' };
    if (wanted === session.employeeId) return { ok: true, session: toPublic(session) };

    const client = await getPool().connect();
    try {
      const row = await accountById(client, session.userId);
      if (!row) return { ok: false, error: 'Sign in again.' };
      const next = await buildSession(client, row, {
        persona: wanted, mfa: session.mfa, mustChangePassword: session.mustChangePassword,
      });
      if (next.employeeId !== wanted) return { ok: false, error: 'Nobody by that id works here.' };
      next.born = session.born;
      await issueSession(next);

      // On the connection already held: asking the pool for a second one
      // while holding this deadlocks a pool of one.
      await client.query(
        `insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
         values ($1, $2, 'persona_switched', 'app_user', $3, $4)`,
        [next.tenantId, next.employeeId, next.userId, `${next.username} now acting as ${next.personaName} (${next.employeeId})`]);
      return { ok: true, session: toPublic(next) };
    } finally {
      client.release();
    }
  });

export type Persona = { employee_id: string; name: string; designation: string | null; department: string | null; roles: string[] };

/** Who an evaluation's login can act as, with the roles each holds. */
export const listPersonas = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Persona[]> => {
    const session = await liveSession();
    if (!session?.canSwitch || !session.tenantId) return [];
    const client = await getPool().connect();
    try {
      const { rows } = await client.query(
        `select e.employee_id, e.name, e.designation, e.department,
                coalesce(array_agg(r.name order by r.name) filter (where r.id is not null), '{}') as roles
           from public.employees e
           left join public.employee_roles er on er.tenant_id = e.tenant_id and er.employee_id = e.employee_id
           left join public.roles r on r.id = er.role_id and r.tenant_id = er.tenant_id and r.status = 'active'
          where e.tenant_id = $1 and e.active
          group by e.employee_id, e.name, e.designation, e.department
          order by e.name`, [session.tenantId]);
      return rows as Persona[];
    } finally {
      client.release();
    }
  });

/** Has the password been used in the last five? Checks every one; scrypt is the cost. */
async function reused(password: string, row: AccountRow): Promise<boolean> {
  const previous = [row.password_hash, ...(row.password_history ?? [])].slice(0, PASSWORD_HISTORY);
  for (const hash of previous) {
    if (await verifyPassword(password, hash)) return true;
  }
  return false;
}

export const changePassword = createServerFn({ method: 'POST' })
  .inputValidator((input: { current: string; next: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const session = await liveSession();
    if (!session) return { ok: false, error: 'You are not signed in.' };

    const current = String(data?.current ?? '');
    const next = String(data?.next ?? '');

    const client = await getPool().connect();
    try {
      const row = await accountById(client, session.userId);
      if (!row) return { ok: false, error: 'You are not signed in.' };
      if (row.auth_source !== 'local') {
        return { ok: false, error: 'Your password is your directory password. Change it there.' };
      }
      const problem = passwordProblem(next, row.username);
      if (problem) return { ok: false, error: problem };
      if (!(await verifyPassword(current, row.password_hash))) {
        return { ok: false, error: 'That is not your current password.' };
      }
      if (await reused(next, row)) {
        return { ok: false, error: `That is one of your last ${PASSWORD_HISTORY} passwords. Choose another.` };
      }

      const history = [row.password_hash, ...(row.password_history ?? [])].slice(0, PASSWORD_HISTORY - 1);
      await client.query(
        `update public.app_users
            set password_hash = $2, password_history = $3, must_change_pw = false, password_changed_at = now()
          where id = $1`,
        [session.userId, await hashPassword(next), history],
      );
      await trail(client, row, 'password_changed', `${row.username} changed their password`);

      // The old session says the password still needs changing, so it is
      // reissued rather than left to contradict the database.
      await issueSession({ ...session, mustChangePassword: false });
      return { ok: true };
    } finally {
      client.release();
    }
  });

// ---------------------------------------------------------------------
// Two-step sign-in: setting it up and turning it off.
// ---------------------------------------------------------------------
export type MfaStatus = { enabled: boolean; required: boolean; directory: boolean };

export const mfaStatus = createServerFn({ method: 'GET' })
  .handler(async (): Promise<MfaStatus | null> => {
    const session = await liveSession();
    if (!session) return null;
    const client = await getPool().connect();
    try {
      const row = await accountById(client, session.userId);
      if (!row) return null;
      return { enabled: row.mfa_enabled, required: toPublic(session).mfaSetupRequired, directory: row.auth_source === 'ldap' };
    } finally {
      client.release();
    }
  });

/** A new secret, not yet in force: it takes effect when a code from it is confirmed. */
export const startMfaSetup = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ ok: true; secret: string; url: string } | { ok: false; error: string }> => {
    const session = await liveSession();
    if (!session) return { ok: false, error: 'You are not signed in.' };
    const client = await getPool().connect();
    try {
      const row = await accountById(client, session.userId);
      if (!row) return { ok: false, error: 'You are not signed in.' };
      if (row.mfa_enabled) return { ok: false, error: 'Two-step sign-in is already on. Turn it off first to move it to another device.' };
      const secret = newTotpSecret();
      await client.query('update public.app_users set mfa_secret = $2, mfa_last_step = null where id = $1',
        [row.id, sealSecret(secret)]);
      return { ok: true, secret, url: otpauthUrl(secret, row.username) };
    } finally {
      client.release();
    }
  });

export const confirmMfaSetup = createServerFn({ method: 'POST' })
  .inputValidator((input: { code: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const session = await liveSession();
    if (!session) return { ok: false, error: 'You are not signed in.' };
    const client = await getPool().connect();
    try {
      const row = await accountById(client, session.userId);
      const secret = openSecret(row?.mfa_secret);
      if (!row || !secret) return { ok: false, error: 'Start again: there is no setup in progress.' };
      const step = verifyTotp(secret, data?.code ?? '');
      if (step === null) return { ok: false, error: 'That code is not right. Check the time on your phone and try the next one.' };
      await client.query('update public.app_users set mfa_enabled = true, mfa_last_step = $2 where id = $1', [row.id, step]);
      await trail(client, row, 'mfa_enabled', `${row.username} turned on two-step sign-in`);
      // This session has now shown a code, so it counts as two-step.
      await issueSession({ ...session, mfa: true });
      return { ok: true };
    } finally {
      client.release();
    }
  });

export const disableMfa = createServerFn({ method: 'POST' })
  .inputValidator((input: { code: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const session = await liveSession();
    if (!session) return { ok: false, error: 'You are not signed in.' };
    const client = await getPool().connect();
    try {
      const row = await accountById(client, session.userId);
      const secret = openSecret(row?.mfa_secret);
      if (!row || !row.mfa_enabled || !secret) return { ok: false, error: 'Two-step sign-in is not on.' };
      if (verifyTotp(secret, data?.code ?? '', row.mfa_last_step == null ? null : Number(row.mfa_last_step)) === null) {
        return { ok: false, error: 'That code is not right.' };
      }
      await client.query('update public.app_users set mfa_enabled = false, mfa_secret = null, mfa_last_step = null where id = $1', [row.id]);
      await trail(client, row, 'mfa_disabled', `${row.username} turned off two-step sign-in`);
      await issueSession({ ...session, mfa: false });
      return { ok: true };
    } finally {
      client.release();
    }
  });
