// =====================================================================
// Passwords and sessions.
//
// Lives under src/server/ so the import guard keeps it off the client
// entirely — nothing here should ever appear in a browser bundle.
//
// Two deliberate choices:
//
//   * scrypt rather than a fast hash. Password hashing is supposed to be
//     slow; SHA-256 is the wrong tool because it is fast, which is the
//     attacker's advantage. Node ships scrypt, so there is no dependency
//     to add and nothing to get wrong.
//
//   * The session names the tenant. Row-level security decides what a
//     request can see from app.tenant_id, and that value now comes from
//     a signed token rather than from configuration — so a client still
//     cannot choose its own tenant, and the guarantee that held before
//     sign-in existed holds after it.
// =====================================================================

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
export const SESSION_COOKIE = 'admin_session';

// ---------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------

/** `scrypt$<salt-hex>$<hash-hex>` — self-describing, so the format can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Always derives, even when the stored value is unusable.
 *
 * The sign-in path hands this a fake hash when no such user exists, so
 * that a missing username costs the same as a wrong password. Returning
 * early on a malformed hash defeated that completely: the missing-user
 * path skipped scrypt and came back in microseconds, which is exactly
 * the difference it was supposed to hide.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored ?? '').split('$');
  const usable = parts.length === 3 && parts[0] === 'scrypt';

  const salt = usable ? Buffer.from(parts[1], 'hex') : Buffer.alloc(16);
  const expected = usable ? Buffer.from(parts[2], 'hex') : Buffer.alloc(KEYLEN);

  // Derive first, decide afterwards. The work happens either way.
  const derived = await scrypt(password, salt.length ? salt : Buffer.alloc(16), KEYLEN);
  if (!usable || expected.length !== KEYLEN) return false;

  // Constant time: a comparison that returns early leaks how much of the
  // hash matched, one byte at a time.
  return timingSafeEqual(derived, expected);
}

/**
 * A password to hand somebody, generated rather than chosen.
 *
 * randomBytes, not Math.random — these gate a public URL, and V8's
 * generator is predictable from its own output. Four groups of four from
 * an alphabet without look-alikes, joined by dashes: readable enough to
 * send in a message, and it meets the password policy (upper, lower,
 * digit, special, 19 characters) every time rather than usually.
 */
const READABLE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword(): string {
  for (;;) {
    const bytes = randomBytes(16);
    const chars = Array.from(bytes, (b) => READABLE[b % READABLE.length]).join('');
    const out = chars.match(/.{4}/g)!.join('-');
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /[0-9]/.test(out)) return out;
  }
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------

export type Session = {
  /**
   * Null for staff, and that is the schema's rule rather than an
   * oversight: app_users_tenancy_rule requires a staff account to have
   * no tenant, so that it cannot be read into one. Typing this as
   * `string` is what let a staff session be issued and then rejected on
   * the very next request.
   */
  tenantId: string | null;
  tenantSlug: string;
  userId: string;
  username: string;
  role: string;
  isStaff: boolean;
  mustChangePassword: boolean;
  /** When the evaluation itself runs out, which is not the same as the token. */
  tenantExpiresAt: string | null;
  /**
   * Who is acting. A person's own account is linked to their employee
   * record and always acts as them; an evaluation's login acts as one
   * persona at a time. Null for staff.
   */
  employeeId: string | null;
  personaName: string | null;
  personaTitle: string | null;
  /** May this login act as somebody else? Evaluation logins only. */
  canSwitch: boolean;
  /** What the acting employee's roles grant, as of the last time the session was issued. */
  permissions: string[];
  /** Did this session pass two-step sign-in? */
  mfa: boolean;
  /** Does the organisation require two-step sign-in to administer? */
  requireAdminMfa: boolean;
  /** Epoch seconds of the last request, for the idle timeout. */
  seen: number;
  /**
   * Epoch seconds the session began. Reissuing it on activity keeps this,
   * so the 12-hour limit is absolute rather than sliding.
   */
  born?: number;
};

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET is missing or shorter than 32 characters');
  }
  return new TextEncoder().encode(value);
}

/**
 * Sessions are short by design. A demo login that lasts a month is a
 * demo login somebody still has after the evaluation ended.
 */
const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 43_200); // 12h

/**
 * "Log out after 5 minutes of inactivity." A session not used for this
 * long is refused, whatever its expiry says. The browser signs out on its
 * own at the same moment; this is what holds when the tab was closed.
 */
export const IDLE_SECONDS = Number(process.env.SESSION_IDLE_SECONDS || 300);

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isIdle(session: Session, now = nowSeconds()): boolean {
  return now - session.seen > IDLE_SECONDS;
}

export async function signSession(session: Session): Promise<string> {
  const born = session.born ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ ...session, born })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(born + TTL_SECONDS)
    .sign(secret());
}

export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    // A session needs a user. It does not need a tenant — staff have
    // none by design, and requiring one made the staff console
    // unreachable: sign-in set a cookie that never verified, so every
    // request bounced back to the login screen.
    if (!payload.userId) return null;
    if (!payload.tenantId && payload.isStaff !== true) return null;
    return {
      tenantId: payload.tenantId ? String(payload.tenantId) : null,
      tenantSlug: String(payload.tenantSlug ?? ''),
      userId: String(payload.userId),
      username: String(payload.username ?? ''),
      role: String(payload.role ?? 'admin'),
      isStaff: payload.isStaff === true,
      mustChangePassword: payload.mustChangePassword === true,
      tenantExpiresAt: payload.tenantExpiresAt ? String(payload.tenantExpiresAt) : null,
      employeeId: payload.employeeId ? String(payload.employeeId) : null,
      personaName: payload.personaName ? String(payload.personaName) : null,
      personaTitle: payload.personaTitle ? String(payload.personaTitle) : null,
      canSwitch: payload.canSwitch === true,
      permissions: Array.isArray(payload.permissions) ? payload.permissions.map(String) : [],
      mfa: payload.mfa === true,
      requireAdminMfa: payload.requireAdminMfa === true,
      // A token without one predates the idle timeout; it counts as idle.
      seen: Number(payload.seen) || 0,
      born: Number(payload.born) || undefined,
    };
  } catch {
    // Expired, tampered with, or signed by a secret that has since been
    // rotated. All three mean the same thing to the caller: no session.
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  // Secure unless something says otherwise. Keying this off a positive
  // "is production" check meant any host that failed to set NODE_ENV
  // silently served the session cookie over plain HTTP.
  secure: process.env.NODE_ENV !== 'development',
  path: '/',
  maxAge: TTL_SECONDS,
};

// ---------------------------------------------------------------------
// Half-way through sign-in.
//
// The password was right and the account uses two-step sign-in. This
// short-lived token says only that, for which account; it opens nothing
// but the code check.
// ---------------------------------------------------------------------
export const MFA_PENDING_COOKIE = 'mfa_pending';
const MFA_PENDING_SECONDS = 300;

export async function signMfaPending(userId: string): Promise<string> {
  return new SignJWT({ userId, purpose: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MFA_PENDING_SECONDS}s`)
    .sign(secret());
}

export async function verifyMfaPending(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload.purpose === 'mfa' && payload.userId ? String(payload.userId) : null;
  } catch {
    return null;
  }
}

export const mfaPendingCookieOptions = { ...cookieOptions, maxAge: MFA_PENDING_SECONDS };
