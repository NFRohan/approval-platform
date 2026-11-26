import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart, LabelList,
} from "recharts";
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, FileSpreadsheet, Minus, Printer, Table2, BarChart3,
} from "lucide-react";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { analytics, type Analytics } from "@/lib/analytics-fn";
import { downloadSheet } from "@/lib/sheet-fn";
import { toast } from "sonner";
import { reportFilterOptions, type FilterOptions } from "@/lib/report-fn";
import { NoPermission, Notice, Page } from "@/components/admin/kit";
import { control } from "@/components/reports/ReportParts";
import { ChartCard, Panel, RankedBars, SimpleTable, Tip } from "@/components/viz";

export const Route = createFileRoute("/analytics")({
  head: () => ({ meta: [{ title: "Analytics · Admin Services Portal" }] }),
  component: AnalyticsPage,
});

// Two categorical slots, in the fixed order, checked for colour-vision
// separation and contrast on white (dataviz validate_palette: all pass).
const SERIES_1 = "#2a78d6";   // raised; and every single-series chart
const SERIES_2 = "#eb6834";   // completed
const GRID = "#F1F1F3";
const AXIS = "#A1A1AA";
const INK = "#18181B";
const MUTED = "#71717A";

const DAYS = [30, 90, 180, 365] as const;
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const dmy = (iso: string) => `${dm(iso)}/${iso.slice(0, 4)}`;
const fmt = (n: number | null | undefined, unit = "") => (n === null || n === undefined ? "—" : `${n.toLocaleString("en-US")}${unit}`);

