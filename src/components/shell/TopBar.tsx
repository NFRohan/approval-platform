import { useCallback, useEffect, useState } from "react";
import { Bell, ChevronRight, HelpCircle, LogOut } from "lucide-react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { RoleSwitcher } from "./RoleSwitcher";
import { GlobalSearch } from "./GlobalSearch";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { currentSession, signOut, type PublicSession } from "@/lib/auth-fn";

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

// =====================================================================
// The bell.
//
// It said "3 new notifications" over three invented items, with a hard
// "3" on the badge — a count that was a character in a string, above a
// notifications table that has had rows in it all along.
//
// Nothing is delivered yet: no mail, no SMS. The dropdown says so rather
// than implying a channel that does not exist. Delivery is next sprint.
// =====================================================================
type Note = {
  id: string;
  kind: string | null;
  title: string | null;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

const DOT: Record<string, string> = {
  "submission.rejected": "var(--color-danger, #B91C1C)",
  "submission.approved": "var(--color-success)",
  "submission.completed": "var(--color-success)",
};

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function useNotifications(employeeId: string) {
  const [notes, setNotes] = useState<Note[] | null>(null);

  const load = useCallback(async () => {
    if (!employeeId) return;
    const { data } = await db
      .from("notifications")
      .select("id, kind, title, body, read_at, created_at")
      .eq("recipient_id", employeeId)
      .order("created_at", { ascending: false })
      .limit(10);
    setNotes((data ?? []) as Note[]);
  }, [employeeId]);

  useEffect(() => { void load(); }, [load]);

  const markAllRead = useCallback(async () => {
    const unread = (notes ?? []).filter((n) => !n.read_at);
    if (!unread.length) return;
    await db.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", unread.map((n) => n.id));
    await load();
  }, [notes, load]);

  const unread = (notes ?? []).filter((n) => !n.read_at).length;
  return { notes, unread, markAllRead };
}

function NotificationsDropdown({
  onClose, notes, unread, markAllRead,
}: {
  onClose: () => void;
  notes: Note[] | null;
  unread: number;
  markAllRead: () => void;
}) {
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
        <div className="text-[13px] font-semibold text-zinc-900">
          {notes === null ? "Notifications"
            : unread > 0 ? `${unread} unread`
            : "Nothing unread"}
        </div>
        <button
          onClick={() => { markAllRead(); onClose(); }}
          className="text-[11px] font-medium cursor-pointer"
          style={{ color: "var(--color-brand-600)" }}
        >
          Mark all read
        </button>
      </div>
      {notes !== null && notes.length === 0 && (
        <div style={{ padding: "16px", fontSize: 12.5, color: "var(--color-zinc-400)" }}>
          Nothing here yet.
        </div>
      )}
      {(notes ?? []).map((n, i) => (
        <div
          key={i}
          className="flex gap-2.5 items-start"
          style={{
            padding: "12px 16px",
            borderBottom: i < (notes ?? []).length - 1 ? "1px solid var(--color-zinc-100)" : "none",
            background: n.read_at ? "transparent" : "var(--color-zinc-50)",
          }}
        >
          <span
            className="rounded-full shrink-0"
            style={{
              width: 8, height: 8, marginTop: 6,
              background: n.read_at
                ? "var(--color-zinc-300)"
                : (DOT[n.kind ?? ""] ?? "var(--color-brand-500)"),
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-zinc-700)" }}>
              <strong>{n.title}</strong>
              {n.body ? <> — {n.body}</> : null}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">{ago(n.created_at)}</div>
          </div>
        </div>
      ))}
      <div
        className="text-center border-t"
        style={{ padding: "10px 16px", borderColor: "var(--color-zinc-200)" }}
      >
        <span className="text-[11.5px]" style={{ color: "var(--color-zinc-400)" }}>
          Shown here only — nothing is emailed or texted
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Who is signed in, how long the evaluation has left, and the way out.
//
// The countdown is here rather than tucked away because an evaluation
// that expires without warning reads as something breaking. Under a
// week it turns amber, which is the point at which somebody should be
// asking for an extension rather than discovering the problem.
// ---------------------------------------------------------------------
function AccountMenu() {
  const router = useRouter();
  const [session, setSession] = useState<PublicSession | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void currentSession().then((s) => { if (alive) setSession(s); });
    return () => { alive = false; };
  }, []);

  if (!session) return null;
  const soon = session.daysLeft !== null && session.daysLeft <= 7;

  return (
    <div className="flex items-center gap-2.5">
      <div className="text-right" style={{ lineHeight: 1.25 }}>
        <div className="text-[12px] font-medium text-zinc-900">{session.username}</div>
        {session.daysLeft !== null && (
          <div style={{ fontSize: 10.5, color: soon ? "#B45309" : "var(--color-zinc-400)" }}>
            {session.daysLeft === 0
              ? "expires today"
              : `${session.daysLeft} day${session.daysLeft === 1 ? "" : "s"} left`}
          </div>
        )}
      </div>
      <button
        onClick={async () => {
          setLeaving(true);
          await signOut();
          await router.invalidate();
          window.location.href = "/login";
        }}
        disabled={leaving}
        title="Sign out"
        className="inline-flex items-center justify-center rounded-lg cursor-pointer"
        style={{ width: 32, height: 32, border: "1px solid var(--color-zinc-200)", background: "#fff" }}
      >
        <LogOut size={14} style={{ color: "var(--color-zinc-600)" }} />
      </button>
    </div>
  );
}

export function TopBar() {
  const [notifOpen, setNotifOpen] = useState(false);
  const { currentUser } = useCurrentUser();
  const { notes, unread, markAllRead } = useNotifications(currentUser.employee_id);
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

      <GlobalSearch />

      <div className="ml-auto flex items-center gap-2 relative">
        <button
          onClick={() => setNotifOpen((v) => !v)}
          className="inline-flex items-center justify-center rounded-lg cursor-pointer relative"
          style={{ width: 36, height: 36 }}
        >
          <Bell size={16} style={{ color: "var(--color-zinc-700)" }} />
          {unread > 0 && <span
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
            {unread}
          </span>}
        </button>
        <button
          className="inline-flex items-center justify-center rounded-lg cursor-pointer"
          style={{ width: 36, height: 36 }}
        >
          <HelpCircle size={16} style={{ color: "var(--color-zinc-700)" }} />
        </button>
        <span className="mx-1" style={{ width: 1, height: 22, background: "var(--color-zinc-200)" }} />
        <RoleSwitcher />
        <span className="mx-1" style={{ width: 1, height: 22, background: "var(--color-zinc-200)" }} />
        <AccountMenu />

        {notifOpen && (
          <NotificationsDropdown
            onClose={() => setNotifOpen(false)}
            notes={notes}
            unread={unread}
            markAllRead={markAllRead}
          />
        )}
      </div>
    </div>
  );
}
