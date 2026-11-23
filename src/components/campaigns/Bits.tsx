// Pieces the campaign screens share.
import { AlertTriangle } from "lucide-react";

/** Spent against budget: one hue to 95%, amber past it, red past 100%, with the 95% mark. */
export function Bar({ pct, height = 8, budget = true }: { pct: number; height?: number; budget?: boolean }) {
  // Spending turns amber at 95% and red past 100%; progress towards a
  // target is good news and stays one colour.
  const color = !budget ? "#2a78d6" : pct >= 100 ? "#DC2626" : pct >= 95 ? "#D97706" : "#2a78d6";
  return (
    <div style={{ position: "relative", height, background: "#F1F1F3", borderRadius: height / 2 }}>
      <div style={{ width: `${Math.min(100, pct)}%`, height, background: color, borderRadius: height / 2 }} />
      {budget && <div title="95% of budget" style={{ position: "absolute", left: "95%", top: -2, bottom: -2, width: 1.5, background: "#71717A" }} />}
    </div>
  );
}

export function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
      <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: "#71717A" }}>
        {warn && <AlertTriangle size={13} style={{ color: "#B45309" }} aria-label="Needs attention" />}{label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#18181B", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: "#71717A", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
