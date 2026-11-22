// =====================================================================
// A chain, laid out for the timeline.
//
// Rows come back as phases (step_index), lanes and steps within a lane.
// A phase with one lane is a plain sequence and is drawn as one step
// after another, as every chain was before lanes. A phase with several
// lanes runs them at the same time, and is drawn as one parallel block
// with a card per step, each saying which lane it belongs to and where
// in it — "Division · 2 of 3".
// =====================================================================

import type { Approver, Step, StepState } from "@/components/ApprovalTimeline";
import { fmtDateTime } from "@/lib/dates";

export type ChainRow = {
  id: string;
  approver_user_id: string | null;
  step_index: number | null;
  lane?: number | null;
  lane_step?: number | null;
  lane_label?: string | null;
  quorum?: number | null;
  stage_label?: string | null;
  status: string | null;
  comment?: string | null;
  acted_at?: string | null;
  deadline_at?: string | null;
  reassigned_from?: string | null;
  signature?: string | null;
};

export type Person = { name: string; designation: string | null; department?: string | null };

export function stateOf(status: string | null): StepState {
  switch ((status || "").toLowerCase()) {
    case "approved":
    case "completed":
      return "completed";
    case "rejected":
      return "rejected";
    case "on_hold":
      return "on_hold";
    case "clarification":
      return "clarification";
    case "pending":
      // Live: somebody can act on it now.
      return "active";
    case "waiting":
      return "locked";
    case "skipped":
      // Never asked — a rejection ended the chain, or a quorum made it
      // unnecessary, or the requester took it back.
      return "idle";
    default:
      return "pending";
  }
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function when(iso?: string | null) {
  return iso ? fmtDateTime(iso) : undefined;
}

function actionLabel(state: StepState) {
  return state === "completed" ? "Approved"
    : state === "rejected" ? "Rejected"
    : state === "clarification" ? "Clarification requested"
    : state === "on_hold" ? "Placed on hold"
    : undefined;
}

function phaseState(rows: ChainRow[]): StepState {
  const states = rows.map((r) => stateOf(r.status));
  if (states.some((s) => s === "rejected")) return "rejected";
  if (states.some((s) => s === "clarification")) return "clarification";
  if (states.some((s) => s === "active")) return "active";
  if (states.every((s) => s === "completed" || s === "idle") && states.some((s) => s === "completed")) {
    return "completed";
  }
  if (states.every((s) => s === "idle")) return "idle";
  return "locked";
}

export function buildTimeline(rows: ChainRow[], people: Record<string, Person>): Step[] {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.step_index ?? 0) - (b.step_index ?? 0) ||
      (a.lane ?? 0) - (b.lane ?? 0) ||
      (a.lane_step ?? 0) - (b.lane_step ?? 0),
  );

  const phases = new Map<number, ChainRow[]>();
  for (const r of sorted) {
    const k = r.step_index ?? 0;
    if (!phases.has(k)) phases.set(k, []);
    phases.get(k)!.push(r);
  }

  const out: Step[] = [];
  let n = 0;

  const approverFor = (r: ChainRow, laneSize: number): Approver => {
    const who = r.approver_user_id ? people[r.approver_user_id] : undefined;
    const name = who?.name || r.approver_user_id || "Unassigned";
    const state = stateOf(r.status);
    const where = r.lane_label
      ? laneSize > 1 ? `${r.lane_label} · ${(r.lane_step ?? 0) + 1} of ${laneSize}` : r.lane_label
      : undefined;
    const forwarded = r.reassigned_from
      ? ` · forwarded from ${people[r.reassigned_from]?.name ?? r.reassigned_from}`
      : "";
    return {
      name,
      title: [where, who?.designation].filter(Boolean).join(" — ") + forwarded || "—",
      dept: who?.department || undefined,
      initials: initials(name),
      state,
      actionAt: when(r.acted_at),
      actionLabel: actionLabel(state),
      comment: r.comment || undefined,
      signature: r.signature || undefined,
    };
  };

  for (const [, phaseRows] of phases) {
    const lanes = new Map<number, ChainRow[]>();
    for (const r of phaseRows) {
      const k = r.lane ?? 0;
      if (!lanes.has(k)) lanes.set(k, []);
      lanes.get(k)!.push(r);
    }

    if (lanes.size === 1) {
      // A sequence: one step each.
      for (const r of phaseRows) {
        n += 1;
        const a = approverFor(r, 1);
        out.push({
          id: n,
          kind: "single",
          title: r.stage_label || people[r.approver_user_id ?? ""]?.designation || `Approver ${n}`,
          state: a.state,
          approver: a,
          actionAt: a.actionAt,
          actionLabel: a.actionLabel,
          comment: a.comment,
        });
      }
      continue;
    }

    // Lanes at the same time.
    n += 1;
    const laneCount = lanes.size;
    const quorum = phaseRows.find((r) => r.quorum)?.quorum ?? null;
    const lanesDone = [...lanes.values()].filter((l) => l.every((r) => r.status === "approved")).length;
    const states = phaseRows.map((r) => stateOf(r.status));
    out.push({
      id: n,
      kind: "parallel",
      title: phaseRows.find((r) => r.stage_label)?.stage_label || "Approved alongside each other",
      state: phaseState(phaseRows),
      rule: quorum
        ? `Any ${quorum} of ${laneCount} — ${lanesDone} done`
        : `All ${laneCount} must clear — ${lanesDone} done`,
      progress: {
        done: states.filter((s) => s === "completed").length,
        hold: states.filter((s) => s === "clarification" || s === "on_hold").length,
        pending: states.filter((s) => s === "active").length,
        total: states.length,
      },
      approvers: [...lanes.values()].flatMap((l) => l.map((r) => approverFor(r, l.length))),
    });
  }

  return out;
}
