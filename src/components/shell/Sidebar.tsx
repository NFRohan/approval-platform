import { useEffect, useState, type SVGProps } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  FileText,
  FileEdit,
  Clock,
  CheckCircle2,
  Layers,
  Activity,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  UserCog,
  Truck,
  Megaphone,
  CreditCard,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { useCurrentUser, type CurrentUser } from "@/contexts/CurrentUserContext";
import { db } from "@/lib/db";

// A check, for a system whose whole job is sign-off. What was here was
// the client's own letterform, which recolouring would not have fixed.
function BrandMark({ size = 34, style }: { size?: number; style?: SVGProps<SVGSVGElement>["style"] }) {
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

function buildNav(
  user: CurrentUser,
  ctx: { activeSubmissionId: string | null; pendingCount: number },
): Section[] {
  // HR Business Partner — Nadia
  if (user.employee_id === "EMP-0201") {
    return [
      {
        section: "Forms",
        items: [
          { id: "dash", label: "Dashboard", Icon: LayoutDashboard, to: "/" },
          { id: "builder", label: "Form Builder", Icon: FileEdit, to: "/builder", accent: true },
          { id: "published", label: "Published Forms", Icon: Layers, to: "/forms" },
        ],
      },
      {
        section: "Operations",
        items: [
          { id: "movement", label: "Movement Orders", Icon: Truck, to: "/movement-orders" },
          { id: "notices", label: "Notice Board", Icon: Megaphone, to: "/notices" },
          { id: "stationery", label: "Stationery Requests", Icon: CreditCard, to: "/stationery" },
          { id: "maintenance", label: "Maintenance", Icon: Wrench, to: "/maintenance" },
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
    if (ctx.activeSubmissionId) {
      items.push({
        id: "tracker",
        label: "Status Tracker",
        Icon: Activity,
        to: "/status/$submissionId",
        toParams: { submissionId: ctx.activeSubmissionId },
      });
    }
    return [
      { section: "My Requests", items },
      {
        section: "Operations",
        items: [
          { id: "movement", label: "Movement Orders", Icon: Truck, to: "/movement-orders" },
          { id: "notices", label: "Notice Board", Icon: Megaphone, to: "/notices" },
          { id: "stationery", label: "Stationery Requests", Icon: CreditCard, to: "/stationery" },
          { id: "maintenance", label: "Maintenance", Icon: Wrench, to: "/maintenance" },
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
          { id: "stationery", label: "Stationery Requests", Icon: CreditCard, to: "/stationery" },
          { id: "maintenance", label: "Maintenance", Icon: Wrench, to: "/maintenance" },
          { id: "activity", label: "Activity Log", Icon: Activity, to: "/activity" },
        ],
      },
    ];
  }

  // Approvers — Sara, Rafiqul, and tier-2 approvers
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
          { id: "stationery", label: "Stationery Requests", Icon: CreditCard, to: "/stationery" },
          { id: "maintenance", label: "Maintenance", Icon: Wrench, to: "/maintenance" },
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
        { id: "stationery", label: "Stationery Requests", Icon: CreditCard, to: "/stationery" },
        { id: "maintenance", label: "Maintenance", Icon: Wrench, to: "/maintenance" },
      ],
    },
  ];
}

export function Sidebar({ defaultCollapsed = false }: { defaultCollapsed?: boolean } = {}) {
  const [hover, setHover] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const { currentUser } = useCurrentUser();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const [pendingCount, setPendingCount] = useState(0);
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);

  // Live pending approval count for approvers
  useEffect(() => {
    const isApprover = ["EMP-1134", "EMP-0312", "EMP-0445", "EMP-0600", "EMP-0700"].includes(
      currentUser.employee_id,
    );
    if (!isApprover) {
      setPendingCount(0);
      return;
    }
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

  // Active submission for departing employee → most recent non-completed
  useEffect(() => {
    if (currentUser.employee_id !== "EMP-2847") {
      setActiveSubmissionId(null);
      return;
    }
    let active = true;
    (async () => {
      const { data } = await db
        .from("form_submissions")
        .select("id, status, submitted_at")
        .eq("submitted_by", currentUser.employee_id)
        .not("status", "in", "(completed,rejected,cancelled)")
        .order("submitted_at", { ascending: false })
        .limit(1);
      if (active) setActiveSubmissionId(data?.[0]?.id ?? null);
    })();
    return () => {
      active = false;
    };
  }, [currentUser.employee_id]);

  const nav = buildNav(currentUser, { activeSubmissionId, pendingCount });

  const isActive = (to?: string) => {
    if (!to) return false;
    if (to === "/") return pathname === "/";
    if (to === "/approvals") return pathname === "/approvals";
    if (to.includes("$")) {
      const base = to.split("/$")[0];
      return pathname.startsWith(base);
    }
    return pathname === to || pathname.startsWith(to + "/");
  };

  return (
    <aside
      className="shrink-0 flex flex-col h-full text-white transition-all"
      style={{ width: collapsed ? 60 : 240, background: "var(--color-zinc-900)" }}
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
        {!collapsed && (
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
      <nav className="scroll-thin flex-1 overflow-auto py-2">
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
        <Avatar initials={currentUser.initials} size={32} pink />
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-white truncate">{currentUser.name}</div>
              <div className="text-[10.5px] truncate" style={{ color: "var(--color-zinc-400)" }}>
                {currentUser.designation}
              </div>
            </div>
            <button
              title="Settings"
              className="inline-flex items-center justify-center rounded-md cursor-pointer"
              style={{ width: 26, height: 26 }}
            >
              <Settings size={14} style={{ color: "var(--color-zinc-400)" }} />
            </button>
            <button
              title="Logout"
              className="inline-flex items-center justify-center rounded-md cursor-pointer"
              style={{ width: 26, height: 26 }}
            >
              <LogOut size={14} style={{ color: "var(--color-zinc-400)" }} />
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
