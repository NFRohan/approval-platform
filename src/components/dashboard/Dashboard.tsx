import { Link } from "@tanstack/react-router";
import { labelSubjects } from "@/lib/chain";
import {
  ArrowLeftRight,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  DoorOpen,
  FileText,
  Layers,
  TrendingUp,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { Avatar } from "@/components/shell/Avatar";
import { db } from "@/lib/db";

type StatusKey = "submitted" | "in_progress" | "on_hold" | "completed" | "cancelled";

const STATUS_MAP: Record<StatusKey, { l: string; bg: string; fg: string; bd: string }> = {
  submitted: { l: "Submitted", bg: "#EFF6FF", fg: "#1D4ED8", bd: "#BFDBFE" },
  in_progress: { l: "In Progress", bg: "#EEF2FF", fg: "#4338CA", bd: "#C7D2FE" },
  on_hold: { l: "On Hold", bg: "#FFFBEB", fg: "#B45309", bd: "#FDE68A" },
  completed: { l: "Completed", bg: "#F0FDF4", fg: "#15803D", bd: "#BBF7D0" },
  cancelled: { l: "Cancelled", bg: "#F4F4F5", fg: "#71717A", bd: "#E4E4E7" },
};

function StatusBadge({ status }: { status: StatusKey }) {
  const c = STATUS_MAP[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full whitespace-nowrap font-medium"
      style={{
        padding: "2px 9px",
        fontSize: 11.5,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
        lineHeight: 1.2,
      }}
    >
      <span className="rounded-full" style={{ width: 6, height: 6, background: c.fg }} />
      {c.l}
    </span>
  );
}

type Palette = "amber" | "blue" | "green" | "pink";
const PALETTES: Record<Palette, { bg: string; fg: string; bd: string }> = {
  amber: { bg: "#FFFBEB", fg: "#B45309", bd: "#FDE68A" },
  blue: { bg: "#EFF6FF", fg: "#1D4ED8", bd: "#BFDBFE" },
  green: { bg: "#F0FDF4", fg: "#15803D", bd: "#BBF7D0" },
  pink: { bg: "#FDE8F2", fg: "#C40F5E", bd: "#FBC5DF" },
};

type LiveStats = { pending: number; active: number; completedMonth: number; availableForms: number; overdue: number; onHold: number };

function useLiveStats(employeeId: string) {
  const [stats, setStats] = useState<LiveStats | null>(null);

  useEffect(() => {
    if (!employeeId) return;
    let cancel = false;
    (async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const [
        { count: pending },
        { count: overdue },
        { data: activeRows },
        { count: completedMonth },
        { count: availableForms },
      ] = await Promise.all([
        db.from("approval_requests").select("*", { count: "exact", head: true })
          .eq("approver_user_id", employeeId).eq("status", "pending"),
        db.from("approval_requests").select("*", { count: "exact", head: true })
          .eq("approver_user_id", employeeId).eq("status", "pending").lt("deadline_at", now.toISOString()),
        db.from("form_submissions").select("status")
          .eq("submitted_by", employeeId).in("status", ["submitted", "in_progress", "on_hold"]),
        db.from("form_submissions").select("*", { count: "exact", head: true })
          .eq("submitted_by", employeeId).eq("status", "completed").gte("submitted_at", monthStart),
        db.from("form_templates").select("*", { count: "exact", head: true }).eq("status", "published"),
      ]);

      if (cancel) return;
      const onHold = (activeRows ?? []).filter((r) => r.status === "on_hold").length;
      setStats({
        pending: pending ?? 0,
        active: (activeRows ?? []).length,
        completedMonth: completedMonth ?? 0,
        availableForms: availableForms ?? 0,
        overdue: overdue ?? 0,
        onHold,
      });
    })();
    return () => { cancel = true; };
  }, [employeeId]);

  return stats;
}

type Stat = { label: string; value: number; sub: string; color: Palette; Icon: LucideIcon; trend?: boolean };

