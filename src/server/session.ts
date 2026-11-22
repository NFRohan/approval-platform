// =====================================================================
// The session for the request in hand.
//
// This is its own file rather than a helper in auth-fn.ts because of the
// import guard: anything exported from a file the client imports must
// not *use* server-only modules outside a server-function handler, or
// the import survives into the browser graph and the build refuses it.
// Handlers import this; the client never does.
// =====================================================================

import { getCookie, setCookie, deleteCookie } from '@tanstack/react-start/server';
import {
  SESSION_COOKIE, IDLE_SECONDS, cookieOptions, isIdle, nowSeconds, signSession, verifySession, type Session,
} from './auth';

/** The session as the cookie has it, idle or not. */
export async function sessionFromCookie(): Promise<Session | null> {
  return verifySession(getCookie(SESSION_COOKIE));
}

/**
 * Reissuing on every request would sign a token per poll; once in a while
 * is enough — but well inside the idle limit, or a session in use could
 * lapse between two requests.
 */
const REFRESH_AFTER_SECONDS = Math.max(1, Math.min(30, Math.floor(IDLE_SECONDS / 4)));

/**
 * The session, if it is still live: not expired, not idle.
 *
 * `touch` says the request is somebody using the application — moving
 * between screens, or the browser reporting keys and clicks — and
 * restarts the idle clock. Data requests do not touch: the screens poll
 * in the background, and if polling counted as activity an open tab
 * would never time out. Nor could a sign-out be trusted, because a poll
 * already in flight would set the cookie again after it was deleted.
 *
 * An idle session is ended here rather than merely refused, so the next
 * page load lands on the sign-in screen instead of failing request by
 * request.
 */
export async function liveSession(opts: { touch?: boolean } = {}): Promise<Session | null> {
  const session = await sessionFromCookie();
  if (!session) return null;
  const now = nowSeconds();
  if (isIdle(session, now)) {
    deleteCookie(SESSION_COOKIE, { path: '/' });
    return null;
  }
  if (opts.touch && now - session.seen >= REFRESH_AFTER_SECONDS) {
    const fresh = { ...session, seen: now };
    setCookie(SESSION_COOKIE, await signSession(fresh), cookieOptions);
    return fresh;
  }
  return session;
}

/** Replace the session cookie, e.g. after switching persona or changing a password. */
export async function issueSession(session: Session): Promise<void> {
  setCookie(SESSION_COOKIE, await signSession({ ...session, seen: nowSeconds() }), cookieOptions);
}
