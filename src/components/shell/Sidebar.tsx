import { useEffect, useState, type SVGProps } from "react";
import { adminQueue } from "@/lib/admin-fn";
import { ADMIN_QUEUE_CHANGED } from "@/components/AdminQueue";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { signOut } from "@/lib/auth-fn";
import {
  LayoutDashboard,
  FileText,
  FileEdit,
  Clock,
  CheckCircle2,
  Layers,
  Activity,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  UserCog,
  Truck,
  Megaphone,
  Users,
  ShieldCheck,
  Network,
  BarChart3,
  FileSpreadsheet,
  Mail,
  Megaphone as CampaignIcon,
  type LucideIcon,
 Plug, ScrollText, CalendarDays, ListChecks, ClipboardList } from "lucide-react";
import { Avatar } from "./Avatar";
import { useCurrentUser, type CurrentUser } from "@/contexts/CurrentUserContext";
import { db } from "@/lib/db";

// A check, for a system whose whole job is sign-off. What was here was
// the client's own letterform, which recolouring would not have fixed.
export function BrandMark({ size = 34, style }: { size?: number; style?: SVGProps<SVGSVGElement>["style"] }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style={style} aria-label="Admin Services Portal">
      <rect width="100" height="100" rx="22" fill="#4F46E5"/>
      <path d="M28 52 L44 68 L74 32" fill="none" stroke="#fff"
            strokeWidth="11" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

type Item = {
  id: string;
  label: string;
  Icon: LucideIcon;
  to?: string;
  toParams?: Record<string, string>;
  badge?: string;
  accent?: boolean;
  liveBadgeKey?: "pendingApprovals";
};
type Section = { section: string; items: Item[] };

const DASHBOARD: Item = { id: "dash", label: "Dashboard", Icon: LayoutDashboard, to: "/" };

type NavCtx = {
  pendingCount: number;
  isApprover: boolean;
  /** Departments the campaign forms are offered to (they follow a rename). */
  campaignDepartments?: string[];
};

/** The approvals section, for anybody the chain actually asks. */
function approvalItems(ctx: NavCtx): Item[] {
  return [
    {
      id: "pending",
      label: "Pending Approvals",
      Icon: Clock,
      to: "/approvals",
      liveBadgeKey: "pendingApprovals",
      badge: ctx.pendingCount > 0 ? String(ctx.pendingCount) : undefined,
    },
    { id: "history", label: "Approval History", Icon: CheckCircle2, to: "/approvals/history" },
    { id: "delegate", label: "Delegation", Icon: UserCog, to: "/approvals/delegate" },
  ];
}

/** Raising something of your own. Approving is a job; it is not the only one. */
function ownRequestItems(ctx: NavCtx): Item[] {
  const items: Item[] = [
    { id: "available", label: "Available Forms", Icon: FileText, to: "/forms" },
    { id: "subs", label: "My Submissions", Icon: Layers, to: "/submissions" },
  ];
  return items;
}

const has = (sections: Section[], to: string) =>
  sections.some((s) => s.items.some((i) => i.to === to));

/**
 * The navigation for a persona, with three things guaranteed.
 *
 * The branches below were written per person, and being written per
 * person they were wrong for anybody they had not anticipated. Three
 * separate faults came out of that:
 *
 *   - only two branches listed the dashboard, so most personas could
 *     leave it with no route back short of the address bar;
 *   - the approvals section was gated on a hardcoded list of five ids,
 *     while the chain asks eight people. The Facilities Coordinator has
 *     a maintenance step waiting on him and the HR Business Partner
 *     approves leave — it had the screen that shows
 *     them, so those requests looked to everybody like they had vanished;
 *   - approvers had no way to raise anything of their own. Approving is
 *     a job, not a whole identity, and everybody takes leave.
 *
 * So the per-person branches decide the extras, and these three put back
 * whatever they left out. A sixth branch cannot reintroduce any of it.
 */
function buildNav(user: CurrentUser, ctx: NavCtx): Section[] {
  let sections = buildNavFor(user, ctx);

  // Whoever the chain actually asks gets the screen that shows it.
  if (ctx.isApprover && !has(sections, "/approvals")) {
    sections = [{ section: "Approvals", items: approvalItems(ctx) }, ...sections];
  }

  // Anybody can raise a request of their own.
  if (!has(sections, "/submissions")) {
    sections = [...sections, { section: "My Requests", items: ownRequestItems(ctx) }];
  }

  if (!has(sections, "/")) {
    const [first, ...rest] = sections;
    sections = [{ ...first, items: [DASHBOARD, ...first.items] }, ...rest];
  }

  // What somebody may administer comes from their roles, not from who
  // they are. The builder is for whoever designs workflows or changes
  // their task settings; the rest are for whoever holds the permission.
  const can = (p: string) => user.permissions.includes(p);
  const designs = can("forms.build") || can("forms.settings");
  sections = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.to !== "/builder" || designs) }))
    .filter((s) => s.items.length > 0);
  if (designs && !has(sections, "/builder")) {
    const [first, ...rest] = sections;
    sections = [{ ...first, items: [...first.items, { id: "builder", label: "Form Builder", Icon: FileEdit, to: "/builder" }] }, ...rest];
  }

  // Reports and analytics, for whoever reads them; campaigns, for them
  // and for the people who run and review campaigns.
  const insights: Item[] = [];
  if (can("reports.view") || can("reports.manage")) {
    insights.push({ id: "analytics", label: "Analytics", Icon: BarChart3, to: "/analytics" });
    insights.push({ id: "reports", label: "Reports", Icon: FileSpreadsheet, to: "/reports" });
  }
  // Campaigns, for oversight and for the departments the campaign forms are
  // offered to — read from the forms, not by name, so a renamed or merged
  // division keeps it.
  if (can("reports.view") || can("reports.manage") || (ctx.campaignDepartments ?? []).includes(user.department ?? "")) {
    insights.push({ id: "campaigns", label: "Campaigns", Icon: CampaignIcon, to: "/campaigns" });
  }
  // Trackers are for everybody: the main one, and the ones kept for them.
  insights.push({ id: "trackers", label: "Trackers", Icon: ClipboardList, to: "/trackers" });
  if (insights.length) sections = [...sections, { section: "Insights", items: insights }];

  const admin: Item[] = [];
  if (can("users.manage") || can("users.approve")) admin.push({ id: "users", label: "Users", Icon: Users, to: "/admin/users" });
  if (can("roles.manage") || can("roles.approve")) admin.push({ id: "roles", label: "Roles", Icon: ShieldCheck, to: "/admin/roles" });
  if (can("org.manage")) admin.push({ id: "people", label: "People & Directory", Icon: Network, to: "/admin/people" });
  if (can("org.manage")) admin.push({ id: "calendar", label: "Working Calendar", Icon: CalendarDays, to: "/admin/calendar" });
  if (can("org.manage") || can("forms.settings")) admin.push({ id: "checklists", label: "Clearance Checklists", Icon: ListChecks, to: "/admin/checklists" });
  if (can("notifications.manage") || can("audit.view")) admin.push({ id: "email", label: "Email", Icon: Mail, to: "/admin/email" });
  if (can("integrations.manage") || can("audit.view")) admin.push({ id: "integrations", label: "Integrations", Icon: Plug, to: "/admin/integrations" });
  if (can("audit.view") || can("records.manage")) admin.push({ id: "audit", label: "Audit Centre", Icon: ScrollText, to: "/admin/audit" });
  if (can("audit.view") && !has(sections, "/activity")) admin.push({ id: "activity", label: "Activity Log", Icon: Activity, to: "/activity" });
  if (admin.length) sections = [...sections, { section: "Administration", items: admin }];

  return sections;
}