function AnalyticsPage() {
  const { can, currentUser } = useCurrentUser();
  const allowed = can("reports.view") || can("reports.manage");
  const [days, setDays] = useState<(typeof DAYS)[number]>(90);
  const [department, setDepartment] = useState("");
  const [form, setForm] = useState("");
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<FilterOptions | null>(null);

  useEffect(() => { if (allowed) void reportFilterOptions().then(setOptions); }, [allowed]);
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    setLoading(true);
    void analytics({ data: { days, department: department || null, form: form || null } }).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.ok) { setData(r.analytics); setError(null); } else setError(r.error);
    });
    return () => { alive = false; };
  }, [allowed, days, department, form, currentUser.employee_id]);

  if (!allowed) return <Page title="Analytics"><NoPermission need="reports.view" /></Page>;

  const k = data?.kpis;
  const span = `previous ${days} days`;

  // "Exportable executive dashboards" (SOW 2.1 KPI and Analytics): what
  // the page shows, as one Excel sheet — the headline figures, then
  // approval time by department, by form and by approver, the weekly SLA
  // trend, and where work is waiting.
  async function exportExcel() {
    if (!data) return;
    type Row = Record<string, string | number | null>;
    const out: Row[] = [];
    const row = (section: string, item: string, r: Partial<Row>) => out.push({ section, item, ...r });
    const K = data.kpis;
    row("Headline", "Requests raised", { count: K.raised, previous: K.raisedPrev });
    row("Headline", "Completed", { count: K.completed, previous: K.completedPrev });
    row("Headline", "Rejected", { count: K.rejected });
    row("Headline", "Average cycle time (days)", { avg_days: K.avgCycle, previous: K.avgCyclePrev, detail: K.medianCycle == null ? null : `median ${K.medianCycle} days` });
    row("Headline", "Approvals on time (%)", { on_time: K.onTimePct, previous: K.onTimePctPrev });
    row("Headline", "Open requests", { count: K.open, detail: `${K.pendingNow} steps waiting now` });
    row("Headline", "Overdue now", { count: K.overdueNow, detail: "approval steps past their deadline" });
    for (const d of data.byDepartment) row("Approval time by department", d.department, { count: d.raised, avg_days: d.avgCycle, detail: "raised; average days from raising to decision" });
    for (const f of data.byForm) row("Approval time by form", f.form, { count: f.raised, completed: f.completed, avg_days: f.avgCycle });
    for (const a of data.approvers) row("Approval time by approver", a.approver, { completed: a.completed, avg_days: a.avgResponse, on_time: a.onTimePct, detail: "average days from a step opening to its decision" });
    for (const w of data.sla) row("SLA by week", `Week of ${dmy(w.week)}`, { count: w.decided, on_time: w.onTimePct, detail: `${w.late} decided late` });
    for (const w of data.weekly) row("Volume by week", `Week of ${dmy(w.week)}`, { count: w.raised, completed: w.completed, detail: `${w.rejected} rejected` });
    for (const b of data.bottlenecks) row("Where work is waiting", b.approver, { count: b.pending, detail: `${b.overdue} overdue; oldest ${b.oldestDays ?? "—"} days` });
    const scope = [department || "all departments", form || "all forms", days === 365 ? "12 months" : `${days} days`].join(", ");
    try {
      await downloadSheet(`analytics-${new Date().toISOString().slice(0, 10)}.xlsx`, `Analytics — ${scope}`, [
        { key: "section", label: "Section" }, { key: "item", label: "Item" },
        { key: "count", label: "Count", type: "number" }, { key: "completed", label: "Completed", type: "number" },
        { key: "avg_days", label: "Average days", type: "number" }, { key: "on_time", label: "On time %", type: "number" },
        { key: "previous", label: "Previous period", type: "number" }, { key: "detail", label: "Detail" },
      ], out);
    } catch (e) {
      toast.error("Could not export: " + (e as Error).message);
    }
  }

  return (
    <div className="mx-auto analytics-print" style={{ maxWidth: 1280, padding: "28px 28px 56px" }}>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: INK, margin: 0 }}>Analytics</h1>
          <p style={{ marginTop: 6, fontSize: 14, color: MUTED }}>
            Volume, turnaround and SLA across the organisation — where work is moving and where it is stuck.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap print:hidden" data-testid="analytics-filters">
          <div className="inline-flex rounded-md" style={{ border: "1px solid #E4E4E7", background: "#fff", padding: 2 }} role="group" aria-label="Period">
            {DAYS.map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
                style={{ padding: "5px 10px", fontSize: 12.5, borderRadius: 5, border: "none", cursor: "pointer",
                  background: days === d ? "#18181B" : "transparent", color: days === d ? "#fff" : "#52525B", fontWeight: 500 }}>
                {d === 365 ? "12 months" : `${d} days`}
              </button>
            ))}
          </div>
          <select aria-label="Department" style={control} value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments</option>
            {options?.departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select aria-label="Form" style={control} value={form} onChange={(e) => setForm(e.target.value)}>
            <option value="">All forms</option>
            {options?.forms.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <Link to="/reports" style={{ ...control, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5, color: "#3F3F46" }}>
            <FileSpreadsheet size={13} /> Reports
          </Link>
          <button type="button" onClick={() => void exportExcel()} disabled={!data} style={{ ...control, display: "inline-flex", alignItems: "center", gap: 5, cursor: data ? "pointer" : "default" }}>
            <FileSpreadsheet size={13} /> Excel
          </button>
          <button type="button" onClick={() => window.print()} style={{ ...control, display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {error && <Notice tone="red">{error}</Notice>}

      <div className="grid gap-3 mb-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6" style={{ opacity: loading ? 0.6 : 1 }} data-testid="kpis">
        <Kpi label="Requests raised" value={fmt(k?.raised)} delta={delta(k?.raised, k?.raisedPrev)} span={span} />
        <Kpi label="Completed" value={fmt(k?.completed)} delta={delta(k?.completed, k?.completedPrev)} span={span} />
        <Kpi label="Average cycle time" value={fmt(k?.avgCycle, " days")} sub={k?.medianCycle != null ? `median ${k.medianCycle} days` : undefined}
          delta={delta(k?.avgCycle, k?.avgCyclePrev)} lowerIsBetter span={span} />
        <Kpi label="Approvals on time" value={fmt(k?.onTimePct, "%")} delta={pts(k?.onTimePct, k?.onTimePctPrev)} span={span} />
        <Kpi label="Open requests" value={fmt(k?.open)} sub={k ? `${k.pendingNow} steps waiting now` : undefined} />
        <Kpi label="Overdue now" value={fmt(k?.overdueNow)} sub="approval steps past their deadline" warn={!!k && k.overdueNow > 0} />
      </div>

      {data && (
        <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
          <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
            <ChartCard title="Requests per week" note="Raised, and completed, in each complete week"
              legend={[{ color: SERIES_1, label: "Raised" }, { color: SERIES_2, label: "Completed" }]}
              table={<SimpleTable head={["Week of", "Raised", "Completed", "Rejected"]} rows={data.weekly.map((w) => [dmy(w.week), w.raised, w.completed, w.rejected])} />}>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={data.weekly} margin={{ top: 10, right: 80, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="week" tickFormatter={dm} tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: "#E4E4E7" }} tickLine={false} minTickGap={24} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
                  <Tooltip content={<Tip rows={(p) => [["Raised", p.raised, SERIES_1], ["Completed", p.completed, SERIES_2], ["Rejected", p.rejected]]} title={(p) => `Week of ${dmy(p.week)}`} />}
                    cursor={{ stroke: "#D4D4D8", strokeWidth: 1 }} />
                  <Line type="linear" dataKey="raised" stroke={SERIES_1} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false}>
                    <LabelList dataKey="raised" content={<EndLabel last={data.weekly.length - 1} text="Raised" />} />
                  </Line>
                  <Line type="linear" dataKey="completed" stroke={SERIES_2} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false}>
                    <LabelList dataKey="completed" content={<EndLabel last={data.weekly.length - 1} text="Completed" />} />
                  </Line>
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Outcomes" note="Requests raised in the period, by where they are now"
              table={<SimpleTable head={["Status", "Requests"]} rows={data.status.map((s) => [label(s.status), s.count])} />}>
              <RankedBars rows={data.status.map((s) => ({ name: label(s.status), value: s.count }))} height={data.status.length * 34 + 8} />
            </ChartCard>
          </div>

          <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
            <ChartCard title="Approvals decided on time" note="Share of approval steps decided by their deadline, in each complete week"
              table={<SimpleTable head={["Week of", "Decided", "Late", "On time"]} rows={data.sla.map((w) => [dmy(w.week), w.decided, w.late, w.onTimePct == null ? "—" : `${w.onTimePct}%`])} />}>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.sla} margin={{ top: 10, right: 20, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="week" tickFormatter={dm} tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: "#E4E4E7" }} tickLine={false} minTickGap={24} />
                  <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
                  <ReferenceLine y={90} stroke="#A1A1AA" strokeWidth={1}
                    label={{ value: "Target 90%", position: "insideTopRight", fontSize: 11, fill: MUTED }} />
                  <Tooltip content={<Tip rows={(p) => [["On time", p.onTimePct == null ? "—" : `${p.onTimePct}%`, SERIES_1], ["Decided", p.decided], ["Late", p.late]]} title={(p) => `Week of ${dmy(p.week)}`} />}
                    cursor={{ stroke: "#D4D4D8", strokeWidth: 1 }} />
                  <Line type="linear" dataKey="onTimePct" stroke={SERIES_1} strokeWidth={2} dot={false} connectNulls
                    activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="By department" note="Requests raised, by the requester's department"
              table={<SimpleTable head={["Department", "Raised", "Avg cycle"]} rows={data.byDepartment.map((d) => [d.department, d.raised, d.avgCycle == null ? "—" : `${d.avgCycle} d`])} />}>
              <RankedBars rows={data.byDepartment.map((d) => ({ name: d.department, value: d.raised, extra: d.avgCycle == null ? undefined : `avg ${d.avgCycle} days` }))} height={data.byDepartment.length * 34 + 8} />
            </ChartCard>
          </div>

          <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <ChartCard title="Requests by form" note="The ten busiest forms"
              table={<SimpleTable head={["Form", "Raised", "Completed", "Avg cycle"]} rows={data.byForm.map((f) => [f.form, f.raised, f.completed, f.avgCycle == null ? "—" : `${f.avgCycle} d`])} />}>
              <RankedBars rows={data.byForm.map((f) => ({ name: f.form, value: f.raised, extra: f.avgCycle == null ? undefined : `avg ${f.avgCycle} days to decide` }))} height={data.byForm.length * 34 + 8} />
            </ChartCard>

            <Panel title="Slowest to respond" note="Average days from a step opening to its decision (at least three decided)">
              <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }} data-testid="slowest">
                <thead>
                  <tr style={{ color: MUTED, textAlign: "left" }}>
                    <th style={th}>Approver</th><th style={{ ...th, textAlign: "right" }}>Decided</th>
                    <th style={{ ...th, textAlign: "right" }}>On time</th><th style={{ ...th, width: "38%" }}>Avg response</th>
                  </tr>
                </thead>
                <tbody>
                  {data.approvers.map((a) => {
                    const max = Math.max(...data.approvers.map((x) => x.avgResponse ?? 0), 1);
                    return (
                      <tr key={a.approver} style={{ borderTop: "1px solid #F4F4F5" }}>
                        <td style={td}>{a.approver}</td>
                        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.completed}</td>
                        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.onTimePct == null ? "—" : `${a.onTimePct}%`}</td>
                        <td style={td}>
                          <div className="flex items-center gap-2">
                            <div style={{ flex: 1, height: 8, background: "#F4F4F5", borderRadius: 4 }}>
                              <div style={{ width: `${((a.avgResponse ?? 0) / max) * 100}%`, height: 8, background: SERIES_1, borderRadius: 4 }} />
                            </div>
                            <span style={{ width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.avgResponse ?? "—"} d</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!data.approvers.length && <tr><td colSpan={4} style={{ ...td, color: "#A1A1AA" }}>Nobody has decided three steps in this period.</td></tr>}
                </tbody>
              </table>
            </Panel>
          </div>

          <Panel title="Where work is waiting" note="Approvers with steps open now, overdue first"
            aside={<Link to="/reports" style={{ fontSize: 12.5, color: "#4F46E5", textDecoration: "none" }}>Open approvals report →</Link>}>
            <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }} data-testid="bottlenecks">
              <thead>
                <tr style={{ color: MUTED, textAlign: "left" }}>
                  <th style={th}>Approver</th><th style={{ ...th, textAlign: "right" }}>Waiting</th>
                  <th style={{ ...th, textAlign: "right" }}>Overdue</th><th style={{ ...th, textAlign: "right" }}>Oldest open</th>
                </tr>
              </thead>
              <tbody>
                {data.bottlenecks.map((b) => (
                  <tr key={b.approver} style={{ borderTop: "1px solid #F4F4F5" }}>
                    <td style={td}>{b.approver}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b.pending}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {b.overdue > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full" style={{ padding: "1px 8px", background: "#FFFBEB", color: "#B45309", border: "1px solid #FDE68A", fontWeight: 600 }}>
                          <AlertTriangle size={11} /> {b.overdue} overdue
                        </span>
                      ) : <span style={{ color: "#A1A1AA" }}>none</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b.oldestDays == null ? "—" : `${b.oldestDays} days`}</td>
                  </tr>
                ))}
                {!data.bottlenecks.length && <tr><td colSpan={4} style={{ ...td, color: "#A1A1AA" }}>Nothing is waiting on anybody.</td></tr>}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
      <style>{`@media print { aside, header, .print\\:hidden { display: none !important; } .analytics-print { max-width: none !important; padding: 0 !important; } }`}</style>
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 500, fontSize: 11.5 };
const td: React.CSSProperties = { padding: "8px 8px", color: "#27272A" };

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed", rejected: "Rejected", in_progress: "In progress", submitted: "Submitted",
  on_hold: "On hold", cancelled: "Cancelled",
};
const label = (s: string) => STATUS_LABELS[s] ?? s;