function StatCard({ s, loading }: { s: Stat; loading?: boolean }) {
  const p = PALETTES[s.color];
  return (
    <div
      className="bg-white rounded-xl flex flex-col gap-3.5"
      style={{ border: "1px solid var(--color-zinc-200)", padding: 18, boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-zinc-500">{s.label}</span>
        <span className="inline-flex items-center justify-center rounded-lg" style={{ width: 30, height: 30, background: p.bg, color: p.fg, border: `1px solid ${p.bd}` }}>
          <s.Icon size={14} />
        </span>
      </div>
      <div className="font-bold text-zinc-900" style={{ fontSize: 30, letterSpacing: "-0.02em", lineHeight: 1 }}>
        {loading ? (
          <span className="inline-block rounded-md animate-pulse" style={{ width: 40, height: 30, background: "#F4F4F5" }} />
        ) : s.value}
      </div>
      <div className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: p.fg }}>
        {s.trend && <TrendingUp size={11} />}
        {s.sub}
      </div>
    </div>
  );
}

type Recent = { form: string; sub: string | null; date: string; status: StatusKey; next: string };

// ---------------------------------------------------------------------
// Both panels below used to be constants: four invented approvals and
// five invented submissions, with names and dates belonging to nobody.
// They sat directly beneath stat cards that were already live, so the
// numbers and the lists under them described different systems.
// ---------------------------------------------------------------------
function useRecentSubmissions(employeeId: string) {
  const [rows, setRows] = useState<Recent[] | null>(null);

  useEffect(() => {
    if (!employeeId) return;
    let cancel = false;
    (async () => {
      const { data: subs } = await db
        .from("form_submissions")
        .select("id, form_template_id, status, submitted_at")
        .eq("submitted_by", employeeId)
        .order("submitted_at", { ascending: false })
        .limit(5);
      const list = subs ?? [];

      const templateIds = Array.from(new Set(list.map((r) => r.form_template_id).filter(Boolean)));
      const names: Record<string, string> = {};
      if (templateIds.length) {
        const { data: forms } = await db
          .from("form_templates").select("id, name").in("id", templateIds);
        (forms ?? []).forEach((f) => { names[f.id] = f.name; });
      }

      // "Next action" is whoever the chain is waiting on. Anything
      // finished is waiting on nobody, and says so.
      const nextBy: Record<string, string> = {};
      if (list.length) {
        const { data: steps } = await db
          .from("approval_requests")
          .select("submission_id, approver_user_id, status")
          .in("submission_id", list.map((r) => r.id))
          .in("status", ["pending", "clarification"]);
        const approverIds = Array.from(new Set((steps ?? []).map((x) => x.approver_user_id).filter(Boolean)));
        const who: Record<string, string> = {};
        if (approverIds.length) {
          const { data: emps } = await db
            .from("employees").select("employee_id, name, designation").in("employee_id", approverIds);
          (emps ?? []).forEach((e) => { who[e.employee_id] = e.designation || e.name; });
        }
        (steps ?? []).forEach((x) => {
          if (!x.submission_id) return;
          nextBy[x.submission_id] = x.status === "clarification"
            ? `Clarification asked by ${who[x.approver_user_id] ?? x.approver_user_id}`
            : `Awaiting ${who[x.approver_user_id] ?? x.approver_user_id}`;
        });
      }

      if (cancel) return;
      setRows(list.map((r) => ({
        form: r.form_template_id ? (names[r.form_template_id] ?? "Submission") : "Submission",
        sub: null,
        date: r.submitted_at ? String(r.submitted_at).slice(0, 10) : "—",
        status: (r.status ?? "in_progress") as StatusKey,
        next: nextBy[r.id] ?? "—",
      })));
    })();
    return () => { cancel = true; };
  }, [employeeId]);

  return rows;
}

type PendingItem = { id: string; who: string; initials: string; what: string; due: string; overdue: boolean };

