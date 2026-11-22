// =====================================================================
// The approvals a form adds by hand, as stages.
//
// Stages run one after another. Everybody in a stage is asked at the same
// time; people given the same track inside a stage go in order along it.
// A stage with several tracks clears when all of them do, or when any N
// do. That is the whole of what the engine needs to lay out the scope of
// work's shapes: a sequence (one person per stage), clearance from five
// departments at once, the division's own LM → HoD → HRBP → CXO running
// alongside them on one track, and "any two of three accessors".
//
// An approver is a person or an organisational role, resolved when the
// request is raised, and may apply only when an answer says so.
// app.rule_role / app.resolve_role in db/005_chain.sql are the roles.
// =====================================================================

import { Plus, Trash2, GitBranch, Filter } from "lucide-react";
import { CONDITION_OPS, ROLE_OPTIONS, newApprover, newId, trackCount, type Stage, type StageApprover } from "./stages";

type EmployeeOption = { employee_id: string; name: string; designation: string | null };

const input: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: 12.5,
  border: "1px solid #E4E4E7",
  borderRadius: 6,
  background: "#fff",
  color: "#18181B",
};

export function StageEditor({
  stages,
  onChange,
  employees,
  fieldLabels,
}: {
  stages: Stage[];
  onChange: (next: Stage[]) => void;
  employees: EmployeeOption[];
  fieldLabels: string[];
}) {
  const setStage = (id: string, patch: Partial<Stage>) =>
    onChange(stages.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const setApprover = (stageId: string, apId: string, patch: Partial<StageApprover>) =>
    onChange(
      stages.map((s) =>
        s.id === stageId
          ? { ...s, approvers: s.approvers.map((a) => (a.id === apId ? { ...a, ...patch } : a)) }
          : s,
      ),
    );

  return (
    <section className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", background: "#FAFAFA", borderBottom: "1px solid #E4E4E7" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>Further approval stages</div>
        <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>
          Stages run one after another, after the ones above. Everybody in a stage is asked at the
          same time; give people the same track to have them go in order along it.
        </div>
      </div>

      {stages.length === 0 && (
        <div style={{ padding: "16px", fontSize: 12.5, color: "#A1A1AA" }}>No further stages.</div>
      )}

      {stages.map((stage, si) => {
        const tracks = trackCount(stage);
        return (
          <div key={stage.id} data-stage={si} style={{ borderTop: si === 0 ? "none" : "1px solid #F4F4F5", padding: "14px 16px" }}>
            <div className="flex items-center gap-2 mb-3">
              <span
                className="inline-flex items-center justify-center rounded-full"
                style={{ width: 22, height: 22, fontSize: 11, fontWeight: 600, background: "#EEF2FF", color: "#4338CA" }}
              >
                {si + 1}
              </span>
              <input
                value={stage.label}
                onChange={(e) => setStage(stage.id, { label: e.target.value })}
                placeholder="Stage name (optional) — e.g. Departmental clearance"
                aria-label={`Stage ${si + 1} name`}
                style={{ ...input, flex: 1 }}
              />
              <button
                onClick={() => onChange(stages.filter((s) => s.id !== stage.id))}
                aria-label={`Remove stage ${si + 1}`}
                style={{ padding: 6, background: "none", border: "none", color: "#B91C1C", cursor: "pointer" }}
              >
                <Trash2 size={14} />
              </button>
            </div>

            <div className="flex flex-col gap-2">
              {stage.approvers.map((a) => (
                <div key={a.id} className="rounded-lg" style={{ border: "1px solid #F4F4F5", padding: "8px 10px", background: "#FCFCFD" }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={a.who}
                      onChange={(e) => setApprover(stage.id, a.id, { who: e.target.value })}
                      aria-label="Approver"
                      style={{ ...input, flex: "1 1 220px" }}
                    >
                      <option value="">Choose a person or a role…</option>
                      <optgroup label="Roles — resolved for each requester">
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r.value} value={`role:${r.value}`}>{r.label}</option>
                        ))}
                      </optgroup>
                      <optgroup label="People">
                        {employees.map((e) => (
                          <option key={e.employee_id} value={e.employee_id}>
                            {e.name}{e.designation ? ` — ${e.designation}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    {stage.approvers.length > 1 && (
                      <label className="inline-flex items-center gap-1" style={{ fontSize: 11.5, color: "#71717A" }}>
                        <GitBranch size={12} />
                        <input
                          value={a.track}
                          onChange={(e) => setApprover(stage.id, a.id, { track: e.target.value })}
                          placeholder="own track"
                          aria-label="Track"
                          style={{ ...input, width: 120 }}
                        />
                      </label>
                    )}
                    <label className="inline-flex items-center gap-1" style={{ fontSize: 11.5, color: "#71717A" }}>
                      <input
                        type="number"
                        min={1}
                        value={a.deadlineDays}
                        onChange={(e) => setApprover(stage.id, a.id, { deadlineDays: Math.max(1, Number(e.target.value) || 1) })}
                        aria-label="Working days to respond"
                        style={{ ...input, width: 56 }}
                      />
                      working days
                    </label>
                    <button
                      onClick={() =>
                        setApprover(stage.id, a.id, {
                          condition: a.condition ? null : { field: fieldLabels[0] ?? "", op: "eq", value: "" },
                        })
                      }
                      title={a.condition ? "Always ask them" : "Only ask them when an answer says so"}
                      className="inline-flex items-center gap-1 rounded-md"
                      style={{
                        padding: "5px 8px", fontSize: 11.5, cursor: "pointer",
                        border: `1px solid ${a.condition ? "#C7D2FE" : "#E4E4E7"}`,
                        background: a.condition ? "#EEF2FF" : "#fff",
                        color: a.condition ? "#4338CA" : "#71717A",
                      }}
                    >
                      <Filter size={11} /> {a.condition ? "Only when…" : "Always"}
                    </button>
                    <button
                      onClick={() => setStage(stage.id, { approvers: stage.approvers.filter((x) => x.id !== a.id) })}
                      aria-label="Remove approver"
                      style={{ padding: 6, background: "none", border: "none", color: "#B91C1C", cursor: "pointer" }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {a.condition && (
                    <div className="flex items-center gap-2 flex-wrap mt-2" style={{ fontSize: 12, color: "#52525B" }}>
                      <span>Only when</span>
                      <select
                        value={a.condition.field}
                        onChange={(e) => setApprover(stage.id, a.id, { condition: { ...a.condition!, field: e.target.value } })}
                        aria-label="Condition question"
                        style={input}
                      >
                        {fieldLabels.length === 0 && <option value="">(this form has no questions)</option>}
                        {fieldLabels.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                      <select
                        value={a.condition.op}
                        onChange={(e) => setApprover(stage.id, a.id, { condition: { ...a.condition!, op: e.target.value } })}
                        aria-label="Condition operator"
                        style={input}
                      >
                        {CONDITION_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {!["empty", "not_empty"].includes(a.condition.op) && (
                        <input
                          value={a.condition.value}
                          onChange={(e) => setApprover(stage.id, a.id, { condition: { ...a.condition!, value: e.target.value } })}
                          placeholder="value"
                          aria-label="Condition value"
                          style={{ ...input, width: 160 }}
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap mt-3">
              <button
                onClick={() => setStage(stage.id, { approvers: [...stage.approvers, newApprover()] })}
                className="inline-flex items-center gap-1 rounded-md"
                style={{ padding: "5px 10px", fontSize: 12, border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46", cursor: "pointer" }}
              >
                <Plus size={12} /> Add someone to this stage
              </button>
              {tracks > 1 && (
                <label className="inline-flex items-center gap-2" style={{ fontSize: 12, color: "#52525B" }}>
                  Clears when
                  <select
                    value={stage.quorum ?? ""}
                    onChange={(e) => setStage(stage.id, { quorum: e.target.value ? Number(e.target.value) : null })}
                    aria-label="Clears when"
                    style={input}
                  >
                    <option value="">all {tracks} tracks have</option>
                    {Array.from({ length: tracks - 1 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>any {n} of {tracks}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
        );
      })}

      <div style={{ padding: "12px 16px", borderTop: "1px solid #F4F4F5", background: "#FAFAFA" }}>
        <button
          onClick={() => onChange([...stages, { id: newId("st"), label: "", quorum: null, approvers: [newApprover()] }])}
          className="inline-flex items-center gap-1 rounded-md"
          style={{ padding: "6px 12px", fontSize: 12.5, fontWeight: 500, border: "1px solid #C7D2FE", background: "#EEF2FF", color: "#4338CA", cursor: "pointer" }}
        >
          <Plus size={13} /> Add a stage
        </button>
      </div>
    </section>
  );
}
