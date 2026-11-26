// =====================================================================
// Back from the identity provider: /auth/oidc/callback
//
// The provider says who this is; an existing, approved account here
// matching that person (OIDC_CLAIM, email by default) is signed in, as a
// password would sign it in. No account, no entry: SSO does not create
// accounts, which are still registered and approved by two people. An
// account with its own two-step sign-in is asked for its code unless the
// provider's own second step is trusted (OIDC_TRUST_MFA).
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { getPool } from "@/server/db";
import { oidcConfig, finishSignIn, OIDC_COOKIE } from "@/server/oidc";
import { accountById, accountRefusal, buildSession } from "@/server/identity";
import {
  SESSION_COOKIE, MFA_PENDING_COOKIE, cookieOptions, mfaPendingCookieOptions, nowSeconds, signMfaPending, signSession,
} from "@/server/auth";

function cookie(name: string, value: string, o: { maxAge?: number; secure?: boolean; path?: string }) {
  return `${name}=${value}; Path=${o.path ?? "/"}; HttpOnly; SameSite=Lax${o.maxAge ? `; Max-Age=${o.maxAge}` : ""}${o.secure ? "; Secure" : ""}`;
}
function go(location: string, cookies: string[] = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  headers.append("set-cookie", `${OIDC_COOKIE}=; Path=/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0`);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

export const Route = createFileRoute("/auth/oidc/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cfg = oidcConfig();
        if (!cfg) return go("/login");
        const url = new URL(request.url);
        const pending = /(?:^|;\s*)oidc_pending=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
        let who;
        try {
          who = await finishSignIn(cfg, pending, url.searchParams);
        } catch (err) {
          console.error("[oidc] callback", err instanceof Error ? err.message : err);
          return go("/login?sso=failed");
        }

        const client = await getPool().connect();
        try {
          const { rows: [match] } = await client.query(
            `select u.id from public.app_users u
               join public.tenants t on t.id = u.tenant_id and t.slug = $1
               left join public.employees e on e.tenant_id = u.tenant_id and e.employee_id = u.employee_id
              where lower(u.email) = lower($2) or lower(e.email) = lower($2) or lower(u.username) = lower($2)
                 or lower(u.username) = lower(split_part($2, '@', 1))
              order by (lower(coalesce(u.email, e.email, '')) = lower($2)) desc, u.created_at
              limit 1`, [cfg.tenant, who.claimValue]);
          const row = match ? await accountById(client, match.id) : null;
          const trail = (action: string, detail: string) => row?.tenant_id && client.query(
            `insert into public.activity_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
             values ($1, (select employee_id from public.employees where tenant_id = $1 and employee_id = $2), $3, 'app_user', $4, $5)`,
            [row.tenant_id, row.employee_id, action, row.id, detail]);
          if (!row) return go("/login?sso=no-account");
          const refusal = accountRefusal(row);
          if (refusal || row.locked_at) {
            await trail("sign_in_failed", `single sign-on refused for ${row.username}: ${refusal ?? "locked"}`);
            return go("/login?sso=refused");
          }
          // The account's own second step, unless the provider's counts.
          if (row.mfa_enabled && row.mfa_secret && !who.mfa) {
            return go("/login?code=1", [cookie(MFA_PENDING_COOKIE, await signMfaPending(row.id), mfaPendingCookieOptions)]);
          }
          // The provider keeps the password, so its age here does not apply.
          const session = await buildSession(client, row, { mfa: who.mfa, mustChangePassword: false });
          await client.query("update public.app_users set last_login_at = now(), failed_attempts = 0 where id = $1", [row.id]);
          await trail("signed_in", `${row.username} signed in through single sign-on${who.mfa ? " with the provider's two-step verification" : ""}`);
          const token = await signSession({ ...session, seen: nowSeconds() });
          return go(session.isStaff ? "/staff" : "/", [cookie(SESSION_COOKIE, token, cookieOptions)]);
        } finally {
          client.release();
        }
      },
    },
  },
});
