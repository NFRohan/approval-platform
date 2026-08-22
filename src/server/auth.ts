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

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== KEYLEN) return false;

  const derived = await scrypt(password, salt, KEYLEN);
  // Constant time: a comparison that returns early leaks how much of the
  // hash matched, one byte at a time.
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------

export type Session = {
  tenantId: string;
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
    if (!payload.tenantId || !payload.userId) return null;
    return {
      tenantId: String(payload.tenantId),
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
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: TTL_SECONDS,
};