function buildNavFor(user: CurrentUser, ctx: NavCtx): Section[] {
  // HR Business Partner — Nadia
  if (user.employee_id === "EMP-0201") {
    return [
      {
        section: "Forms",
        items: [
          { id: "dash", label: "Dashboard", Icon: LayoutDashboard, to: "/" },
          { id: "builder", label: "Form Builder", Icon: FileEdit, to: "/builder" },
          { id: "published", label: "Published Forms", Icon: Layers, to: "/forms" },
        ],
      },
      {
        section: "Operations",
        items: [
          { id: "movement", label: "Movement Orders", Icon: Truck, to: "/movement-orders" },
          { id: "notices", label: "Notice Board", Icon: Megaphone, to: "/notices" },
        ],
      },
    ];
  }

  // Departing Employee — Ahmed
  if (user.employee_id === "EMP-2847") {
    const items: Item[] = [
      { id: "available", label: "Available Forms", Icon: FileText, to: "/forms" },
      { id: "subs", label: "My Submissions", Icon: Layers, to: "/submissions" },
    ];
    return [
      { section: "My Requests", items },
      {
        section: "Operations",
        items: [
          { id: "movement", label: "Movement Orders", Icon: Truck, to: "/movement-orders" },
          { id: "notices", label: "Notice Board", Icon: Megaphone, to: "/notices" },
        ],
      },
    ];
  }

  // Admin Officer — Farzana (approver + movement order admin)
  if (user.employee_id === "EMP-0445") {
    return [
      {
        section: "Approvals",
        items: [
          {
            id: "pending",
            label: "Pending Approvals",
            Icon: Clock,
            to: "/approvals",
            liveBadgeKey: "pendingApprovals",
            badge: ctx.pendingCount > 0 ? String(ctx.pendingCount) : undefined,
          },
          {
            id: "history",
            label: "Approval History",
            Icon: CheckCircle2,
            to: "/approvals/history",
          },
          {
            id: "delegate",
            label: "Delegation",
            Icon: UserCog,
            to: "/approvals/delegate",
          },
        ],
      },
      {
        section: "Operations",
        items: [
          { id: "movement", label: "Movement Orders", Icon: Truck, to: "/movement-orders" },
          { id: "notices", label: "Notice Board", Icon: Megaphone, to: "/notices" },
          { id: "activity", label: "Activity Log", Icon: Activity, to: "/activity" },
        ],
      },
    ];
  }

  // Approvers whose whole job is the chain. Anybody else the chain asks
  // gets the same section added back above; this branch only decides that
  // it comes first for them.
  if (["EMP-1134", "EMP-0312", "EMP-0600", "EMP-0700"].includes(user.employee_id)) {
    return [
      {
        section: "Approvals",
        items: [
          {
            id: "pending",
            label: "Pending Approvals",
            Icon: Clock,
            to: "/approvals",
            liveBadgeKey: "pendingApprovals",
            badge: ctx.pendingCount > 0 ? String(ctx.pendingCount) : undefined,
          },
          {
            id: "history",
            label: "Approval History",
            Icon: CheckCircle2,
            to: "/approvals/history",
          },
          {
            id: "delegate",
            label: "Delegation",
            Icon: UserCog,
            to: "/approvals/delegate",
          },
        ],
      },
      {
        section: "Operations",
        items: [
          { id: "movement", label: "Movement Orders", Icon: Truck, to: "/movement-orders" },
          { id: "notices", label: "Notice Board", Icon: Megaphone, to: "/notices" },
        ],
      },
    ];
  }

  // Fallback — general employees can submit movement orders
  return [
    {
      section: "General",
      items: [
        { id: "dash", label: "Dashboard", Icon: LayoutDashboard, to: "/" },
        { id: "movement", label: "Movement Orders", Icon: Truck, to: "/movement-orders" },
        { id: "notices", label: "Notice Board", Icon: Megaphone, to: "/notices" },
      ],
    },
  ];
}

