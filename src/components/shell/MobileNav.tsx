// =====================================================================
// The phone's navigation: a tab bar along the bottom, where a thumb
// reaches, for what people do most — home, approvals (with the count
// waiting), their requests, trackers — and "More" for everything else,
// which opens the full menu as a drawer. Shown below the md breakpoint
// only; on a laptop the sidebar does this job.
// =====================================================================

import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ClipboardList, Clock, Home, LayoutGrid, Layers, X } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { Sidebar } from "./Sidebar";

export const TAB_BAR_HEIGHT = 60;

export function MobileNav() {
  const { currentUser } = useCurrentUser();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(0);

  // Whatever is tapped in the drawer, it closes once the page changes.
  useEffect(() => { setMore(false); }, [pathname]);

  useEffect(() => {
    let alive = true;
    const count = async () => {
      const { count: n } = await db.from("approval_requests").select("id", { count: "exact", head: true })
        .eq("approver_user_id", currentUser.employee_id).eq("status", "pending");
      if (alive) setPending(n ?? 0);
    };
    void count();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void count(); }, 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [currentUser.employee_id, pathname]);

  const tabs = [
    { to: "/", label: "Home", Icon: Home, active: pathname === "/" },
    { to: "/approvals", label: "Approvals", Icon: Clock, active: pathname.startsWith("/approvals"), badge: pending },
    { to: "/submissions", label: "Requests", Icon: Layers, active: pathname.startsWith("/submissions") || pathname.startsWith("/status") || pathname.startsWith("/forms") },
    { to: "/trackers", label: "Trackers", Icon: ClipboardList, active: pathname.startsWith("/trackers") },
  ];

  return (
    <>
      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-40 bg-white flex items-stretch"
        style={{ borderTop: "1px solid var(--color-zinc-200)", height: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))`, paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Main"
        data-testid="tab-bar"
      >
        {tabs.map(({ to, label, Icon, active, badge }) => (
          <Link
            key={to}
            to={to}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 relative"
            style={{ color: active ? "var(--color-brand-600)" : "var(--color-zinc-500)", textDecoration: "none", fontSize: 11, fontWeight: active ? 600 : 500 }}
            aria-current={active ? "page" : undefined}
          >
            <span className="relative">
              <Icon size={21} strokeWidth={active ? 2.3 : 1.9} />
              {!!badge && (
                <span
                  className="absolute rounded-full text-white font-semibold inline-flex items-center justify-center"
                  style={{ top: -5, right: -10, minWidth: 17, height: 17, padding: "0 4px", fontSize: 10, background: "var(--color-brand-500)", border: "2px solid #fff" }}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </span>
            {label}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setMore(true)}
          className="flex-1 flex flex-col items-center justify-center gap-0.5"
          style={{ color: more ? "var(--color-brand-600)" : "var(--color-zinc-500)", fontSize: 11, fontWeight: 500, background: "none", border: "none" }}
          aria-label="More"
          aria-expanded={more}
        >
          <LayoutGrid size={21} strokeWidth={1.9} />
          More
        </button>
      </nav>

      {more && (
        <div className="md:hidden fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="h-full flex flex-col" style={{ width: "min(86vw, 300px)" }}>
            <Sidebar mobile />
          </div>
          <button
            type="button"
            className="flex-1"
            onClick={() => setMore(false)}
            aria-label="Close the menu"
            style={{ background: "rgba(24, 24, 27, 0.45)", border: "none", position: "relative" }}
          >
            <span className="absolute inline-flex items-center justify-center rounded-full bg-white"
              style={{ top: "calc(14px + env(safe-area-inset-top))", left: 12, width: 34, height: 34 }}>
              <X size={18} />
            </span>
          </button>
        </div>
      )}
    </>
  );
}
