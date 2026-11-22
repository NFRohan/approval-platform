// =====================================================================
// The process map: a request's route as a flowchart.
//
// "In application summary there is a new tab named 'Process Flowchart'
// where users will be able to see process maps graphical overview."
//
// Phases run left to right. A phase's lanes are rows, each a run of
// steps; between phases a join gathers every lane before the next phase
// fans out. Each step is coloured by where it stands. Drawn from the
// same rows as the timeline, so the two cannot disagree.
// =====================================================================

import type { ChainRow, Person } from "@/lib/timeline";

const NODE_W = 176;
const NODE_H = 46;
const GAP_X = 26;   // between steps in a lane
const PHASE_GAP = 56; // room for the join between phases
const ROW_H = 76;
const PAD = 20;

const COLOURS: Record<string, { fill: string; stroke: string; text: string; label: string }> = {
  approved:      { fill: "#F0FDF4", stroke: "#16A34A", text: "#15803D", label: "Approved" },
  pending:       { fill: "#FFFBEB", stroke: "#D97706", text: "#B45309", label: "With them now" },
  clarification: { fill: "#FFF7ED", stroke: "#EA580C", text: "#C2410C", label: "On hold" },
  rejected:      { fill: "#FEF2F2", stroke: "#DC2626", text: "#B91C1C", label: "Rejected" },
  skipped:       { fill: "#FAFAFA", stroke: "#D4D4D8", text: "#A1A1AA", label: "Not needed" },
  waiting:       { fill: "#FFFFFF", stroke: "#D4D4D8", text: "#52525B", label: "Waiting" },
};

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function ProcessMap({ rows, people }: { rows: ChainRow[]; people: Record<string, Person> }) {
  if (rows.length === 0) {
    return <div className="text-sm" style={{ color: "#71717A" }}>No route yet.</div>;
  }

  // phase -> lane -> steps
  const phases = new Map<number, Map<number, ChainRow[]>>();
  for (const r of [...rows].sort((a, b) =>
    (a.step_index ?? 0) - (b.step_index ?? 0) || (a.lane ?? 0) - (b.lane ?? 0) || (a.lane_step ?? 0) - (b.lane_step ?? 0))) {
    const p = r.step_index ?? 0;
    if (!phases.has(p)) phases.set(p, new Map());
    const lanes = phases.get(p)!;
    const l = r.lane ?? 0;
    if (!lanes.has(l)) lanes.set(l, []);
    lanes.get(l)!.push(r);
  }

  const phaseList = [...phases.entries()].map(([idx, lanes]) => ({ idx, lanes: [...lanes.values()] }));
  const maxLanes = Math.max(...phaseList.map((p) => p.lanes.length));
  const height = PAD * 2 + 28 + maxLanes * ROW_H;
  const midY = PAD + 28 + (maxLanes * ROW_H) / 2;

  // x positions
  let x = PAD + 60; // room for the start node
  const placed = phaseList.map((p) => {
    const steps = Math.max(...p.lanes.map((l) => l.length));
    const w = steps * NODE_W + (steps - 1) * GAP_X;
    const top = midY - (p.lanes.length * ROW_H) / 2;
    const out = { ...p, x, w, top };
    x += w + PHASE_GAP;
    return out;
  });
  const width = x - PHASE_GAP + 80 + PAD;

  const edges: string[] = [];
  const nodes: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];

  // start
  const startX = PAD + 14;
  nodes.push(
    <g key="start">
      <circle cx={startX} cy={midY} r={12} fill="#EEF2FF" stroke="#6366F1" />
      <text x={startX} y={midY + 30} textAnchor="middle" fontSize={10.5} fill="#6366F1">Raised</text>
    </g>,
  );

  let prevJoin = { x: startX + 12, y: midY };
  placed.forEach((p, pi) => {
    const quorum = p.lanes.flat().find((r) => r.quorum)?.quorum ?? null;
    const title = p.lanes.flat().find((r) => r.stage_label)?.stage_label
      ?? (p.lanes.length > 1 ? "At the same time" : "");
    if (title || p.lanes.length > 1) {
      labels.push(
        <text key={`t${pi}`} x={p.x} y={p.top - 6} fontSize={11} fontWeight={600} fill="#52525B">
          {clip(title, 38)}{p.lanes.length > 1 ? (quorum ? ` · any ${quorum} of ${p.lanes.length}` : ` · all ${p.lanes.length}`) : ""}
        </text>,
      );
    }

    const joinX = p.x + p.w + PHASE_GAP / 2;
    p.lanes.forEach((lane, li) => {
      const y = p.top + li * ROW_H + (ROW_H - NODE_H) / 2;
      lane.forEach((r, si) => {
        const nx = p.x + si * (NODE_W + GAP_X);
        const c = COLOURS[r.status ?? "waiting"] ?? COLOURS.waiting;
        const who = people[r.approver_user_id ?? ""]?.name ?? r.approver_user_id ?? "Unassigned";
        if (si === 0) {
          edges.push(`M ${prevJoin.x} ${prevJoin.y} C ${prevJoin.x + 24} ${prevJoin.y}, ${nx - 24} ${y + NODE_H / 2}, ${nx} ${y + NODE_H / 2}`);
        } else {
          edges.push(`M ${nx - GAP_X} ${y + NODE_H / 2} L ${nx} ${y + NODE_H / 2}`);
        }
        nodes.push(
          <g key={r.id}>
            <title>{`${who} — ${c.label}${r.lane_label ? ` (${r.lane_label})` : ""}`}</title>
            <rect x={nx} y={y} width={NODE_W} height={NODE_H} rx={9} fill={c.fill} stroke={c.stroke} strokeWidth={r.status === "pending" ? 2 : 1} />
            <text x={nx + 10} y={y + 18} fontSize={12} fontWeight={600} fill="#18181B">{clip(who, 23)}</text>
            <text x={nx + 10} y={y + 34} fontSize={10.5} fill={c.text}>
              {clip(r.lane_label ? `${r.lane_label} · ${c.label}` : c.label, 30)}
            </text>
          </g>,
        );
        if (si === lane.length - 1) {
          edges.push(`M ${nx + NODE_W} ${y + NODE_H / 2} C ${nx + NODE_W + 24} ${y + NODE_H / 2}, ${joinX - 24} ${midY}, ${joinX} ${midY}`);
        }
      });
    });
    nodes.push(<circle key={`j${pi}`} cx={joinX} cy={midY} r={4} fill="#A1A1AA" />);
    prevJoin = { x: joinX, y: midY };
  });

  // end
  const done = rows.every((r) => r.status === "approved" || r.status === "skipped");
  const endX = prevJoin.x + 40;
  edges.push(`M ${prevJoin.x} ${prevJoin.y} L ${endX - 13} ${midY}`);
  nodes.push(
    <g key="end">
      <circle cx={endX} cy={midY} r={12} fill={done ? "#F0FDF4" : "#FFFFFF"} stroke={done ? "#16A34A" : "#D4D4D8"} />
      <text x={endX} y={midY + 30} textAnchor="middle" fontSize={10.5} fill={done ? "#15803D" : "#A1A1AA"}>Done</text>
    </g>,
  );

  return (
    <div style={{ overflowX: "auto" }} role="figure" aria-label="Process map">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
        {edges.map((d, i) => <path key={i} d={d} fill="none" stroke="#D4D4D8" strokeWidth={1.5} />)}
        {labels}
        {nodes}
      </svg>
      <div className="flex flex-wrap gap-3 mt-2 text-[11px]" style={{ color: "#71717A" }}>
        {Object.entries(COLOURS).map(([k, c]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span style={{ width: 10, height: 10, borderRadius: 3, background: c.fill, border: `1px solid ${c.stroke}` }} />
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
