import { useRouterState } from "@tanstack/react-router";

// Drawn over the current screen while a navigation is in flight, never
// instead of it. It used to be the router's defaultPendingComponent with
// defaultPendingMs: 0, which meant the root's beforeLoad (a session
// round trip to the server) put the root match into "pending" on every
// navigation — and a pending root renders its fallback in place of the
// whole app. Locally that was a flicker; on Vercel, a blank screen for as
// long as the request took.
export function PendingBar() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  if (!isLoading) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 9999,
        background: "linear-gradient(90deg, transparent, var(--color-brand-500, #4F46E5), transparent)",
        backgroundSize: "200% 100%",
        animation: "page-nav-bar 1s linear infinite",
      }}
    />
  );
}
