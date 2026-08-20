import * as React from "react";
import {
  Check,
  Clock,
  HelpCircle,
  Lock,
  Pause,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

export type StepState =
  | "completed"
  | "rejected"
  | "active"
  | "pending"
  | "on_hold"
  | "clarification"
  | "locked"
  | "idle";

interface StateConfig {
  label: string;
  Icon: LucideIcon;
  nodeBg: string;
  nodeFg: string;
  nodeBorder?: string;
  chipBg: string;
  chipFg: string;
  chipBorder: string;
  pulse?: boolean;
}

const STATE: Record<StepState, StateConfig> = {
  completed: {
    label: "Approved",
    Icon: Check,
    nodeBg: "#16A34A",
    nodeFg: "#fff",
    chipBg: "#F0FDF4",
    chipFg: "#15803D",
    chipBorder: "#BBF7D0",
  },
  rejected: {
    label: "Rejected",
    Icon: X,
    nodeBg: "#DC2626",
    nodeFg: "#fff",
    chipBg: "#FEF2F2",
    chipFg: "#B91C1C",
    chipBorder: "#FECACA",
  },
  active: {
    label: "Pending",
    Icon: Clock,
    nodeBg: "#FFFBEB",
    nodeFg: "#B45309",
    nodeBorder: "#D97706",
    chipBg: "#FFFBEB",
    chipFg: "#B45309",
    chipBorder: "#FDE68A",
    pulse: true,
  },
  pending: {
    label: "Pending",
    Icon: Clock,
    nodeBg: "#FFFBEB",
    nodeFg: "#B45309",
    nodeBorder: "#FDE68A",
    chipBg: "#FFFBEB",
    chipFg: "#B45309",
    chipBorder: "#FDE68A",
  },
  on_hold: {
    label: "On Hold",
    Icon: Pause,
    nodeBg: "#FEF3C7",
    nodeFg: "#9A3412",
    nodeBorder: "#FB923C",
    chipBg: "#FFF7ED",
    chipFg: "#C2410C",
    chipBorder: "#FED7AA",
  },
  clarification: {
    label: "Clarification requested",
    Icon: HelpCircle,
    nodeBg: "#FFF7ED",
    nodeFg: "#C2410C",
    nodeBorder: "#FB923C",
    chipBg: "#FFF7ED",
    chipFg: "#C2410C",
    chipBorder: "#FED7AA",
  },
  locked: {
    label: "Locked",
    Icon: Lock,
    nodeBg: "#F4F4F5",
    nodeFg: "#71717A",
    nodeBorder: "#E4E4E7",
    chipBg: "#F4F4F5",
    chipFg: "#52525B",
    chipBorder: "#E4E4E7",
  },
  idle: {
    label: "Not started",
    Icon: Clock,
    nodeBg: "#FAFAFA",
    nodeFg: "#A1A1AA",
    nodeBorder: "#E4E4E7",
    chipBg: "#FAFAFA",
    chipFg: "#71717A",
    chipBorder: "#E4E4E7",
  },
};

export interface Approver {
  name: string;
  title: string;
  dept?: string;
  initials: string;
  state: StepState;
  actionAt?: string;
  actionLabel?: string;
  comment?: string;
  deadline?: string;
}

export interface SingleStep {
  id: number;
  kind: "single";
  title: string;
  state: StepState;
  approver: Approver;
  actionAt?: string;
  actionLabel?: string;
  comment?: string;
  lockedReason?: string;
}

export interface ParallelStep {
  id: number;
  kind: "parallel";
  title: string;
  state: StepState;
  progress: { done: number; hold: number; pending: number; total: number };
  approvers: Approver[];
}

export type Step = SingleStep | ParallelStep;

function Avatar({ initials, size = 32 }: { initials: string; size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold shrink-0"
      style={{
        width: size,
        height: size,
        background: "#F4F4F5",
        color: "#3F3F46",
        fontSize: size <= 28 ? 10 : 11,
        letterSpacing: "0.02em",
        border: "1px solid #E4E4E7",
      }}
    >
      {initials}
    </span>
  );
}

export function StateChip({
  state,
  size = "sm",
}: {
  state: StepState;
  size?: "sm" | "md";
}) {
  const cfg = STATE[state] || STATE.idle;
  const { Icon } = cfg;
  const padY = size === "sm" ? 2 : 4;
  const padX = size === "sm" ? 8 : 10;
  const fs = size === "sm" ? 11.5 : 12.5;
  return (
    <span
      className="inline-flex items-center rounded-full whitespace-nowrap font-medium"
      style={{
        gap: 6,
        padding: `${padY}px ${padX}px`,
        fontSize: fs,
        lineHeight: 1.2,
        background: cfg.chipBg,
        color: cfg.chipFg,
        border: `1px solid ${cfg.chipBorder}`,
      }}
    >
      <Icon size={12} stroke={cfg.chipFg} />
      {cfg.label}
    </span>
  );
}

function StepNode({ state, n }: { state: StepState; n: number }) {
  const cfg = STATE[state] || STATE.idle;
  const { Icon } = cfg;
  const filled = state === "completed" || state === "rejected";
  return (
    <span
      className={cfg.pulse ? "approval-pulse-amber" : undefined}
      style={{
        width: 36,
        height: 36,
        borderRadius: 9999,
        background: cfg.nodeBg,
        color: cfg.nodeFg,
        border: cfg.nodeBorder ? `2px solid ${cfg.nodeBorder}` : "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        position: "relative",
        zIndex: 1,
      }}
    >
      {filled ? (
        <Icon size={18} stroke="#fff" strokeWidth={2.5} />
      ) : state === "locked" ? (
        <Lock size={15} stroke={cfg.nodeFg} />
      ) : (
        <span style={{ fontSize: 13, fontWeight: 600 }}>{n}</span>
      )}
    </span>
  );
}

function ApproverCard({ approver }: { approver: Approver }) {
  const cfg = STATE[approver.state] || STATE.idle;
  return (
    <div
      style={{
        border: `1px solid ${cfg.chipBorder}`,
        background: "#fff",
        borderRadius: 10,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minHeight: 178,
      }}
    >
      <div className="flex items-center gap-2.5">
        <Avatar initials={approver.initials} size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B", lineHeight: 1.2 }}>
            {approver.name}
          </div>
          <div style={{ fontSize: 11.5, color: "#71717A", marginTop: 2 }}>{approver.title}</div>
        </div>
      </div>

      {approver.dept && (
        <div
          style={{
            fontSize: 11,
            color: "#52525B",
            padding: "4px 8px",
            background: "#FAFAFA",
            borderRadius: 4,
            border: "1px solid #F4F4F5",
            width: "fit-content",
            maxWidth: "100%",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {approver.dept}
        </div>
      )}

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        <StateChip state={approver.state} />
        {approver.actionAt && (
          <div style={{ fontSize: 11, color: "#71717A", display: "flex", alignItems: "center", gap: 4 }}>
            <Clock size={11} stroke="#A1A1AA" /> {approver.actionAt}
          </div>
        )}
        {!approver.actionAt && approver.deadline && (
          <div style={{ fontSize: 11, color: "#A16207", display: "flex", alignItems: "center", gap: 4 }}>
            <Clock size={11} stroke="#A16207" /> Target {approver.deadline}
          </div>
        )}
        {approver.comment && (
          <div
            style={{
              fontSize: 11.5,
              color: "#9A3412",
              background: "#FFF7ED",
              border: "1px solid #FED7AA",
              borderRadius: 6,
              padding: "6px 8px",
              lineHeight: 1.45,
            }}
          >
            {approver.comment}
          </div>
        )}
      </div>
    </div>
  );
}

function SingleBody({ step }: { step: SingleStep }) {
  const cfg = STATE[step.state];
  const commentBg =
    step.state === "completed"
      ? { bg: "#F0FDF4", border: "#BBF7D0", color: "#166534" }
      : step.state === "rejected"
      ? { bg: "#FEF2F2", border: "#FECACA", color: "#991B1B" }
      : { bg: "#FFF7ED", border: "#FED7AA", color: "#9A3412" };

  return (
    <div
      style={{
        border: `1px solid ${cfg.chipBorder}`,
        background: step.state === "locked" ? "#FAFAFA" : "#fff",
        borderRadius: 10,
        padding: 16,
      }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <Avatar initials={step.approver.initials} size={36} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: step.state === "locked" ? "#71717A" : "#18181B",
              fontStyle: step.state === "locked" ? "italic" : "normal",
            }}
          >
            {step.approver.name}
          </div>
          <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>
            {step.approver.title}
            {step.approver.dept ? ` · ${step.approver.dept}` : ""}
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <StateChip state={step.state} />
        </div>
      </div>

      {step.actionAt && (
        <div
          className="flex items-center gap-2.5 flex-wrap"
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px solid #F4F4F5",
            fontSize: 12.5,
            color: "#52525B",
          }}
        >
          {step.actionLabel && (
            <>
              <span style={{ fontWeight: 500, color: "#18181B" }}>{step.actionLabel}</span>
              <span style={{ color: "#A1A1AA" }}>·</span>
            </>
          )}
          <span className="inline-flex items-center" style={{ gap: 4 }}>
            <Clock size={12} stroke="#A1A1AA" />
            {step.actionAt}
          </span>
        </div>
      )}

      {step.comment && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: commentBg.bg,
            border: `1px solid ${commentBg.border}`,
            borderRadius: 8,
            fontSize: 13,
            color: commentBg.color,
            lineHeight: 1.5,
          }}
        >
          “{step.comment}”
        </div>
      )}

      {step.lockedReason && (
        <div
          className="flex items-center gap-2"
          style={{ marginTop: 12, fontSize: 12.5, color: "#71717A", fontStyle: "italic" }}
        >
          <Lock size={13} stroke="#A1A1AA" />
          {step.lockedReason}
        </div>
      )}
    </div>
  );
}

