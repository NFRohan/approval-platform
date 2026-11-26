// =====================================================================
// Start single sign-on: /auth/oidc/start — off to the identity provider.
// See src/server/oidc.ts.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { oidcConfig, startSignIn, OIDC_COOKIE } from "@/server/oidc";
import { cookieOptions } from "@/server/auth";

export const Route = createFileRoute("/auth/oidc/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cfg = oidcConfig();
        if (!cfg) return new Response(null, { status: 302, headers: { location: "/login" } });
        const url = new URL(request.url);
        try {
          const { url: to, cookie } = await startSignIn(cfg, `${url.origin}/auth/oidc/callback`);
          return new Response(null, {
            status: 302,
            headers: {
              location: to,
              "set-cookie": `${OIDC_COOKIE}=${cookie}; Path=/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600${cookieOptions.secure ? "; Secure" : ""}`,
              "cache-control": "no-store",
            },
          });
        } catch (err) {
          console.error("[oidc] start", err instanceof Error ? err.message : err);
          return new Response(null, { status: 302, headers: { location: "/login?sso=unavailable" } });
        }
      },
    },
  },
});
