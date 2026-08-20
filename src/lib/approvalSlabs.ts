export type ApprovalSlab = {
  id: string;
  form_template_id: string;
  min_amount: number;
  max_amount: number | null;
  approver_user_id: string;
  order_index: number;
};

/**
 * Which approvers an amount involves.
 *
 * Cumulative, and that is the whole point: a slab is a threshold that
 * has been crossed, not a bucket a number falls into. 620,000 involves
 * the Controller, the Head of Finance AND the CFO, in that order.
 * Returning one approver — the previous behaviour — meant a large claim
 * skipped every level below the top one, which is the opposite of what
 * an escalation policy says.
 *
 * The database decides this for real, in app.slab_approvers. This exists
 * so the form can show the ladder before anything is submitted, and the
 * two must agree.
 */
export function resolveSlabChain(amount: number, slabs: ApprovalSlab[]): string[] {
  return [...slabs]
    .sort((x, y) => x.order_index - y.order_index)
    .filter((s) => amount >= s.min_amount)
    .map((s) => s.approver_user_id);
}
