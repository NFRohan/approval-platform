import {
  Outlet,
  Link,
  createRootRoute,
  HeadContent,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { useEffect } from "react";
import { CurrentUserProvider, USERS, useCurrentUser } from "@/contexts/CurrentUserContext";
import { AppShell } from "@/components/shell/AppShell";
import { Toaster } from "@/components/ui/sonner";

function UserSyncFromUrl({ as }: { as: string | undefined }) {
  const { setCurrentUser } = useCurrentUser();
  useEffect(() => {
    if (!as) return;
    const user = USERS.find((u) => u.employee_id === as);
    if (user) setCurrentUser(user);
  }, [as, setCurrentUser]);
  return null;
}

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
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Admin Services Portal" },
      { name: "description", content: "Internal services portal for administrative requests and approvals" },
      { name: "author", content: "the organisation" },
      { property: "og:title", content: "Admin Services Portal" },
      { property: "og:description", content: "Internal services portal for administrative requests and approvals" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Admin Services Portal" },
      { name: "twitter:description", content: "Internal services portal for administrative requests and approvals" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
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
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { as } = Route.useSearch();
  const isBuilder = pathname.startsWith("/builder");

  return (
    <CurrentUserProvider>
      <UserSyncFromUrl as={as} />
      <AppShell hideTopBar={isBuilder} sidebarDefaultCollapsed={isBuilder} noScroll={isBuilder}>
        <div key={pathname} className="page-enter h-full">
          <Outlet />
        </div>
      </AppShell>
      <Toaster />
    </CurrentUserProvider>
  );
}
