// =====================================================================
// Push notifications, to a phone or a browser the person turned them on
// in (the PWA: public/sw.js shows them).
//
// The server's own key pair (VAPID) is made the first time it is needed
// and kept in the database, the private half sealed — so a deployment
// needs no keys configured. Every notification the bell gets is queued
// for push too, by a trigger, when its recipient has a device; this
// sends the queue, and forgets a device the push service says is gone.
// =====================================================================

import webpush from 'web-push';
import { getPool } from './db';
import { openSecret, sealSecret } from './totp';

const SUBJECT = 'mailto:no-reply@approvals.local';
let cached: { publicKey: string; privateKey: string } | null = null;

export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (cached) return cached;
  const pool = getPool();
  let { rows: [k] } = await pool.query('select public_key, private_sealed from public.push_keys where id = 1');
  if (!k) {
    const made = webpush.generateVAPIDKeys();
    await pool.query(
      'insert into public.push_keys (id, public_key, private_sealed) values (1, $1, $2) on conflict (id) do nothing',
      [made.publicKey, sealSecret(made.privateKey)]);
    ({ rows: [k] } = await pool.query('select public_key, private_sealed from public.push_keys where id = 1'));
  }
  cached = { publicKey: k.public_key, privateKey: openSecret(k.private_sealed) ?? '' };
  return cached;
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

async function sendTo(sub: Sub, payload: Record<string, unknown>): Promise<'sent' | 'gone' | 'failed'> {
  const keys = await vapidKeys();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 86_400, timeout: 10_000 },
    );
    await getPool().query('update public.push_subscriptions set last_used_at = now(), failures = 0 where id = $1', [sub.id]);
    return 'sent';
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await getPool().query('delete from public.push_subscriptions where id = $1', [sub.id]);
      return 'gone';
    }
    await getPool().query('update public.push_subscriptions set failures = failures + 1 where id = $1', [sub.id]);
    console.error('[push] send failed', status ?? '', err instanceof Error ? err.message : err);
    return 'failed';
  }
}

/** Send what is queued, for one organisation or all. */
export async function drainPush(opts: { tenantId?: string | null } = {}): Promise<{ sent: number; failed: number }> {
  const pool = getPool();
  const out = { sent: 0, failed: 0 };
  for (let round = 0; round < 5; round++) {
    const { rows } = await pool.query(
      `update public.push_outbox o set status = 'sending'
        where o.id in (select id from public.push_outbox
                        where status = 'queued' and ($1::uuid is null or tenant_id = $1)
                        order by created_at limit 50 for update skip locked)
       returning o.id, o.tenant_id, o.employee_id, o.title, o.body, o.url, o.tag`, [opts.tenantId ?? null]);
    if (!rows.length) break;
    for (const r of rows) {
      const { rows: subs } = await pool.query<Sub>(
        'select id, endpoint, p256dh, auth from public.push_subscriptions where tenant_id = $1 and employee_id = $2', [r.tenant_id, r.employee_id]);
      let ok = 0;
      for (const s of subs) if ((await sendTo(s, { title: r.title, body: r.body, url: r.url, tag: r.tag })) === 'sent') ok++;
      await pool.query(`update public.push_outbox set status = $2, sent_at = now() where id = $1`, [r.id, ok || !subs.length ? 'sent' : 'failed']);
      if (ok) out.sent++; else if (subs.length) out.failed++;
    }
  }
  return out;
}

/** A notification straight to one person's devices, now. */
export async function pushNow(tenantId: string, employeeId: string, payload: { title: string; body: string; url: string; tag?: string }) {
  const { rows: subs } = await getPool().query<Sub>(
    'select id, endpoint, p256dh, auth from public.push_subscriptions where tenant_id = $1 and employee_id = $2', [tenantId, employeeId]);
  let sent = 0;
  for (const s of subs) if ((await sendTo(s, payload)) === 'sent') sent++;
  return { devices: subs.length, sent };
}

/** After a write: push what it queued, if anything. */
export async function kickPush(tenantId: string | null | undefined): Promise<void> {
  if (!tenantId) return;
  try {
    const { rows } = await getPool().query(
      `select exists (select 1 from public.push_outbox where tenant_id = $1 and status = 'queued') as any`, [tenantId]);
    if (rows[0]?.any) await drainPush({ tenantId });
  } catch (err) {
    console.error('[push] kick failed', err instanceof Error ? err.message : err);
  }
}
