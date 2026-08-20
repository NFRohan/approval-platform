import { useState } from "react";
import { Bell, ChevronRight, HelpCircle, Search } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { RoleSwitcher } from "./RoleSwitcher";

// =====================================================================
// The breadcrumb.
//
// It read "Home / Dashboard" on every screen, including the ones several
// levels down. A trail that never changes is worse than no trail: it
// tells you where you are and is wrong.
//
// Derived from the path rather than declared per route, so a new screen
// gets a correct crumb without anyone remembering to add one. Segments
// that are ids — the detail routes — are named after what they are
// rather than shown raw, because a uuid tells a reader nothing.
// =====================================================================
const SECTION: Record<string, string> = {
  "": "Dashboard",
  approvals: "Approvals",
  activity: "Activity Log",
  builder: "Form Builder",
  certificate: "Certificate",
  forms: "Available Forms",
  maintenance: "Maintenance",
  "movement-orders": "Movement Orders",
  notices: "Notice Board",
  stationery: "Stationery Requests",
  status: "Submission Status",
  submissions: "My Submissions",
};

const LEAF: Record<string, string> = {
  delegate: "Delegate Authority",
  history: "History",
  approvers: "Approvers",
  notifications: "Notifications",
  new: "New",
};

const IS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-|^d+$/i;

// Reached from a link, never from a list — so the id adds a crumb that
// says nothing and the section name already says it all.
const NO_INDEX = new Set(["status", "certificate"]);

/** What the identified thing is called on a detail route. */
const DETAIL: Record<string, string> = {
  notices: "Notice",
  forms: "Form",
  status: "Submission",
  certificate: "Certificate",
};

export function crumbsFor(pathname: string): Array<{ label: string; to?: string }> {
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return [{ label: "Dashboard" }];

  if (NO_INDEX.has(parts[0])) return [{ label: SECTION[parts[0]] ?? parts[0] }];

  const trail: Array<{ label: string; to?: string }> = [
    { label: SECTION[parts[0]] ?? parts[0], to: "/" + parts[0] },
  ];

  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    trail.push({
      label: IS_ID.test(seg)
        ? (DETAIL[parts[0]] ?? "Detail")
        : seg === "new"
          ? "New " + (DETAIL[parts[0]] ?? "item")
          : (LEAF[seg] ?? seg.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())),
      to: "/" + parts.slice(0, i + 1).join("/"),
    });
  }

  // The last crumb is where you already are, so it is not a link.
  delete trail[trail.length - 1].to;
  return trail;
}

function NotificationsDropdown({ onClose }: { onClose: () => void }) {
  const items = [
    {
      dot: "var(--color-brand-500)",
      text: (
        <>
          <strong>Ahmed Rahman's</strong> exit clearance is <strong>On Hold</strong> — Admin requested
          clarification
        </>
      ),
      when: "2 hrs ago",
    },
    {
      dot: "var(--color-success)",
      text: (
        <>
          Your <strong>Gate Pass</strong> request was approved by <strong>Karim</strong>
        </>
      ),
      when: "5 hrs ago",
    },
    {
      dot: "var(--color-zinc-400)",
      text: (
        <>
          New form template published: <strong>Stamp Seal Requisition v2</strong>
        </>
      ),
      when: "Yesterday",
    },
  ];
  return (
    <div
      className="absolute right-0 bg-white rounded-xl border z-50"
      style={{
        top: 44,
        width: 380,
        borderColor: "var(--color-zinc-200)",
        boxShadow: "0 12px 32px -8px rgba(0,0,0,0.18), 0 4px 8px -2px rgba(0,0,0,0.06)",
      }}
    >
      <div
        className="flex items-center justify-between border-b"
        style={{ padding: "12px 16px", borderColor: "var(--color-zinc-200)" }}
      >
        <div className="text-[13px] font-semibold text-zinc-900">3 new notifications</div>
        <button
          onClick={onClose}
          className="text-[11px] font-medium cursor-pointer"
          style={{ color: "var(--color-brand-600)" }}
        >
          Mark all read
        </button>
      </div>
      {items.map((n, i) => (
        <div
          key={i}
          className="flex gap-2.5 items-start"
          style={{
            padding: "12px 16px",
            borderBottom: i < 2 ? "1px solid var(--color-zinc-100)" : "none",
          }}
        >
          <span
            className="rounded-full shrink-0"
            style={{ width: 8, height: 8, background: n.dot, marginTop: 6 }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-zinc-700)" }}>
              {n.text}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">{n.when}</div>
          </div>
        </div>
      ))}
      <div
        className="text-center border-t"
        style={{ padding: "10px 16px", borderColor: "var(--color-zinc-200)" }}
      >
        <a href="#" className="text-[12px] font-medium" style={{ color: "var(--color-brand-600)" }}>
          View all notifications →
        </a>
      </div>
    </div>
  );
}

export function TopBar() {
  const [notifOpen, setNotifOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const crumbs = crumbsFor(pathname);

  return (
    <div
      className="h-16 shrink-0 flex items-center gap-6 bg-white border-b relative"
      style={{ padding: "0 28px", borderColor: "var(--color-zinc-200)" }}
    >
      <div className="flex items-center gap-2 shrink-0">
        <Link to="/" className="text-[11px] text-zinc-400 hover:text-zinc-600">
          Home
        </Link>
        {crumbs.map((crumb, i) => (
          <span key={crumb.label + i} className="flex items-center gap-2">
            <ChevronRight size={11} className="text-zinc-300" />
            {crumb.to ? (
              <Link to={crumb.to} className="text-[11px] text-zinc-400 hover:text-zinc-600">
                {crumb.label}
              </Link>
            ) : (
              <span className="text-[13px] font-semibold text-zinc-900">{crumb.label}</span>
            )}
          </span>
        ))}
      </div>

      <div
        className="flex-1 flex items-center gap-2.5 rounded-[10px]"
        style={{ maxWidth: 480, padding: "8px 14px", background: "var(--color-zinc-100)" }}
      >
        <Search size={14} className="text-zinc-500" />
        <input
          placeholder="Search submissions, forms, people…"
          className="flex-1 bg-transparent outline-none text-[13px] text-zinc-900 font-sans"
        />
        <kbd
          className="font-mono text-zinc-500 bg-white border rounded"
          style={{ fontSize: 10, padding: "2px 6px", borderColor: "var(--color-zinc-200)" }}
        >
          ⌘K
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-2 relative">
        <button
          onClick={() => setNotifOpen((v) => !v)}
          className="inline-flex items-center justify-center rounded-lg cursor-pointer relative"
          style={{ width: 36, height: 36 }}
        >
          <Bell size={16} style={{ color: "var(--color-zinc-700)" }} />
          <span
            className="absolute inline-flex items-center justify-center rounded-full text-white font-semibold border-2 border-white"
            style={{
              top: 4,
              right: 4,
              width: 16,
              height: 16,
              background: "var(--color-brand-500)",
              fontSize: 9.5,
            }}
          >
            3
          </span>
        </button>
        <button
          className="inline-flex items-center justify-center rounded-lg cursor-pointer"
          style={{ width: 36, height: 36 }}
        >
          <HelpCircle size={16} style={{ color: "var(--color-zinc-700)" }} />
        </button>
        <span className="mx-1" style={{ width: 1, height: 22, background: "var(--color-zinc-200)" }} />
        <RoleSwitcher />

        {notifOpen && <NotificationsDropdown onClose={() => setNotifOpen(false)} />}
      </div>
    </div>
  );
}
