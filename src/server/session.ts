// =====================================================================
// The session for the request in hand.
//
// This is its own file rather than a helper in auth-fn.ts because of the
// import guard: anything exported from a file the client imports must
// not *use* server-only modules outside a server-function handler, or
// the import survives into the browser graph and the build refuses it.
// Handlers import this; the client never does.
// =====================================================================

import { getCookie } from '@tanstack/react-start/server';
import { SESSION_COOKIE, verifySession, type Session } from './auth';

export async function sessionFromCookie(): Promise<Session | null> {
  return verifySession(getCookie(SESSION_COOKIE));
}
