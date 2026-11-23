// What a campaign's numbers mean: spent against budget, the daily run
// rate, and where that rate ends up by the last day. Shared by the list
// and the campaign page so they always agree.

export type Campaign = {
  id: string; submission_id: string | null; request_id: string | null; name: string; audience: string | null;
  modality: string | null; coupon: boolean; exceptional: boolean;
  status: "upcoming" | "ongoing" | "completed" | "discontinued" | "discarded";
  starts_on: string; ends_on: string; budget: number; kpi: Record<string, number>; wallets: { wallet: string; budget: number }[];
  cost_center: string | null; gl_code: string | null; product: string | null; beneficiary: string | null;
  requester_id: string | null; reviewer_id: string | null; alerted: Record<string, string>; status_note: string | null;
};

export const STATUS_STYLE: Record<Campaign["status"], { label: string; bg: string; fg: string; bd: string }> = {
  upcoming:     { label: "Upcoming",     bg: "#EFF6FF", fg: "#1D4ED8", bd: "#BFDBFE" },
  ongoing:      { label: "Ongoing",      bg: "#F0FDF4", fg: "#15803D", bd: "#BBF7D0" },
  completed:    { label: "Completed",    bg: "#F4F4F5", fg: "#3F3F46", bd: "#E4E4E7" },
  discontinued: { label: "Discontinued", bg: "#FFFBEB", fg: "#B45309", bd: "#FDE68A" },
  discarded:    { label: "Discarded",    bg: "#FEF2F2", fg: "#B91C1C", bd: "#FECACA" },
};

const DAY = 86_400_000;
const day = (iso: string) => new Date(iso + "T00:00:00Z").getTime();

export function pace(c: Campaign, spent: number, today = new Date()) {
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = day(c.starts_on), end = day(c.ends_on);
  const length = Math.max(1, Math.round((end - start) / DAY) + 1);
  const elapsed = Math.min(length, Math.max(0, Math.round((Math.min(t, end) - start) / DAY) + 1));
  const daysLeft = Math.max(0, Math.round((end - t) / DAY));
  const pct = c.budget > 0 ? (spent / c.budget) * 100 : 0;
  const runRate = elapsed > 0 ? spent / elapsed : 0;
  // Only a running campaign has a pace to project.
  const projected = c.status === "ongoing" && c.budget > 0 ? ((spent + runRate * daysLeft) / c.budget) * 100 : null;
  return { length, elapsed, daysLeft, pct, runRate, projected };
}

export const money = (n: number) => n >= 1e7 ? `${(n / 1e7).toFixed(2)} cr` : n >= 1e5 ? `${(n / 1e5).toFixed(1)} lakh` : n.toLocaleString("en-US");
export const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
