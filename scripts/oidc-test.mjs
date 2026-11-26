// =====================================================================
// Single sign-on (src/server/oidc.ts) against a mock identity provider.
//
//   npm run test:oidc
//
// A provider on localhost publishes discovery, keys and a token endpoint
// that signs ID tokens. The flow is started, the browser's return is
// played back, and the token is checked: a good one signs in; a forged
// state, a token for another audience, one signed by somebody else, and
// one replayed for another sign-in are each refused.
// =====================================================================

import http from 'node:http';
import { createServer } from 'vite';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.JWT_SECRET ||= 'x'.repeat(48);
let failures = 0, passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  pass: ${label}`); }
  else { failures++; console.log(`  FAIL: ${label}${detail ? `  (${detail})` : ''}`); }
};

const { publicKey, privateKey } = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

let issuer = '';
let next = { aud: 'ams-client', key: privateKey, nonce: null, amr: ['pwd'] };
let lastCodeVerifier = null;
const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  if (url.pathname === '/.well-known/openid-configuration') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
  }
  if (url.pathname === '/jwks') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [jwk] })); }
  if (url.pathname === '/token') {
    let body = ''; for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    lastCodeVerifier = p.get('code_verifier');
    const id_token = await new SignJWT({ email: 'Nadia.Islam@example.com', nonce: next.nonce, amr: next.amr })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(next.aud).setSubject('u-1')
      .setIssuedAt().setExpirationTime('5m').sign(next.key);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ id_token, access_token: 'a', token_type: 'Bearer' }));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => idp.listen(0, '127.0.0.1', r));
issuer = `http://127.0.0.1:${idp.address().port}`;
process.env.OIDC_ISSUER = issuer;
process.env.OIDC_CLIENT_ID = 'ams-client';
process.env.OIDC_CLIENT_SECRET = 's3cret';
process.env.OIDC_TENANT = 'bkash';
process.env.OIDC_TRUST_MFA = '1';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const oidc = await vite.ssrLoadModule('/src/server/oidc.ts');
const cfg = oidc.oidcConfig();
check('configured from the environment', cfg?.issuer === issuer && cfg.tenant === 'bkash');

const back = (start, extra = {}) => {
  const sent = new URL(start.url);
  return new URLSearchParams({ code: 'c-1', state: sent.searchParams.get('state'), ...extra });
};

const start = await oidc.startSignIn(cfg, 'https://ams.example.com/auth/oidc/callback');
const sent = new URL(start.url);
check('sends the browser to the provider with PKCE (S256), a state and a nonce',
  sent.origin === issuer && sent.searchParams.get('code_challenge_method') === 'S256' && sent.searchParams.get('state') && sent.searchParams.get('nonce'));
next.nonce = sent.searchParams.get('nonce');

const ok = await oidc.finishSignIn(cfg, start.cookie, back(start)).catch((e) => e);
check('a good return signs in as the person in the token', ok?.claimValue === 'Nadia.Islam@example.com' && ok.subject === 'u-1', String(ok?.message ?? ''));
check('...having sent the PKCE verifier to the token endpoint', typeof lastCodeVerifier === 'string' && lastCodeVerifier.length >= 43);
check('...and without the provider\'s second step, it is not two-step sign-in', ok?.mfa === false);

next.amr = ['pwd', 'mfa'];
const withMfa = await oidc.finishSignIn(cfg, start.cookie, back(start)).catch((e) => e);
check('the provider\'s own second step counts when trusted', withMfa?.mfa === true);
next.amr = ['pwd'];

const forged = await oidc.finishSignIn(cfg, start.cookie, back(start, { state: 'not-the-state' })).then(() => null, (e) => e);
check('a forged state is refused', forged instanceof Error && /does not match/.test(forged.message));

const noCookie = await oidc.finishSignIn(cfg, undefined, back(start)).then(() => null, (e) => e);
check('a return with no sign-in started here is refused', noCookie instanceof Error);

next.aud = 'somebody-else';
const aud = await oidc.finishSignIn(cfg, start.cookie, back(start)).then(() => null, (e) => e);
check('a token issued for another application is refused', aud instanceof Error, String(aud?.message ?? ''));
next.aud = 'ams-client';

next.key = other.privateKey;
const forgedSig = await oidc.finishSignIn(cfg, start.cookie, back(start)).then(() => null, (e) => e);
check('a token signed by somebody else is refused', forgedSig instanceof Error, String(forgedSig?.message ?? ''));
next.key = privateKey;

const second = await oidc.startSignIn(cfg, 'https://ams.example.com/auth/oidc/callback');
const replay = await oidc.finishSignIn(cfg, second.cookie, back(second)).then(() => null, (e) => e);
check('a token minted for one sign-in is refused for another (nonce)', replay instanceof Error && /not issued for this sign-in/.test(replay.message));

const refusedByIdp = await oidc.finishSignIn(cfg, start.cookie, new URLSearchParams({ error: 'access_denied', error_description: 'User cancelled' })).then(() => null, (e) => e);
check('the provider\'s refusal is reported', refusedByIdp instanceof Error && /User cancelled/.test(refusedByIdp.message));

await vite.close();
idp.close();
if (failures) { console.log(`\n${failures} OIDC CHECK(S) FAILED`); process.exit(1); }
console.log(`\nALL OIDC CHECKS PASSED (${passed})`);
