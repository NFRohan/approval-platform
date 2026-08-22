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
 * generator is predictable from its own output. Readable enough to send
 * in a message, long enough not to be the weak part.
 */
export function generatePassword(prefix = 'demo'): string {
  return `${prefix}-${randomBytes(4).toString('hex')}-${randomBytes(4).toString('hex')}`;
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

export async function signSession(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
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