function ParallelBody({ step }: { step: ParallelStep }) {
  const { progress, approvers } = step;
  return (
    <div>
      <div
        className="flex items-center justify-between gap-3 flex-wrap"
        style={{
          padding: "10px 14px",
          background: "#FFFBEB",
          border: "1px solid #FDE68A",
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
        }}
      >
        <div className="flex items-center gap-2">
          <Users size={14} stroke="#B45309" />
          <span style={{ fontSize: 12, fontWeight: 600, color: "#B45309", letterSpacing: "0.02em" }}>
            Parallel approval — all must approve
          </span>
        </div>
        <div className="flex items-center gap-3" style={{ fontSize: 11.5, color: "#92400E" }}>
          <span className="inline-flex items-center gap-1">
            <span style={{ width: 6, height: 6, borderRadius: 9999, background: "#16A34A" }} />
            {progress.done} approved
          </span>
          <span className="inline-flex items-center gap-1">
            <span style={{ width: 6, height: 6, borderRadius: 9999, background: "#FB923C" }} />
            {progress.hold} on hold
          </span>
          <span className="inline-flex items-center gap-1">
            <span style={{ width: 6, height: 6, borderRadius: 9999, background: "#D97706" }} />
            {progress.pending} pending
          </span>
        </div>
      </div>

      <div
        style={{
          height: 4,
          background: "#FEF3C7",
          borderLeft: "1px solid #FDE68A",
          borderRight: "1px solid #FDE68A",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
            background: "#16A34A",
          }}
        />
      </div>

      <div
        style={{
          border: "1px solid #FDE68A",
          borderTop: "none",
          borderBottomLeftRadius: 10,
          borderBottomRightRadius: 10,
          padding: 14,
          background: "#FFFEF7",
        }}
      >
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
        >
          {approvers.map((a, i) => (
            <ApproverCard key={i} approver={a} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TimelineStep({ step, isLast }: { step: Step; isLast: boolean }) {
  return (
    <div style={{ position: "relative", paddingLeft: 56, paddingBottom: isLast ? 0 : 28 }}>
      <div style={{ position: "absolute", left: 0, top: 0 }}>
        <StepNode state={step.state} n={step.id} />
      </div>
      {!isLast && (
        <div
          style={{ position: "absolute", left: 17, top: 36, bottom: 0, width: 2, background: "#E4E4E7" }}
        />
      )}

      <div className="flex items-center gap-2.5 flex-wrap" style={{ marginBottom: 10 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: "0.10em",
            textTransform: "uppercase",
            color: "#A1A1AA",
          }}
        >
          Step {step.id}
        </span>
        <span style={{ color: "#E4E4E7" }}>·</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>{step.title}</span>
        {step.kind === "parallel" && (
          <span
            className="inline-flex items-center gap-1"
            style={{
              fontSize: 11,
              color: "#B45309",
              fontWeight: 500,
              padding: "2px 8px",
              borderRadius: 9999,
              background: "#FFFBEB",
              border: "1px solid #FDE68A",
            }}
          >
            <Users size={11} stroke="#B45309" />
            {step.approvers.length} approvers
          </span>
        )}
      </div>

      {step.kind === "parallel" ? (
        <ParallelBody step={step} />
      ) : (
        <SingleBody step={step} />
      )}
    </div>
  );
}

export function ApprovalTimeline({ steps }: { steps: Step[] }) {
  return (
    <div>
      {steps.map((s, i) => (
        <TimelineStep key={s.id} step={s} isLast={i === steps.length - 1} />
      ))}
    </div>
  );
}
