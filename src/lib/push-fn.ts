// =====================================================================
// Push notifications on this device: the server's public key, and a
// device signed up for (or taken off) the notifications of whoever the
// person is acting as. See src/server/push.ts.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { resolveContext } from '@/server/db';
import { getPool } from '@/server/db';
import { pushNow, vapidKeys } from '@/server/push';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function who() {
  const ctx = await resolveContext();
  if (!ctx.tenantId || !ctx.employeeId || !ctx.userId) throw new Error('Sign in first.');
  return ctx as { tenantId: string; employeeId: string; userId: string };
}

export const pushConfig = createServerFn({ method: 'POST' })
  .inputValidator((input: { endpoint?: string | null }) => input ?? {})
  .handler(async ({ data }): Promise<Result<{ publicKey: string; subscribed: boolean; devices: number }>> => {
    try {
      const me = await who();
      const { publicKey } = await vapidKeys();
      const { rows: [r] } = await getPool().query(
        `select count(*)::int as devices, bool_or(endpoint = $3) as here from public.push_subscriptions
          where tenant_id = $1 and employee_id = $2`, [me.tenantId, me.employeeId, data.endpoint ?? '']);
      return { ok: true, publicKey, subscribed: !!r.here, devices: r.devices };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'That did not work.' };
    }
  });

export const subscribePush = createServerFn({ method: 'POST' })
  .inputValidator((input: { endpoint: string; p256dh: string; auth: string; userAgent?: string }) => {
    if (typeof input?.endpoint !== 'string' || !/^https:\/\/[^\s]{10,2000}$/.test(input.endpoint)) throw new Error('not a push endpoint');
    if (typeof input.p256dh !== 'string' || input.p256dh.length > 200 || typeof input.auth !== 'string' || input.auth.length > 100) throw new Error('bad keys');
    return input;
  })
  .handler(async ({ data }): Promise<Result> => {
    try {
      const me = await who();
      // One device, one person at a time: acting as somebody else moves it.
      await getPool().query(
        `insert into public.push_subscriptions (tenant_id, employee_id, user_id, endpoint, p256dh, auth, user_agent)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (endpoint) do update set tenant_id = excluded.tenant_id, employee_id = excluded.employee_id,
           user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
        [me.tenantId, me.employeeId, me.userId, data.endpoint, data.p256dh, data.auth, (data.userAgent ?? '').slice(0, 300)]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'That did not work.' };
    }
  });

export const unsubscribePush = createServerFn({ method: 'POST' })
  .inputValidator((input: { endpoint: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    try {
      const me = await who();
      await getPool().query('delete from public.push_subscriptions where tenant_id = $1 and endpoint = $2', [me.tenantId, data.endpoint]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'That did not work.' };
    }
  });

export const testPush = createServerFn({ method: 'POST' })
  .handler(async (): Promise<Result<{ devices: number; sent: number }>> => {
    try {
      const me = await who();
      const r = await pushNow(me.tenantId, me.employeeId, {
        title: 'Notifications are on', body: 'Approvals and updates will arrive here, even with the app closed.', url: '/approvals', tag: 'test',
      });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'That did not work.' };
    }
  });
