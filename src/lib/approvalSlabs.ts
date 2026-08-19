export type ApprovalSlab = {
  id: string;
  form_template_id: string;
  min_amount: number;
  max_amount: number | null;
  approver_user_id: string;
  order_index: number;
};

/**
 * Resolves which approver a given amount routes to, given a form's slab list.
 * Slabs are matched by [min_amount, max_amount] inclusive; max_amount = null
 * means "no upper bound" (the top slab). Falls back to the highest-order slab
 * if amount exceeds every defined range (defensive; shouldn't normally happen
 * since the top slab has max_amount = null).
 */
export function resolveSlabApprover(amount: number, slabs: ApprovalSlab[]): string | null {
  if (slabs.length === 0) return null;
  const sorted = [...slabs].sort((a, b) => a.order_index - b.order_index);
  for (const s of sorted) {
    if (amount >= s.min_amount && (s.max_amount === null || amount <= s.max_amount)) {
      return s.approver_user_id;
    }
  }
  return sorted[sorted.length - 1].approver_user_id;
}
