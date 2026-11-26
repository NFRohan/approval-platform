// =====================================================================
// Single sign-on with OpenID Connect (SOW §4.9: "SSO ... ADFS / Azure AD").
//
// Beside the password and the LDAP bind, an organisation's identity
// provider (Entra ID, ADFS, Keycloak, Okta — anything that speaks OIDC)
// can sign people in: the authorization-code flow with PKCE, the ID
// token's signature checked against the provider's published keys, and
// its issuer, audience, expiry and nonce checked too. The person is
// matched to an existing, approved account by the claim named in
// OIDC_CLAIM (email by default): SSO proves who somebody is; whether they
// have an account here, and what they may do, is still decided here.
//
//   OIDC_ISSUER         https://login.microsoftonline.com/<tenant>/v2.0
//   OIDC_CLIENT_ID      the application's id at the provider
//   OIDC_CLIENT_SECRET  its secret (a confidential client)
//   OIDC_TENANT         the organisation here it signs into (its slug)
//   OIDC_LABEL          the button's words, e.g. "bKash account"
//   OIDC_CLAIM          email (default), preferred_username or upn
//   OIDC_TRUST_MFA      1: the provider's own second step (amr "mfa")
//                       counts as two-step sign-in here
// =====================================================================

import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';

export type OidcConfig = {
  issuer: string; clientId: string; clientSecret: string | null; tenant: string;
  label: string; claim: string; trustMfa: boolean;
};

export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.trim();
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  const tenant = process.env.OIDC_TENANT?.trim();
  if (!issuer || !clientId || !tenant) return null;
  return {
    issuer: issuer.replace(/\/$/, ''), clientId, clientSecret: process.env.OIDC_CLIENT_SECRET?.trim() || null, tenant,
    label: process.env.OIDC_LABEL?.trim() || 'your organisation account',
    claim: process.env.OIDC_CLAIM?.trim() || 'email',
    trustMfa: process.env.OIDC_TRUST_MFA === '1',
  };
}

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
const discovered = new Map<string, { at: number; doc: Discovery }>();
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The provider's endpoints, from its discovery document, kept for an hour. */
export async function discover(issuer: string): Promise<Discovery> {
  const hit = discovered.get(issuer);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`the identity provider's discovery document answered ${res.status}`);
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('the discovery document is incomplete');
  discovered.set(issuer, { at: Date.now(), doc });
  return doc;
}

const b64url = (b: Buffer) => b.toString('base64url');
function secretKey(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return new TextEncoder().encode(s);
}

export const OIDC_COOKIE = 'oidc_pending';

/** Where to send the browser, and the signed state to keep in a cookie until it comes back. */
export async function startSignIn(cfg: OidcConfig, redirectUri: string): Promise<{ url: string; cookie: string }> {
  const d = await discover(cfg.issuer);
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  const cookie = await new SignJWT({ state, nonce, verifier, redirectUri })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(secretKey());
  return { url: url.toString(), cookie };
}

/**
 * The browser is back with a code: check the state, exchange the code,
 * verify the ID token. Returns who the provider says this is.
 */
export async function finishSignIn(cfg: OidcConfig, pendingCookie: string | undefined, params: URLSearchParams):
  Promise<{ subject: string; claimValue: string; mfa: boolean; claims: JWTPayload }> {
  if (params.get('error')) throw new Error(`the identity provider refused: ${params.get('error_description') || params.get('error')}`);
  if (!pendingCookie) throw new Error('this sign-in has expired; start again');
  const { payload: pending } = await jwtVerify(pendingCookie, secretKey());
  if (!params.get('state') || params.get('state') !== pending.state) throw new Error('the sign-in does not match the one started here');
  const code = params.get('code');
  if (!code) throw new Error('the identity provider sent no code');

  const d = await discover(cfg.issuer);
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: String(pending.redirectUri),
    client_id: cfg.clientId, code_verifier: String(pending.verifier),
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  });
  const res = await fetch(d.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body, signal: AbortSignal.timeout(10_000),
  });
  const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !tokens.id_token) throw new Error(`the token exchange failed${tokens.error ? `: ${tokens.error}` : ''}`);

  let jwks = keySets.get(d.jwks_uri);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(d.jwks_uri)); keySets.set(d.jwks_uri, jwks); }
  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: d.issuer || cfg.issuer, audience: cfg.clientId, clockTolerance: 60 });
  if (payload.nonce !== pending.nonce) throw new Error('the ID token was not issued for this sign-in');

  const claimValue = String(payload[cfg.claim] ?? payload.email ?? payload.preferred_username ?? payload.upn ?? '').trim();
  if (!claimValue) throw new Error(`the ID token carries no ${cfg.claim}`);
  const amr = Array.isArray(payload.amr) ? payload.amr.map(String) : [];
  return { subject: String(payload.sub ?? ''), claimValue, mfa: cfg.trustMfa && amr.includes('mfa'), claims: payload };
}