function usePendingForMe(employeeId: string) {
  const [rows, setRows] = useState<PendingItem[] | null>(null);

  useEffect(() => {
    if (!employeeId) return;
    let cancel = false;
    (async () => {
      const { data: steps } = await db
        .from("approval_requests")
        .select("id, subject_id, subject_type, submission_id, deadline_at")
        .eq("approver_user_id", employeeId)
        .eq("status", "pending")
        .order("deadline_at")
        .limit(5);
      const list = steps ?? [];
      const subjects = list.length ? await labelSubjects(list) : {};

      const requesterIds = Array.from(new Set(
        Object.values(subjects).map((v) => v.requester).filter(Boolean) as string[]));
      const people: Record<string, string> = {};
      if (requesterIds.length) {
        const { data: emps } = await db
          .from("employees").select("employee_id, name").in("employee_id", requesterIds);
        (emps ?? []).forEach((e) => { people[e.employee_id] = e.name; });
      }

      if (cancel) return;
      const today = new Date().toDateString();
      setRows(list.map((r) => {
        const info = r.subject_id ? subjects[r.subject_id] : undefined;
        const name = info?.requester ? (people[info.requester] ?? info.requester) : "—";
        const when = r.deadline_at ? new Date(r.deadline_at) : null;
        return {
          id: r.id,
          who: name,
          initials: name.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase() || "?",
          what: info?.label ?? "A request",
          due: !when ? "No deadline"
            : when.toDateString() === today ? "Today"
            : when.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          overdue: when ? when.getTime() < Date.now() : false,
        };
      }));
    })();
    return () => { cancel = true; };
  }, [employeeId]);

  return rows;
}

