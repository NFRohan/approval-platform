import * as React from "react";
import {
  Bell,
  CheckCircle2,
  Clock,
  FileEdit,
  Loader2,
  MinusCircle,
  PauseCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type StatusKey =
  | "draft"
  | "submitted"
  | "in_progress"
  | "on_hold"
  | "completed"
  | "rejected"
  | "cancelled"
  | "awaiting_action";

export type BadgeSize = "sm" | "md" | "lg";

interface StatusConfig {
  label: string;
  bg: string;
  text: string;
  border: string;
  dot: string;
  Icon: LucideIcon;
  spin?: boolean;
  pulseDot?: boolean;
}

const STATUS: Record<StatusKey, StatusConfig> = {
  draft: {
    label: "Draft",
    bg: "#F4F4F5",
    text: "#52525B",
    border: "#E4E4E7",
    dot: "#52525B",
    Icon: FileEdit,
  },
  submitted: {
    label: "Submitted",
    bg: "#EFF6FF",
    text: "#1D4ED8",
    border: "#BFDBFE",
    dot: "#1D4ED8",
    Icon: Clock,
  },
  in_progress: {
    label: "In Progress",
    bg: "#EEF2FF",
    text: "#4338CA",
    border: "#C7D2FE",
    dot: "#4338CA",
    Icon: Loader2,
    spin: true,
  },
  on_hold: {
    label: "On Hold",
    bg: "#FFFBEB",
    text: "#B45309",
    border: "#FDE68A",
    dot: "#D97706",
    Icon: PauseCircle,
    pulseDot: true,
  },
  completed: {
    label: "Completed",
    bg: "#F0FDF4",
    text: "#15803D",
    border: "#BBF7D0",
    dot: "#15803D",
    Icon: CheckCircle2,
  },
  rejected: {
    label: "Rejected",
    bg: "#FEF2F2",
    text: "#B91C1C",
    border: "#FECACA",
    dot: "#B91C1C",
    Icon: XCircle,
  },
  cancelled: {
    label: "Cancelled",
    bg: "#F4F4F5",
    text: "#71717A",
    border: "#E4E4E7",
    dot: "#71717A",
    Icon: MinusCircle,
  },
  awaiting_action: {
    label: "Awaiting Your Action",
    bg: "#FDE8F2",
    text: "#C40F5E",
    border: "#F79BC4",
    dot: "#4F46E5",
    Icon: Bell,
  },
};

const SIZE: Record<
  BadgeSize,
  { font: number; py: number; px: number; dot: number; gap: number; icon: number }
> = {
  sm: { font: 12, py: 2, px: 8, dot: 6, gap: 6, icon: 12 },
  md: { font: 14, py: 4, px: 10, dot: 7, gap: 6, icon: 14 },
  lg: { font: 14, py: 6, px: 12, dot: 8, gap: 8, icon: 16 },
};

export interface StatusBadgeProps {
  status: StatusKey;
  size?: BadgeSize;
  showDot?: boolean;
  showIcon?: boolean;
  className?: string;
}

export function StatusBadge({
  status,
  size = "md",
  showDot = true,
  showIcon = false,
  className,
}: StatusBadgeProps) {
  const cfg = STATUS[status];
  if (!cfg) return null;
  const s = SIZE[size];
  const { Icon } = cfg;

  return (
    <span
      className={cn("inline-flex items-center whitespace-nowrap rounded-full font-medium", className)}
      style={{
        gap: s.gap,
        padding: `${s.py}px ${s.px}px`,
        fontSize: s.font,
        lineHeight: 1.2,
        background: cfg.bg,
        color: cfg.text,
        border: `1px solid ${cfg.border}`,
      }}
    >
      {showDot && (
        <span
          className={cn("rounded-full shrink-0", cfg.pulseDot && "status-badge-pulse")}
          style={{ width: s.dot, height: s.dot, background: cfg.dot }}
        />
      )}
      {showIcon && Icon && (
        <Icon
          size={s.icon}
          stroke={cfg.text}
          strokeWidth={2}
          className={cfg.spin ? "animate-spin" : undefined}
        />
      )}
      <span>{cfg.label}</span>
    </span>
  );
}
