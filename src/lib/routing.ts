// =====================================================================
// What a rule's label means.
//
// Who a request goes to is no longer worked out here. The review step
// asks the database (preview_approval_chain), which runs the same
// planner the chain is built from, so the preview and the chain cannot
// drift apart the way two copies of the rules once did. What remains is
// the role vocabulary — mirrors app.rule_role — and who a watcher rule
// means, which the review step still shows.
// =====================================================================

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