export function Sidebar({ defaultCollapsed = false, mobile = false }: { defaultCollapsed?: boolean; mobile?: boolean } = {}) {
  const [hover, setHover] = useState<string | null>(null);
  const [collapsedState, setCollapsed] = useState(defaultCollapsed);
  // In the phone's drawer the menu is always open, and fills it.
  const collapsed = mobile ? false : collapsedState;
  const [leaving, setLeaving] = useState(false);
  const { currentUser } = useCurrentUser();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const [pendingCount, setPendingCount] = useState(0);
  const [isApprover, setIsApprover] = useState(false);
  const [campaignDepartments, setCampaignDepartments] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void db.from("form_templates").select("audience_departments").ilike("name", "%Campaign%")
      .then(({ data }) => {
        if (!alive) return;
        const set = new Set<string>();
        for (const r of (data ?? []) as { audience_departments: string[] | null }[]) for (const d of r.audience_departments ?? []) set.add(d);
        setCampaignDepartments([...set]);
      });
    return () => { alive = false; };
  }, [currentUser.employee_id]);

  // Whether somebody approves anything is a question about the data, not
  // a list of ids kept in the interface. That list named five people; the
  // rules name eight, so three of them could not see their own queue.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ count: steps }, { data: ruled }, { data: slabbed }] = await Promise.all([
        db.from("approval_requests").select("id", { count: "exact", head: true })
          .eq("approver_user_id", currentUser.employee_id),
        db.from("approval_rules").select("id")
          .eq("approver_user_id", currentUser.employee_id).limit(1),
        db.from("approval_slabs").select("id")
          .eq("approver_user_id", currentUser.employee_id).limit(1),
      ]);
      if (!alive) return;
      // Named in a rule counts even before anything has reached them —
      // otherwise a new approver's queue is hidden until it is too late.
      setIsApprover((steps ?? 0) > 0 || (ruled ?? []).length > 0 || (slabbed ?? []).length > 0);
    })();
    return () => { alive = false; };
  }, [currentUser.employee_id]);

  // Live pending approval count.
  useEffect(() => {
    let active = true;
    const fetchCount = async () => {
      const { count } = await db
        .from("approval_requests")
        .select("id", { count: "exact", head: true })
        .eq("approver_user_id", currentUser.employee_id)
        .eq("status", "pending");
      if (active) setPendingCount(count ?? 0);
    };
    fetchCount();

    const channel = db
      .channel(`sidebar-approvals-${currentUser.employee_id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "approval_requests",
          filter: `approver_user_id=eq.${currentUser.employee_id}`,
        },
        () => {
          fetchCount();
        },
      )
      .subscribe();

    return () => {
      active = false;
      db.removeChannel(channel);
    };
  }, [currentUser.employee_id]);

  // What waits on them as an administrator: accounts, profiles, roles,
  // report columns (public.admin_queue). Counted with their steps, and
  // reason enough to show the queue to somebody no route names.
  const decides = ["users.approve", "roles.approve", "reports.manage"].some((p) => currentUser.permissions.includes(p));
  const [adminCount, setAdminCount] = useState(0);
  useEffect(() => {
    if (!decides) { setAdminCount(0); return; }
    let alive = true;
    const fetchAdmin = async () => {
      const r = await adminQueue();
      if (alive && r.ok) setAdminCount(r.items.length);
    };
    void fetchAdmin();
    const every = window.setInterval(fetchAdmin, 60_000);
    window.addEventListener(ADMIN_QUEUE_CHANGED, fetchAdmin);
    return () => { alive = false; window.clearInterval(every); window.removeEventListener(ADMIN_QUEUE_CHANGED, fetchAdmin); };
  }, [currentUser.employee_id, decides]);

  const nav = buildNav(currentUser, { pendingCount: pendingCount + adminCount, isApprover: isApprover || adminCount > 0, campaignDepartments });

  const isActive = (to?: string) => {
    if (!to) return false;
    if (to === "/") return pathname === "/";
    if (to === "/approvals") return pathname === "/approvals";
    // A request's own page is one of your submissions.
    if (to === "/submissions") return pathname.startsWith("/submissions") || pathname.startsWith("/status/");
    if (to.includes("$")) {
      const base = to.split("/$")[0];
      return pathname.startsWith(base);
    }
    return pathname === to || pathname.startsWith(to + "/");
  };

  return (
    <aside
      className="shrink-0 flex flex-col h-full text-white transition-all"
      style={{ width: mobile ? "100%" : collapsed ? 60 : 240, background: "var(--color-zinc-900)",
               paddingTop: mobile ? "env(safe-area-inset-top)" : undefined, paddingBottom: mobile ? "env(safe-area-inset-bottom)" : undefined }}
    >
      {/* logo + collapse toggle */}
      <div
        className="flex items-center border-b"
        style={{
          padding: collapsed ? "16px 12px" : "18px 16px 14px",
          borderColor: "var(--color-zinc-800)",
          gap: 10,
          justifyContent: collapsed ? "center" : "space-between",
        }}
      >
        {!collapsed && (
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark
              size={34}
              style={{
                borderRadius: 9,
                flexShrink: 0,
                boxShadow: "0 0 0 4px color-mix(in oklab, var(--color-brand-500) 15%, transparent)",
              }}
            />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-white truncate" style={{ letterSpacing: "-0.005em" }}>
                Admin Portal
              </div>
              <div className="text-[11px] mt-px truncate" style={{ color: "var(--color-zinc-400)" }}>
                Internal Services
              </div>
            </div>
          </div>
        )}
        {collapsed && (
          <BrandMark size={34} style={{ borderRadius: 9, flexShrink: 0 }} />
        )}
        {!collapsed && !mobile && (
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="inline-flex items-center justify-center rounded-md cursor-pointer shrink-0"
            style={{ width: 26, height: 26, color: "var(--color-zinc-400)" }}
          >
            <PanelLeftClose size={15} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="inline-flex items-center justify-center cursor-pointer mx-auto"
          style={{ width: 36, height: 32, marginTop: 6, color: "var(--color-zinc-400)" }}
        >
          <PanelLeftOpen size={15} />
        </button>
      )}

      {/* nav */}
      <nav className="scroll-thin scroll-dark flex-1 overflow-auto py-2">
        {nav.map((sec) => (
          <div key={sec.section} className="mb-2.5">
            {!collapsed && (
              <div
                className="px-[18px] pt-2.5 pb-1.5 text-[10px] font-semibold uppercase"
                style={{ letterSpacing: "0.10em", color: "var(--color-zinc-500)" }}
              >
                {sec.section}
              </div>
            )}
            {sec.items.map((it) => {
              const active = isActive(it.to);
              const isHover = hover === it.id;
              return (
                <button
                  key={it.id}
                  title={collapsed ? it.label : undefined}
                  onMouseEnter={() => setHover(it.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => {
                    if (!it.to) return;
                    if (it.toParams) {
                      navigate({ to: it.to as any, params: it.toParams as any });
                    } else {
                      navigate({ to: it.to });
                    }
                  }}
                  className="w-full box-border flex items-center gap-2.5 text-[13px] cursor-pointer transition-colors"
                  style={{
                    padding: collapsed ? "10px 0" : "8px 16px",
                    paddingLeft: collapsed ? 0 : active ? 13 : 16,
                    justifyContent: collapsed ? "center" : "flex-start",
                    color: active || isHover ? "#fff" : "var(--color-zinc-400)",
                    background: active
                      ? "color-mix(in oklab, var(--color-brand-500) 12%, transparent)"
                      : isHover
                        ? "var(--color-zinc-800)"
                        : "transparent",
                    borderLeft: collapsed
                      ? "none"
                      : `3px solid ${active ? "var(--color-brand-500)" : "transparent"}`,
                    fontWeight: active ? 500 : 400,
                    border: "none",
                    borderTop: "none",
                    borderRight: "none",
                    borderBottom: "none",
                  }}
                >
                  <span
                    className="inline-flex shrink-0"
                    style={{
                      color: it.accent
                        ? "var(--color-brand-500)"
                        : active || isHover
                          ? "#fff"
                          : "var(--color-zinc-400)",
                    }}
                  >
                    <it.Icon size={15} />
                  </span>
                  {!collapsed && (
                    <span
                      style={{
                        color: it.accent ? "var(--color-brand-500)" : "inherit",
                        fontWeight: it.accent ? 500 : "inherit",
                      }}
                    >
                      {it.label}
                    </span>
                  )}
                  {!collapsed && it.badge && (
                    <span
                      className="ml-auto rounded-full text-white font-semibold"
                      style={{
                        padding: "1px 7px",
                        fontSize: 10.5,
                        background: "var(--color-brand-500)",
                      }}
                    >
                      {it.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* user */}
      <div
        className="flex items-center border-t"
        style={{
          padding: collapsed ? "12px 0" : "12px 14px",
          borderColor: "var(--color-zinc-800)",
          gap: 10,
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
        <Avatar initials={currentUser.initials} size={32} brand />
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-white truncate">{currentUser.name}</div>
              <div className="text-[10.5px] truncate" style={{ color: "var(--color-zinc-400)" }}>
                {currentUser.designation}
              </div>
            </div>
            <button
              title="Logout"
              onClick={async () => {
                setLeaving(true);
                try { await signOut(); } finally { window.location.replace("/login"); }
              }}
              disabled={leaving}
              className="inline-flex items-center justify-center rounded-md cursor-pointer"
              style={{ width: 26, height: 26, opacity: leaving ? 0.5 : 1 }}
            >
              <LogOut size={14} style={{ color: "var(--color-zinc-400)" }} />
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
