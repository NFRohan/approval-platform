import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CalendarDays, Plus, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

export const Route = createFileRoute("/approvals/delegate")({
  head: () => ({
    meta: [{ title: "Approval Delegation · Admin Services Portal" }],
  }),
  component: DelegationPage,
});

type DelegationRow = {
  id: string;
  delegator_id: string;
  delegate_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  created_at: string | null;
  form_template_ids: string[] | null;
  delegateName?: string;
  delegateDesignation?: string | null;
  formNames?: string[];
};

type EmployeeRow = {
  employee_id: string;
  name: string;
  designation: string | null;
  department: string | null;
};

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isActive(row: DelegationRow) {
  const today = new Date().toISOString().slice(0, 10);
  return row.start_date <= today && row.end_date >= today;
}

type FormTemplate = { id: string; name: string };

function DelegationPage() {
  const { currentUser } = useCurrentUser();
  const [delegations, setDelegations] = useState<DelegationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const [delegateId, setDelegateId] = useState("");
  const [delegateEmp, setDelegateEmp] = useState<EmployeeRow | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const [availableForms, setAvailableForms] = useState<FormTemplate[]>([]);
  const [selectedFormIds, setSelectedFormIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data }, { data: forms }] = await Promise.all([
      db
        .from("delegation_rules")
        .select("*")
        .eq("delegator_id", currentUser.employee_id)
        .order("start_date", { ascending: false }),
      db
        .from("form_templates")
        .select("id, name")
        .eq("status", "published")
        .order("name"),
    ]);

    setAvailableForms((forms ?? []) as FormTemplate[]);

    const rows = (data ?? []) as DelegationRow[];
    const formMap: Record<string, string> = {};
    (forms ?? []).forEach((f) => { formMap[f.id] = f.name; });

    if (rows.length > 0) {
      const ids = rows.map((r) => r.delegate_id);
      const { data: emps } = await db
        .from("employees")
        .select("employee_id, name, designation")
        .in("employee_id", ids);
      const empMap: Record<string, EmployeeRow> = {};
      (emps ?? []).forEach((e) => { empMap[e.employee_id] = e as EmployeeRow; });
      rows.forEach((r) => {
        const e = empMap[r.delegate_id];
        r.delegateName = e?.name;
        r.delegateDesignation = e?.designation;
        r.formNames = r.form_template_ids ? r.form_template_ids.map((id) => formMap[id] ?? id) : null as unknown as string[];
      });
    }
    setDelegations(rows);
    setLoading(false);
  }, [currentUser.employee_id]);

  useEffect(() => { void load(); }, [load]);

  async function lookupDelegate() {
    if (!delegateId.trim()) return;
    setLookingUp(true);
    const { data } = await db
      .from("employees")
      .select("employee_id, name, designation, department")
      .eq("employee_id", delegateId.trim())
      .maybeSingle();
    setLookingUp(false);
    if (data) setDelegateEmp(data as EmployeeRow);
    else { setDelegateEmp(null); toast.error("Employee not found"); }
  }

  async function handleSave() {
    if (!delegateEmp) { toast.error("Select a valid delegate"); return; }
    if (!startDate || !endDate) { toast.error("Set both start and end dates"); return; }
    if (endDate < startDate) { toast.error("End date must be after start date"); return; }
    if (delegateEmp.employee_id === currentUser.employee_id) { toast.error("Cannot delegate to yourself"); return; }

    setSaving(true);
    const { error } = await db.from("delegation_rules").insert({
      delegator_id: currentUser.employee_id,
      delegate_id: delegateEmp.employee_id,
      start_date: startDate,
      end_date: endDate,
      reason: reason.trim() || null,
      form_template_ids: selectedFormIds.length > 0 ? selectedFormIds : null,
    });
    setSaving(false);
    if (error) { toast.error("Failed to save: " + error.message); return; }

    toast.success("Delegation saved");
    setShowForm(false);
    setDelegateId("");
    setDelegateEmp(null);
    setStartDate("");
    setEndDate("");
    setReason("");
    setSelectedFormIds([]);
    void load();
  }

  async function handleDelete(id: string) {
    const { error } = await db.from("delegation_rules").delete().eq("id", id);
    if (error) { toast.error("Failed to remove delegation"); return; }
    setDelegations((prev) => prev.filter((d) => d.id !== id));
    toast.success("Delegation removed");
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    border: "1px solid #E4E4E7",
    borderRadius: 6,
    background: "#fff",
    color: "#18181B",
    boxSizing: "border-box",
    fontFamily: "inherit",
  };

  return (
    <div className="max-w-3xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="mb-6">
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }}>
          Approval Delegation
        </h1>
        <p style={{ marginTop: 6, fontSize: 14, color: "#71717A" }}>
          Delegate your approval authority to a colleague while you're on leave or unavailable.
        </p>
      </div>

      {/* Active delegation banner */}
      {delegations.filter(isActive).map((d) => (
        <div
          key={d.id}
          className="rounded-xl flex items-start gap-3 mb-4"
          style={{ padding: "14px 16px", background: "#FFF7ED", border: "1px solid #FED7AA" }}
        >
          <CalendarDays size={16} style={{ color: "#C2410C", flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, fontSize: 13.5, color: "#7C2D12" }}>
            <strong>Active delegation:</strong> Your approvals are being handled by{" "}
            <strong>{d.delegateName ?? d.delegate_id}</strong>
            {d.delegateDesignation && <span style={{ color: "#9A3412" }}> ({d.delegateDesignation})</span>}
            {" "}until <strong>{fmtDate(d.end_date)}</strong>.
            {d.reason && <span style={{ color: "#9A3412" }}> Reason: {d.reason}</span>}
          </div>
        </div>
      ))}

      {/* New delegation form */}
      {showForm ? (
        <div className="rounded-xl bg-white mb-6" style={{ border: "1px solid #E4E4E7", padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#18181B", marginBottom: 16 }}>New Delegation</h2>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Delegate (Employee ID)</span>
              <div className="flex gap-2">
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder="e.g. EMP-1200"
                  value={delegateId}
                  onChange={(e) => setDelegateId(e.target.value)}
                  onBlur={lookupDelegate}
                />
                <button
                  onClick={lookupDelegate}
                  style={{ padding: "8px 14px", borderRadius: 6, fontSize: 13, background: "#F4F4F5", border: "1px solid #E4E4E7", color: "#3F3F46", cursor: "pointer" }}
                >
                  {lookingUp ? "…" : "Look up"}
                </button>
              </div>
              {delegateEmp && (
                <div className="flex items-center gap-2.5 rounded-md" style={{ padding: "10px 12px", background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                  <User size={13} style={{ color: "#16A34A" }} />
                  <div>
                    <span style={{ fontWeight: 500, color: "#15803D", fontSize: 13 }}>{delegateEmp.name}</span>
                    <span style={{ color: "#71717A", fontSize: 12, marginLeft: 6 }}>{delegateEmp.designation} · {delegateEmp.department}</span>
                  </div>
                </div>
              )}
            </label>

            <div className="flex gap-4">
              <label className="flex flex-col gap-1.5 flex-1">
                <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Start date</span>
                <input type="date" style={inputStyle} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </label>
              <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 8 }}>
                <ArrowRight size={14} style={{ color: "#A1A1AA" }} />
              </div>
              <label className="flex flex-col gap-1.5 flex-1">
                <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>End date</span>
                <input type="date" style={inputStyle} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Reason (optional)</span>
              <input style={inputStyle} placeholder="e.g. Annual leave" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>

            <div className="flex flex-col gap-1.5">
              <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Delegate for specific forms (optional)</span>
              <p style={{ fontSize: 11, color: "#71717A", margin: 0 }}>Leave all unchecked to delegate authority for all forms.</p>
              {availableForms.length === 0 ? (
                <p style={{ fontSize: 12, color: "#A1A1AA" }}>No published forms available.</p>
              ) : (
                <div className="flex flex-col gap-1.5" style={{ maxHeight: 160, overflowY: "auto", padding: "4px 0" }}>
                  {availableForms.map((f) => {
                    const checked = selectedFormIds.includes(f.id);
                    return (
                      <label key={f.id} className="flex items-center gap-2.5 cursor-pointer rounded-md" style={{ padding: "7px 10px", border: `1px solid ${checked ? "#BFDBFE" : "#E4E4E7"}`, background: checked ? "#EFF6FF" : "#fff" }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedFormIds((ids) => checked ? ids.filter((id) => id !== f.id) : [...ids, f.id])}
                          style={{ accentColor: "var(--color-brand-500)" }}
                        />
                        <span style={{ fontSize: 13, color: checked ? "#1D4ED8" : "#3F3F46" }}>{f.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex gap-2 justify-end" style={{ paddingTop: 4 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: "8px 14px", borderRadius: 6, fontSize: 13, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B", cursor: "pointer" }}>
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 500, background: "var(--color-brand-500)", color: "#fff", border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}
              >
                {saving ? "Saving…" : "Save Delegation"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1.5 rounded-lg mb-6"
          style={{ padding: "9px 16px", fontSize: 13, fontWeight: 500, background: "var(--color-brand-500)", color: "#fff", border: "none", cursor: "pointer" }}
        >
          <Plus size={14} /> New Delegation
        </button>
      )}

      {/* Delegation list */}
      <h2 style={{ fontSize: 14, fontWeight: 600, color: "#3F3F46", marginBottom: 12 }}>Your Delegations</h2>
      {loading ? (
        <div style={{ fontSize: 13, color: "#A1A1AA" }}>Loading…</div>
      ) : delegations.length === 0 ? (
        <div className="rounded-xl text-center" style={{ padding: "48px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>
          No delegations set up. Create one when you're going on leave.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {delegations.map((d) => {
            const active = isActive(d);
            return (
              <div
                key={d.id}
                className="rounded-xl bg-white flex items-center gap-4"
                style={{ border: `1px solid ${active ? "#FED7AA" : "#E4E4E7"}`, padding: "14px 16px" }}
              >
                <div
                  className="rounded-full inline-flex items-center justify-center shrink-0"
                  style={{ width: 36, height: 36, background: active ? "#FFF7ED" : "#F4F4F5", color: active ? "#C2410C" : "#71717A" }}
                >
                  <User size={16} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span style={{ fontWeight: 600, fontSize: 14, color: "#18181B" }}>{d.delegateName ?? d.delegate_id}</span>
                    {d.delegateDesignation && (
                      <span style={{ fontSize: 12, color: "#71717A" }}>{d.delegateDesignation}</span>
                    )}
                    {active && (
                      <span className="inline-flex items-center rounded-full font-medium" style={{ padding: "2px 8px", fontSize: 11, background: "#FFF7ED", color: "#C2410C", border: "1px solid #FED7AA" }}>
                        Active
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#71717A", marginTop: 3 }}>
                    {fmtDate(d.start_date)} – {fmtDate(d.end_date)}
                    {d.reason && <span style={{ marginLeft: 8 }}>· {d.reason}</span>}
                  </div>
                  {d.formNames && d.formNames.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {d.formNames.map((name) => (
                        <span key={name} style={{ padding: "1px 7px", fontSize: 10.5, borderRadius: 9999, background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE" }}>{name}</span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "#A1A1AA", marginTop: 2 }}>All forms</div>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(d.id)}
                  style={{ padding: "6px", borderRadius: 6, background: "transparent", border: "1px solid #FECACA", color: "#DC2626", cursor: "pointer" }}
                  title="Remove delegation"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
