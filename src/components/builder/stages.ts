// =====================================================================
// The shape of the approval stages a form adds by hand, and the helpers
// for them. Kept apart from StageEditor so that file exports only the
// component; see StageEditor.tsx for what a stage means.
// =====================================================================

export const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "line_manager", label: "Requester's line manager" },
  { value: "skip_level", label: "Line manager's manager" },
  { value: "department_head", label: "Head of the requester's department" },
  { value: "hrbp", label: "Department's HR business partner" },
  { value: "cxo", label: "Department's CXO" },
];

export const CONDITION_OPS: { value: string; label: string }[] = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "gt", label: "is more than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "not_empty", label: "is answered" },
  { value: "empty", label: "is left blank" },
];

export type StageApprover = {
  id: string;
  /** The saved rule this came from, so task settings can be changed on it alone. */
  ruleId?: string;
  /** An employee id, or "role:<role>". */
  who: string;
  /**
   * For a role: who is asked when the org chart has nobody in it for this
   * requester. Kept through the editor so saving does not drop it.
   */
  fallback?: string | null;
  /** The rule's own label for a fixed person ("finance", "scm"), kept as saved. */
  label?: string | null;
  deadlineDays: number;
  /** People sharing a track in a stage go in order; blank is a track of one's own. */
  track: string;
  condition: { field: string; op: string; value: string } | null;
  /** "Signature required" for this approver's step. */
  requireSignature?: boolean;
  /** Raised on the request when this step is part of its route — e.g. "Exceptional". */
  flag?: string | null;
};

export type Stage = {
  id: string;
  label: string;
  /** How many tracks must clear; null means all of them. */
  quorum: number | null;
  approvers: StageApprover[];
};

let seq = 0;
export const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function newApprover(who = ""): StageApprover {
  return { id: newId("ap"), who, deadlineDays: 3, track: "", condition: null, requireSignature: false, flag: null };
}

/** How many tracks a stage runs: a named track is one, each unnamed person is one. */
export function trackCount(stage: Stage): number {
  const named = new Set(stage.approvers.filter((a) => a.track.trim()).map((a) => a.track.trim().toLowerCase()));
  return named.size + stage.approvers.filter((a) => !a.track.trim()).length;
}