function RecentTable({ rows }: { rows: Recent[] | null }) {
  return (
    <div
      className="bg-white rounded-xl overflow-hidden"
      style={{ border: "1px solid var(--color-zinc-200)", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}
    >
      <div
        className="flex items-center justify-between border-b"
        style={{ padding: "14px 18px", borderColor: "var(--color-zinc-200)" }}
      >
        <div className="text-[14px] font-semibold text-zinc-900">My Recent Submissions</div>
        <Link to="/submissions" className="text-[12px] font-medium" style={{ color: "var(--color-brand-600)" }}>
          View all →
        </Link>
      </div>
      <div
        className="grid font-semibold uppercase text-zinc-500 border-b"
        style={{
          gridTemplateColumns: "2fr 1fr 1fr 2fr",
          gap: 16,
          padding: "10px 18px",
          fontSize: 10.5,
          letterSpacing: "0.06em",
          background: "var(--color-zinc-50)",
          borderColor: "var(--color-zinc-200)",
        }}
      >
        <span>Form</span>
        <span>Submitted</span>
        <span>Status</span>
        <span>Next action</span>
      </div>
      {rows === null && (
        <div style={{ padding: "18px", fontSize: 12.5, color: "var(--color-zinc-400)" }}>Loading…</div>
      )}
      {rows !== null && rows.length === 0 && (
        <div style={{ padding: "18px", fontSize: 12.5, color: "var(--color-zinc-400)" }}>
          Nothing submitted yet. Pick something from Available Forms.
        </div>
      )}
      {(rows ?? []).map((r, i) => (
        <div
          key={i}
          className="grid items-center cursor-pointer transition-colors hover:bg-zinc-50"
          style={{
            gridTemplateColumns: "2fr 1fr 1fr 2fr",
            gap: 16,
            padding: "14px 18px",
            borderBottom: i < (rows ?? []).length - 1 ? "1px solid var(--color-zinc-100)" : "none",
            fontSize: 13,
          }}
        >
          <div className="min-w-0">
            <div className="font-medium text-zinc-900">{r.form}</div>
            {r.sub && <div className="text-[11.5px] text-zinc-500 mt-0.5">{r.sub}</div>}
          </div>
          <div className="font-mono text-zinc-600" style={{ fontSize: 12 }}>
            {r.date}
          </div>
          <div>
            <StatusBadge status={r.status} />
          </div>
          <div
            style={{
              color: r.next === "—" ? "var(--color-zinc-400)" : "var(--color-zinc-500)",
              fontStyle: r.next === "—" ? "normal" : "italic",
              fontSize: 12.5,
            }}
          >
            {r.next}
          </div>
        </div>
      ))}
    </div>
  );
}

type QuickPalette = "blue" | "purple" | "orange" | "green" | "zinc" | "pink";
const QUICK_PAL: Record<QuickPalette, { bg: string; fg: string; bd: string }> = {
  blue: { bg: "#EFF6FF", fg: "#1D4ED8", bd: "#BFDBFE" },
  purple: { bg: "#FAF5FF", fg: "#6D28D9", bd: "#E9D5FF" },
  orange: { bg: "#FFF7ED", fg: "#C2410C", bd: "#FED7AA" },
  green: { bg: "#F0FDF4", fg: "#15803D", bd: "#BBF7D0" },
  zinc: { bg: "#F4F4F5", fg: "#52525B", bd: "#E4E4E7" },
  pink: { bg: "#FDE8F2", fg: "#C40F5E", bd: "#FBC5DF" },
};

const QUICK: { label: string; Icon: LucideIcon; color: QuickPalette }[] = [
  { label: "Gate Pass", Icon: DoorOpen, color: "blue" },
  { label: "Weekend Office Access", Icon: Building2, color: "purple" },
  { label: "Maintenance Request", Icon: Wrench, color: "orange" },
  { label: "Business Card", Icon: CreditCard, color: "green" },
  { label: "Movement Order", Icon: ArrowLeftRight, color: "zinc" },
  { label: "Event Venue Booking", Icon: Calendar, color: "pink" },
];

function QuickSubmit() {
  return (
    <div
      className="bg-white rounded-xl"
      style={{ border: "1px solid var(--color-zinc-200)", padding: 18, boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}
    >
      <div className="mb-3.5">
        <div className="text-[14px] font-semibold text-zinc-900">Quick Submit</div>
        <div className="text-[12px] text-zinc-500 mt-0.5">Frequently used forms</div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {QUICK.map((q) => {
          const p = QUICK_PAL[q.color];
          return (
            <button
              key={q.label}
              className="cursor-pointer rounded-[10px] bg-white flex flex-col gap-2.5 transition-all hover:shadow-md"
              style={{ padding: 14, border: "1px solid var(--color-zinc-200)" }}
            >
              <span
                className="inline-flex items-center justify-center rounded-full"
                style={{ width: 32, height: 32, background: p.bg, color: p.fg, border: `1px solid ${p.bd}` }}
              >
                <q.Icon size={15} />
              </span>
              <div className="text-[13px] font-medium text-zinc-900 text-left">{q.label}</div>
              <div className="text-[11px] text-zinc-400 text-left">Submit →</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}


function PendingApprovals({ pendingCount, rows }: { pendingCount: number; rows: PendingItem[] | null }) {
  return (
    <div
      className="bg-white rounded-xl overflow-hidden"
      style={{ border: "1px solid var(--color-zinc-200)", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}
    >
      <div
        className="flex items-center gap-2 border-b"
        style={{ padding: "14px 18px", borderColor: "var(--color-zinc-200)" }}
      >
        <span className="text-[14px] font-semibold text-zinc-900">Pending Your Approval</span>
        {pendingCount > 0 && (
          <span className="rounded-full font-semibold" style={{ padding: "1px 8px", fontSize: 11, background: "#FFFBEB", color: "#B45309", border: "1px solid #FDE68A" }}>
            {pendingCount}
          </span>
        )}
        <Link to="/approvals" className="ml-auto text-[12px] font-medium" style={{ color: "var(--color-brand-600)" }}>
          View queue →
        </Link>
      </div>
      {rows === null && (
        <div style={{ padding: "18px", fontSize: 12.5, color: "var(--color-zinc-400)" }}>Loading…</div>
      )}
      {rows !== null && rows.length === 0 && (
        <div style={{ padding: "18px", fontSize: 12.5, color: "var(--color-zinc-400)" }}>
          Nothing is waiting on you.
        </div>
      )}
      {(rows ?? []).map((p, i) => (
        <div
          key={p.id}
          className="flex items-center gap-3 flex-wrap"
          style={{
            padding: "14px 18px",
            borderBottom: i < (rows ?? []).length - 1 ? "1px solid var(--color-zinc-100)" : "none",
          }}
        >
          <Avatar initials={p.initials} size={32} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-zinc-900">{p.who}</div>
            <div className="text-[11.5px] text-zinc-500 mt-0.5">{p.what}</div>
          </div>
          <div
            className="whitespace-nowrap"
            style={{
              fontSize: 11,
              color: p.overdue || p.due === "Today" ? "#B45309" : "var(--color-zinc-500)",
              fontWeight: p.overdue || p.due === "Today" ? 600 : 400,
            }}
          >
            {p.overdue ? "Overdue: " : "Due: "}{p.due}
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button
              className="cursor-pointer rounded-md font-medium bg-white"
              style={{ padding: "4px 10px", fontSize: 11.5, color: "#C40F5E", border: "1px solid #FBC5DF" }}
            >
              Approve
            </button>
            <button
              className="cursor-pointer rounded-md font-medium bg-white"
              style={{ padding: "4px 10px", fontSize: 11.5, color: "#B91C1C", border: "1px solid #FECACA" }}
            >
              Reject
            </button>
            <button
              className="cursor-pointer rounded-md font-medium bg-white"
              style={{ padding: "4px 10px", fontSize: 11.5, color: "#52525B", border: "1px solid #E4E4E7" }}
            >
              Clarify
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Dashboard() {
  const { currentUser } = useCurrentUser();
  const firstName = currentUser.name.split(" ")[0];
  const liveStats = useLiveStats(currentUser.employee_id);
  const recents = useRecentSubmissions(currentUser.employee_id);
  const pendingForMe = usePendingForMe(currentUser.employee_id);
  const loading = liveStats === null;

  const stats: Stat[] = [
    { label: "Pending Approvals", value: liveStats?.pending ?? 0, sub: liveStats?.overdue ? `${liveStats.overdue} overdue` : "Up to date", color: "amber", Icon: Clock },
    { label: "My Active Submissions", value: liveStats?.active ?? 0, sub: liveStats?.onHold ? `${liveStats.onHold} on hold` : "All in progress", color: "blue", Icon: FileText },
    { label: "Completed This Month", value: liveStats?.completedMonth ?? 0, sub: "This month", color: "green", Icon: CheckCircle2, trend: true },
    { label: "Forms I Can Submit", value: liveStats?.availableForms ?? 0, sub: "Published forms", color: "pink", Icon: Layers },
  ];

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", padding: "32px 28px 56px" }}>
      <div className="mb-6">
        <h1 className="text-zinc-900 font-bold m-0" style={{ fontSize: 26, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
          Good morning, {firstName} 👋
        </h1>
        <p className="text-zinc-500 m-0 mt-1.5" style={{ fontSize: 14 }}>
          {loading ? (
            <span className="inline-block rounded animate-pulse" style={{ width: 280, height: 16, background: "#F4F4F5" }} />
          ) : (
            <>
              You have{" "}
              <strong className="text-zinc-900">{liveStats.pending} pending approval{liveStats.pending !== 1 ? "s" : ""}</strong>{" "}
              and <strong className="text-zinc-900">{liveStats.active} active submission{liveStats.active !== 1 ? "s" : ""}</strong>.
            </>
          )}
        </p>
      </div>

      <div className="grid mb-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        {stats.map((s) => <StatCard key={s.label} s={s} loading={loading} />)}
      </div>

      <div className="mb-6">
        <RecentTable rows={recents} />
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
        <QuickSubmit />
        <PendingApprovals pendingCount={liveStats?.pending ?? 0} rows={pendingForMe} />
      </div>
    </div>
  );
}
