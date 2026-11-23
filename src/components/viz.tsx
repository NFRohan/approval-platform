// =====================================================================
// The pieces charts are made of, shared by Analytics, the audit centre
// and Integrations: a panel, a chart with its table one click away, a
// table, ranked bars and the tooltip. Colours are the validated
// categorical slots (dataviz validate_palette, light surface: all pass;
// slots 3 and 4 sit under 3:1 contrast, so every chart that uses them
// has its legend and its table view).
// =====================================================================

import { useMemo, useState, type ReactNode } from "react";
import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, Table2 } from "lucide-react";

export const SERIES_1 = "#2a78d6";
export const SERIES_2 = "#eb6834";
export const SERIES_3 = "#1baf7a";
export const SERIES_4 = "#eda100";
export const GRID = "#F1F1F3";
export const AXIS = "#A1A1AA";
export const INK = "#18181B";
export const MUTED = "#71717A";
const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 500, fontSize: 11.5 };
const td: React.CSSProperties = { padding: "8px 8px", color: "#27272A" };

export function Panel({ title, note, aside, children }: { title: string; note?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "16px 18px" }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: INK, margin: 0 }}>{title}</h2>
          {note && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{note}</div>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A chart with its legend, and the same numbers as a table one click away. */
export function ChartCard({ title, note, legend, table, children }: {
  title: string; note?: string; legend?: { color: string; label: string }[]; table: ReactNode; children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Panel title={title} note={note} aside={
      <div className="flex items-center gap-3">
        {legend && !asTable && legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5" style={{ fontSize: 12, color: "#3F3F46" }}>
            <span style={{ width: 14, height: 2, background: l.color, borderRadius: 1 }} /> {l.label}
          </span>
        ))}
        <button type="button" onClick={() => setAsTable(!asTable)} aria-label={asTable ? `Show ${title} as a chart` : `Show ${title} as a table`}
          title={asTable ? "Chart" : "Table"} style={{ border: "1px solid #E4E4E7", borderRadius: 6, background: "#fff", padding: 4, cursor: "pointer", display: "inline-flex", color: MUTED }}>
          {asTable ? <BarChart3 size={14} /> : <Table2 size={14} />}
        </button>
      </div>
    }>
      {asTable ? <div style={{ maxHeight: 260, overflowY: "auto" }}>{table}</div> : children}
    </Panel>
  );
}

export function SimpleTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }}>
      <thead><tr>{head.map((h, i) => <th key={h} style={{ ...th, color: MUTED, textAlign: i ? "right" : "left" }}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={i} style={{ borderTop: "1px solid #F4F4F5" }}>
          {r.map((v, j) => <td key={j} style={{ ...td, textAlign: j ? "right" : "left", fontVariantNumeric: "tabular-nums" }}>{v}</td>)}
        </tr>
      ))}</tbody>
    </table>
  );
}

/** Horizontal bars, one hue, value at the tip, longest first. */
export function RankedBars({ rows, height, unit = "Requests" }: { rows: { name: string; value: number; extra?: string }[]; height: number; unit?: string }) {
  const data = useMemo(() => [...rows].sort((a, b) => b.value - a.value), [rows]);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 36, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide domain={[0, "dataMax"]} />
        <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11.5, fill: "#3F3F46" }} axisLine={false} tickLine={false}
          tickFormatter={(v: string) => (v.length > 22 ? v.slice(0, 21) + "…" : v)} />
        <Tooltip cursor={{ fill: "#F4F4F5" }} content={<Tip rows={(p) => [[unit, p.value, SERIES_1], ...(p.extra ? [["", p.extra] as [string, string]] : [])]} title={(p) => p.name} />} />
        <Bar dataKey="value" fill={SERIES_1} barSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList dataKey="value" position="right" style={{ fontSize: 11.5, fill: "#3F3F46" }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Tip({ active, payload, rows, title }: {
  active?: boolean; payload?: any[];
  rows: (p: any) => [string, string | number | null | undefined, string?][];
  title: (p: any) => string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg" style={{ background: "#fff", border: "1px solid #E4E4E7", boxShadow: "0 4px 12px rgba(0,0,0,0.08)", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: INK, marginBottom: 4 }}>{title(p)}</div>
      {rows(p).map(([k, v, color], i) => (
        <div key={i} className="flex items-center gap-2" style={{ color: "#3F3F46" }}>
          {color ? <span style={{ width: 10, height: 2, background: color }} /> : <span style={{ width: 10 }} />}
          {k && <span style={{ color: MUTED }}>{k}</span>}
          <span style={{ marginLeft: "auto", fontWeight: 600, fontVariantNumeric: "tabular-nums", paddingLeft: 12 }}>{v ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}
