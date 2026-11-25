import {
  Outlet,
  Link,
  createRootRoute,
  redirect,
  HeadContent,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { CurrentUserProvider } from "@/contexts/CurrentUserContext";
import { currentSession, signOut, switchPersona } from "@/lib/auth-fn";
import { IdleWatcher } from "@/components/shell/IdleWatcher";
import { AppShell } from "@/components/shell/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { PendingBar } from "@/components/shell/PendingBar";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): { as?: string } => ({
    as: typeof search.as === "string" ? search.as : undefined,
  }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      // An app on a phone: installable, full screen, in the brand's colour.
      { name: "theme-color", content: "#4F46E5" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "Approvals" },
      { name: "application-name", content: "Approvals" },
      { title: "Admin Services Portal" },
      { name: "description", content: "Internal services portal for administrative requests and approvals" },
      { name: "author", content: "Admin Services Portal" },
      { property: "og:title", content: "Admin Services Portal" },
      { property: "og:description", content: "Internal services portal for administrative requests and approvals" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Admin Services Portal" },
      { name: "twitter:description", content: "Internal services portal for administrative requests and approvals" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  // Every route is behind sign-in except the sign-in page. Doing this
  // once at the root means a new screen is protected by existing rather
  // than by somebody remembering to add a guard to it.
  beforeLoad: async ({ location, search }) => {
    const onLogin = location.pathname === "/login";
    // Signed out for inactivity: make sure of it here, on the server,
    // rather than trust that the sign-out's cookie landed first — a
    // request still in flight could otherwise bounce the person straight
    // back into the session they were timed out of.
    if (onLogin && (location.search as { idle?: unknown }).idle) await signOut();
    let session = await currentSession();

    if (!session && !onLogin) {
      throw redirect({ to: "/login" });
    }
    if (session && onLogin) {
      throw redirect({ to: session.mustChangePassword ? "/account" : session.isStaff ? "/staff" : "/" });
    }

    // A first password, or one past its 90 days, is changed before
    // anything else. The server refuses every other request until then;
    // this sends the person to where they can do it.
    if (session?.mustChangePassword && location.pathname !== "/account") {
      throw redirect({ to: "/account" });
    }

    // ?as=EMP-0700 in a link acts as that persona, for an evaluation's
    // login. The server decides whether that is allowed and records it.
    if (session?.canSwitch && search.as && search.as !== session.employeeId) {
      const switched = await switchPersona({ data: { employeeId: search.as } });
      if (switched.ok) session = switched.session;
    }

    // A staff bookmark of the dashboard is a dashboard of zeroes.
    if (session?.isStaff && location.pathname === "/") {
      throw redirect({ to: "/staff" });
    }
    return { session };
  },
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <PendingBar />
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { session } = Route.useRouteContext();
  const isBuilder = pathname.startsWith("/builder");

  // The sign-in page is not part of the application chrome — no sidebar,
  // no top bar, nothing that implies you are already inside.
  if (pathname === "/login") {
    return (
      <>
        <Outlet />
        <Toaster />
      </>
    );
  }

  // Until a required password change is done the server answers nothing
  // else, so the screen is the account page alone, without the shell
  // that would be asking it for queues and notifications.
  if (session?.mustChangePassword) {
    return (
      <CurrentUserProvider session={session}>
        <IdleWatcher idleSeconds={session.idleSeconds} />
        <Outlet />
        <Toaster />
      </CurrentUserProvider>
    );
  }

  return (
    <CurrentUserProvider session={session ?? null}>
      <IdleWatcher idleSeconds={session?.idleSeconds ?? 300} />
      <AppShell hideTopBar={isBuilder} sidebarDefaultCollapsed={isBuilder} noScroll={isBuilder}>
        <div key={pathname} className="page-enter h-full">
          <Outlet />
        </div>
      </AppShell>
      <Toaster />
    </CurrentUserProvider>
  );
}
