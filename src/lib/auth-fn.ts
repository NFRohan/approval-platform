// =====================================================================
// Signing in.
//
// Outside src/server/ for the same reason as data-fn.ts: the client has
// to import the RPC stub, and the framework denies client imports of
// **/server/**. The handler bodies and everything they import are
// stripped from the browser bundle — what ships is the call.
//
// The login path asks the database one question about the evaluation:
// app.tenant_status(). Revoked, expired and active are decided in one
// place so no caller can forget a case.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { setCookie, deleteCookie } from '@tanstack/react-start/server';
import { getPool } from '@/server/db';
import {
  SESSION_COOKIE, cookieOptions, hashPassword, verifyPassword,
  signSession, type Session,
} from '@/server/auth';
import { sessionFromCookie } from '@/server/session';

export type SignInResult =
  | { ok: true; mustChangePassword: boolean }
  | { ok: false; error: string };

export type PublicSession = {
  username: string;
  role: string;
  isStaff: boolean;
  tenantSlug: string;
  mustChangePassword: boolean;
  tenantExpiresAt: string | null;
  daysLeft: number | null;
};

export const signIn = createServerFn({ method: 'POST' })
  .inputValidator((input: { username: string; password: string }) => input)
  .handler(async ({ data }): Promise<SignInResult> => {
    const username = String(data?.username ?? '').trim();
    const password = String(data?.password ?? '');
    if (!username || !password) {
      return { ok: false, error: 'Enter a username and password.' };
    }

    const client = await getPool().connect();
    try {
      const { rows } = await client.query(
        `select u.id, u.username, u.password_hash, u.role, u.is_staff, u.status,
                u.must_change_pw, u.tenant_id,
                t.slug, t.expires_at,
                case when u.tenant_id is null then 'active'
                     else app.tenant_status(u.tenant_id) end as tenant_state
           from public.app_users u
           left join public.tenants t on t.id = u.tenant_id
          where lower(u.username) = lower($1)`,
        [username],
      );
      const row = rows[0];

      // One message for "no such user" and "wrong password", because
      // telling them apart tells an attacker which usernames exist.
      const generic = { ok: false as const, error: 'That username and password do not match.' };
      if (!row) {
        // Still spend the time, so a missing user is not measurably
        // faster than a wrong password.
        await verifyPassword(password, 'scrypt$00$00');
        return generic;
      }
      if (!(await verifyPassword(password, row.password_hash))) return generic;

      if (row.status !== 'active') {
        return { ok: false, error: 'This account has been disabled.' };
      }
      if (row.tenant_state === 'revoked') {
        return { ok: false, error: 'This evaluation has been withdrawn. Get in touch for a new one.' };
      }
      if (row.tenant_state === 'expired') {
        return { ok: false, error: 'This evaluation has expired. Get in touch for an extension.' };
      }

      const session: Session = {
        tenantId: row.tenant_id,
        tenantSlug: row.slug ?? '',
        userId: row.id,
        username: row.username,
        role: row.role ?? 'admin',
        isStaff: row.is_staff === true,
        mustChangePassword: row.must_change_pw === true,
        tenantExpiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      };

      setCookie(SESSION_COOKIE, await signSession(session), cookieOptions);
      await client.query('update public.app_users set last_login_at = now() where id = $1', [row.id]);

      return { ok: true, mustChangePassword: session.mustChangePassword };
    } catch (err) {
      console.error('[auth] sign-in failed', err instanceof Error ? err.message : err);
      return { ok: false, error: 'Something went wrong signing in. Try again.' };
    } finally {
      client.release();
    }
  });

export const signOut = createServerFn({ method: 'POST' }).handler(async () => {
  deleteCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

/** What the interface may know about who is signed in. No token, no ids. */
export const currentSession = createServerFn({ method: 'GET' })
  .handler(async (): Promise<PublicSession | null> => {
    const session = await sessionFromCookie();
    if (!session) return null;

    const expires = session.tenantExpiresAt ? new Date(session.tenantExpiresAt) : null;
    const daysLeft = expires
      ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86_400_000))
      : null;

    return {
      username: session.username,
      role: session.role,
      isStaff: session.isStaff,
      tenantSlug: session.tenantSlug,
      mustChangePassword: session.mustChangePassword,
      tenantExpiresAt: session.tenantExpiresAt,
      daysLeft,
    };
  });

export const changePassword = createServerFn({ method: 'POST' })
  .inputValidator((input: { current: string; next: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const session = await sessionFromCookie();
    if (!session) return { ok: false, error: 'You are not signed in.' };

    const next = String(data?.next ?? '');
    if (next.length < 10) {
      return { ok: false, error: 'Use at least 10 characters.' };
    }

    const client = await getPool().connect();
    try {
      const { rows } = await client.query(
        'select password_hash from public.app_users where id = $1', [session.userId]);
      if (!rows[0] || !(await verifyPassword(String(data?.current ?? ''), rows[0].password_hash))) {
        return { ok: false, error: 'That is not your current password.' };
      }

      await client.query(
        `update public.app_users
            set password_hash = $2, must_change_pw = false, password_changed_at = now()
          where id = $1`,
        [session.userId, await hashPassword(next)],
      );

      // The old session says the password still needs changing, so it is
      // reissued rather than left to contradict the database.
      setCookie(SESSION_COOKIE,
        await signSession({ ...session, mustChangePassword: false }), cookieOptions);

      return { ok: true };
    } finally {
      client.release();
    }
  });
