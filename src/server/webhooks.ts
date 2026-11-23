// =====================================================================
// Webhook delivery.
//
// Events are queued in the database (app.emit_webhook, fired from the
// request's own history), and delivered from here: after any write, by
// the daily round, and on "Send a test" or "Redeliver".
//
// Each delivery is a POST of JSON with
//   X-AMS-Event        the event, e.g. request.completed
//   X-AMS-Delivery     this delivery's id — the same on a retry
//   X-AMS-Timestamp    seconds since 1970, when it was signed
//   X-AMS-Signature    sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">
// signed with the webhook's secret. A receiver recomputes the HMAC and
// compares in constant time, and refuses a timestamp more than five
// minutes old, so a captured delivery cannot be replayed later.
//
// Anything but a 2xx is a failure: tried again after one minute, then
// five, then marked failed for somebody to redeliver by hand.
// =====================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getPool } from './db';
import { appUrl } from './mailer';

export const SIGNATURE_TOLERANCE_SECONDS = 300;
const RETRY_MINUTES = [1, 5];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

export function signPayload(secret: string, timestamp: number, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** What a receiver does. Exported for the built-in receiver and the tests. */
export function verifySignature(
  secret: string, header: string | null, timestampHeader: string | null, body: string, now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!header || !timestampHeader) return { ok: false, reason: 'unsigned' };
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'unreadable timestamp' };
  if (Math.abs(now / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'too old' };
  const want = Buffer.from(signPayload(secret, ts, body));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got) ? { ok: true } : { ok: false, reason: 'signature does not match' };
}

/** A path ("/webhooks/echo") is this server; anything else is used as given. */
export function resolveTarget(url: string): string {
  return url.startsWith('/') ? appUrl() + url : url;
}

// An organisation's administrator chooses the address, and the answer is
// shown back to them, so a webhook must not be a way to reach the
// network this server sits on: loopback, private and link-local
// addresses — the cloud metadata service among them — are refused, by
// name and by what the name resolves to. WEBHOOK_ALLOW_PRIVATE=1 lifts
// it, for a test receiver on this machine.
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

export async function assertReachable(target: string, what = 'webhooks'): Promise<void> {
  if (process.env.WEBHOOK_ALLOW_PRIVATE === '1' || process.env.OUTBOUND_ALLOW_PRIVATE === '1') return;
  const u = new URL(target);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http and https addresses are called');
  if (target.startsWith(appUrl())) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`that address is on a private network, which ${what} may not call (OUTBOUND_ALLOW_PRIVATE=1 allows it)`);
  }
}

type Claimed = {
  id: string; tenant_id: string; event: string; payload: Record<string, unknown>; attempts: number;
  url: string; secret: string;
};

export async function drainWebhooks(opts: { tenantId?: string | null; limit?: number; only?: string } = {})
  : Promise<{ delivered: number; failed: number; retrying: number }> {
  const pool = getPool();
  const out = { delivered: 0, failed: 0, retrying: 0 };
  const { rows } = await pool.query(
    `update public.webhook_deliveries d set status = 'sending', attempts = d.attempts + 1
       from public.webhooks w
      where w.id = d.webhook_id
        and d.id in (select id from public.webhook_deliveries
                      where (status = 'queued' and next_attempt_at <= now()
                             -- A send that died part-way is tried again.
                             or status = 'sending' and next_attempt_at < now() - interval '10 minutes')
                        and ($1::uuid is null or tenant_id = $1)
                        and ($3::uuid is null or id = $3)
                      order by next_attempt_at limit $2 for update skip locked)
     returning d.id, d.tenant_id, d.event, d.payload, d.attempts, w.url, w.secret`,
    [opts.tenantId ?? null, opts.limit ?? 10, opts.only ?? null]);

  await Promise.all((rows as Claimed[]).map(async (d) => {
    const body = JSON.stringify({ id: d.id, ...d.payload });
    const timestamp = Math.floor(Date.now() / 1000);
    const started = Date.now();
    let status: number | null = null;
    let text = '';
    let error: string | null = null;
    try {
      await assertReachable(resolveTarget(d.url));
      const res = await fetch(resolveTarget(d.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'AMS-Webhooks/1.0',
          'x-ams-event': d.event,
          'x-ams-delivery': d.id,
          'x-ams-timestamp': String(timestamp),
          'x-ams-signature': signPayload(d.secret, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      status = res.status;
      text = (await res.text().catch(() => '')).slice(0, 500);
      if (status < 200 || status >= 300) error = `the receiver answered ${status}`;
    } catch (err) {
      error = err instanceof Error ? (err.name === 'TimeoutError' ? 'no answer within 8 seconds' : err.message) : String(err);
    }
    const ms = Date.now() - started;
    if (!error) {
      await pool.query(
        `update public.webhook_deliveries set status = 'delivered', response_status = $2, response_ms = $3,
                response_body = $4, error = null, delivered_at = now() where id = $1`,
        [d.id, status, ms, text]);
      out.delivered++;
    } else {
      const last = d.attempts >= MAX_ATTEMPTS;
      await pool.query(
        `update public.webhook_deliveries set status = $2, response_status = $3, response_ms = $4, response_body = $5,
                error = $6, next_attempt_at = now() + make_interval(mins => $7) where id = $1`,
        [d.id, last ? 'failed' : 'queued', status, ms, text || null, error.slice(0, 500),
         RETRY_MINUTES[Math.min(d.attempts - 1, RETRY_MINUTES.length - 1)]]);
      if (last) out.failed++; else out.retrying++;
    }
  }));
  return out;
}

/** After a write: deliver what it queued, if anything is due. Never fails the request. */
export async function kickWebhooks(tenantId: string | null | undefined): Promise<void> {
  if (!tenantId) return;
  try {
    const { rows } = await getPool().query(
      `select exists (select 1 from public.webhook_deliveries
                       where tenant_id = $1 and status = 'queued' and next_attempt_at <= now()) as any`, [tenantId]);
    if (rows[0]?.any) await drainWebhooks({ tenantId, limit: 10 });
  } catch (err) {
    console.error('[webhooks] kick failed', err instanceof Error ? err.message : err);
  }
}
