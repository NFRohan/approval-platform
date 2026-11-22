// =====================================================================
// Who a request will go to, worked out the way the database will.
//
// public.build_approval_chain in db/005_chain.sql is the authority. The
// form's review step shows the requester the ladder before they commit
// to it, and a preview that disagrees with what then happens is worse
// than none — so the rules live here once, in the same order:
//
//   1. a rule is a role or a person: "line_manager" means the requester's
//      own manager, with the person on the rule only as a fallback;
//   2. slab_finance expands into every threshold the amount has crossed;
//   3. a step that would land on the requester is left out;
//   4. the same person twice in a row is one step.
// =====================================================================

import { resolveSlabChain, type ApprovalSlab } from "@/lib/approvalSlabs";

/**
 * The role a rule stands for. Forms built before the labels were fixed
 * carry the reason the builder showed on screen; both spellings mean
 * the same thing. Mirrors app.rule_role.
 */
export function ruleRole(label: string | null | undefined): string | null {
  switch (label) {
    case "Added: Employee field": return "line_manager";
    case "Added: Submitter": return "submitter";
    case "Added: Form creator": return "creator";
    default: return label ?? null;
  }
}

export type LadderRule = {
  approver_user_id: string | null;
  deadline_days: number | null;
  label: string | null;
};

export type LadderStep = { approver: string; deadlineDays: number; rule: LadderRule };

/** The steps a chain will have, in order. */
export function resolveLadder(
  rules: LadderRule[],
  ctx: { requester: string | null; lineManager: string | null; amount: number; slabs: ApprovalSlab[] },
): LadderStep[] {
  const candidates: { approver: string | null; deadlineDays: number; rule: LadderRule }[] = [];
  for (const r of rules) {
    const days = r.deadline_days ?? 7;
    if (r.label === "slab_finance") {
      for (const id of resolveSlabChain(ctx.amount, ctx.slabs)) {
        candidates.push({ approver: id, deadlineDays: days, rule: r });
      }
    } else if (ruleRole(r.label) === "line_manager") {
      candidates.push({ approver: ctx.lineManager ?? r.approver_user_id, deadlineDays: days, rule: r });
    } else {
      candidates.push({ approver: r.approver_user_id, deadlineDays: days, rule: r });
    }
  }

  const steps: LadderStep[] = [];
  let last: string | null = null;
  for (const c of candidates) {
    if (!c.approver) continue;
    if (c.approver === ctx.requester) continue;
    if (c.approver === last) continue;
    steps.push({ approver: c.approver, deadlineDays: c.deadlineDays, rule: c.rule });
    last = c.approver;
  }
  return steps;
}

/** Who a watcher rule means for this requester. Mirrors the engine's watcher loop. */
export function resolveWatcher(
  rule: { notifyee_user_id: string | null; label: string | null },
  ctx: { requester: string | null; lineManager: string | null; formCreator: string | null },
): string | null {
  switch (ruleRole(rule.label)) {
    case "line_manager": return ctx.lineManager ?? rule.notifyee_user_id;
    case "submitter": return ctx.requester;
    case "creator": return ctx.formCreator ?? rule.notifyee_user_id;
    default: return rule.notifyee_user_id;
  }
}
