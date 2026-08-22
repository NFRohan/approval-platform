// =====================================================================
// Issuing and withdrawing evaluations.
//
// These are not RPCs on the data endpoint. That endpoint's whitelist
// deliberately only reaches public.*, and provisioning lives in app.*
// behind app.require_staff() — so reaching it needs its own server
// functions, each of which checks the session before it opens a
// connection.
//
// Every one runs with isStaff true and no tenant, which is what
// app.require_staff() looks for and what keeps a staff session from
// reading any prospect's data by accident.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { withContext } from '@/server/db';
import { hashPassword, generatePassword } from '@/server/auth';
import { sessionFromCookie } from '@/server/session';
import { HttpError } from '@/server/tables';

export type Evaluation = {
  id: string;
  name: string;
  slug: string;
  username: string | null;
  state: 'active' | 'expired' | 'revoked';
  expiresAt: string | null;
  daysLeft: number | null;
  lastLoginAt: string | null;
  notes: string | null;
};

async function staffContext() {
  const session = await sessionFromCookie();
  if (!session?.isStaff) throw new HttpError(403, 'staff only');
  return { tenantId: null, userId: session.userId, role: 'admin', isStaff: true };
}

const days = (iso: string | null) =>
  iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : null;

export const listEvaluations = createServerFn({ method: 'GET' })
  .handler(async (): Promise<Evaluation[]> => {
    const ctx = await staffContext();
    return withContext(ctx, async (client) => {
      const { rows } = await client.query(
        `select t.id, t.name, t.slug, t.expires_at, t.notes,
                u.username, u.last_login_at,
                app.tenant_status(t.id) as state
           from public.tenants t
           left join public.app_users u on u.tenant_id = t.id
          where t.kind = 'demo'
          order by t.created_at desc`);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        username: r.username,
        state: r.state,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        daysLeft: days(r.expires_at ? new Date(r.expires_at).toISOString() : null),
        lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
        notes: r.notes,
      }));
    });
  });

/** Returns the password once. It is stored hashed and cannot be shown again. */
export const mintEvaluation = createServerFn({ method: 'POST' })
  .inputValidator((input: { name: string; username: string; days: number; notes?: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; password?: string; slug?: string; error?: string }> => {
    const ctx = await staffContext();
    const name = String(data?.name ?? '').trim();
    const username = String(data?.username ?? '').trim();
    const length = Number(data?.days ?? 30);

    if (!name || !username) return { ok: false, error: 'A name and a username are both needed.' };
    if (!Number.isFinite(length) || length < 1 || length > 365) {
      return { ok: false, error: 'Length must be between 1 and 365 days.' };
    }

    const password = generatePassword();

    try {
      const slug = await withContext(ctx, async (client) => {
        const { rows } = await client.query(
          'select * from app.provision_demo($1, $2, $3, $4::interval, $5, $6)',
          [name, username, await hashPassword(password), `${length} days`,
           ctx.userId, data?.notes ?? null]);
        return rows[0]?.slug as string;
      });
      return { ok: true, password, slug };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not issue that evaluation.' };
    }
  });

export const extendEvaluation = createServerFn({ method: 'POST' })
  .inputValidator((input: { tenantId: string; days: number }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const ctx = await staffContext();
    try {
      await withContext(ctx, (client) =>
        client.query('select app.extend_demo($1, $2::interval, $3)',
          [data.tenantId, `${Number(data.days) || 14} days`, ctx.userId]));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not extend it.' };
    }
  });

export const revokeEvaluation = createServerFn({ method: 'POST' })
  .inputValidator((input: { tenantId: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const ctx = await staffContext();
    try {
      await withContext(ctx, (client) =>
        client.query('select app.revoke_demo($1, $2)', [data.tenantId, ctx.userId]));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not withdraw it.' };
    }
  });

export const resetEvaluationPassword = createServerFn({ method: 'POST' })
  .inputValidator((input: { tenantId: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; password?: string; error?: string }> => {
    const ctx = await staffContext();
    const password = generatePassword();
    try {
      await withContext(ctx, async (client) =>
        client.query('select app.reset_demo_password($1, $2, $3)',
          [data.tenantId, await hashPassword(password), ctx.userId]));
      return { ok: true, password };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not reset it.' };
    }
  });