type Delta = { text: string; dir: "up" | "down" | "flat" } | null;
function delta(now: number | null | undefined, prev: number | null | undefined): Delta {
  if (now == null || prev == null) return null;
  if (prev === 0) return now === 0 ? { text: "no change", dir: "flat" } : null;
  const pct = Math.round(((now - prev) / prev) * 100);
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}
function pts(now: number | null | undefined, prev: number | null | undefined): Delta {
  if (now == null || prev == null) return null;
  const d = Math.round(now - prev);
  return { text: `${d > 0 ? "+" : ""}${d} pts`, dir: d > 0 ? "up" : d < 0 ? "down" : "flat" };
}

function Kpi({ label, value, sub, delta: d, span, lowerIsBetter, warn }: {
  label: string; value: string; sub?: string; delta?: Delta; span?: string; lowerIsBetter?: boolean; warn?: boolean;
}) {
  const good = d && d.dir !== "flat" ? (d.dir === "down") === !!lowerIsBetter : null;
  const Icon = !d || d.dir === "flat" ? Minus : d.dir === "up" ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
      <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED }}>
        {warn && <AlertTriangle size={13} style={{ color: "#B45309" }} aria-label="Needs attention" />}
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: INK, letterSpacing: "-0.02em", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {d && (
        <div style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.4 }}>
          <span className="inline-flex items-center gap-0.5" style={{ fontWeight: 600, color: good === null ? MUTED : good ? "#15803D" : "#B91C1C" }}>
            <Icon size={12} />{d.text}
          </span>
          <div style={{ color: MUTED }}>vs {span}</div>
        </div>
      )}
      {sub && <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The series name at the end of its line, in text ink — identity is the line beside it. */
function EndLabel(props: any) {
  const { x, y, index, last, text } = props;
  if (index !== last || x == null || y == null) return null;
  return <text x={x + 8} y={y + 4} fontSize={11.5} fill="#3F3F46">{text}</text>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

