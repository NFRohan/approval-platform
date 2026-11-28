// =====================================================================
// Settings for the whole form, in step 1's configuration panel whenever
// no field is selected.
//
// They used to sit under the Approvers step, where nobody looked for
// them: who may raise the form, what follows its approval, how it is
// classified and found, and whether forwarding stays in the reporting
// line. Each saves as it changes.
// =====================================================================

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { db } from "@/lib/db";

type Settings = {
  audience: string[]; audienceRoles: string[]; followup: string;
  classification: string; keywords: string; withinLine: boolean;
};

const card: React.CSSProperties = { borderTop: "1px solid #F4F4F5", padding: "14px 16px" };
const head: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "#18181B" };
const note: React.CSSProperties = { fontSize: 11.5, color: "#71717A", margin: "2px 0 8px", lineHeight: 1.45 };
const ctl: React.CSSProperties = { padding: "6px 9px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6, background: "#fff", width: "100%" };

export function FormSettingsPanel({ templateId, readOnly }: { templateId: string | null; readOnly: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!templateId) return;
    let alive = true;
    void Promise.all([
      db.from("form_templates").select("followup_template_id, audience_departments, audience_roles, classification, keywords, forward_within_line").eq("id", templateId).maybeSingle(),
      db.from("departments").select("name").order("name"),
      db.from("roles").select("id, name").eq("status", "active").order("name"),
      db.from("form_templates").select("id, name").order("name"),
    ]).then(([t, d, r, f]) => {
      if (!alive) return;
      const row = (t.data ?? {}) as Record<string, unknown>;
      setS({
        audience: (row.audience_departments as string[] | null) ?? [],
        audienceRoles: (row.audience_roles as string[] | null) ?? [],
        followup: (row.followup_template_id as string | null) ?? "",
        classification: (row.classification as string | null) ?? "",
        keywords: ((row.keywords as string[] | null) ?? []).join(", "),
        withinLine: !!row.forward_within_line,
      });
      setDepartments(((d.data ?? []) as { name: string }[]).map((x) => x.name));
      setRoles((r.data ?? []) as { id: string; name: string }[]);
      setForms(((f.data ?? []) as { id: string; name: string }[]).filter((x) => x.id !== templateId));
    });
    return () => { alive = false; };
  }, [templateId]);

  const save = async (next: Settings) => {
    if (!templateId || readOnly) return;
    const { error } = await db.from("form_templates").update({
      followup_template_id: next.followup || null,
      audience_departments: next.audience.length ? next.audience : null,
      audience_roles: next.audienceRoles.length ? next.audienceRoles : null,
      classification: next.classification || null,
      keywords: [...new Set(next.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean))],
      forward_within_line: next.withinLine,
    }).eq("id", templateId);
    if (error) return void toast.error("Form settings were not saved: " + error.message);
    setSaved("Saved");
    window.setTimeout(() => setSaved(null), 1500);
  };
  // Typing settles before it saves; a click saves at once.
  const change = (patch: Partial<Settings>, typing = false) => {
    setS((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(next), typing ? 700 : 0);
      return next;
    });
  };

  if (!templateId) {
    return <div style={{ padding: 16, fontSize: 12.5, color: "#A1A1AA" }}>Add a field and the form's own settings appear here.</div>;
  }
  if (!s) return <div style={{ padding: 16, fontSize: 12.5, color: "#A1A1AA" }}>Loading form settings…</div>;

  return (
    <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} data-testid="form-settings">
      <div className="flex items-center justify-between" style={{ padding: "12px 16px 4px" }}>
        <div style={{ fontSize: 11.5, color: "#71717A" }}>Select a field on the canvas to configure it. Below, the form's own settings.</div>
        {saved && <span style={{ fontSize: 11.5, color: "#15803D" }}>{saved}</span>}
      </div>

      <div style={card} data-testid="audience">
        <div style={head}>Who can raise it</div>
        <div style={note}>Offered only to people in these departments, or holding these roles. Leave all unticked for everybody.</div>
        <div className="flex flex-wrap gap-1.5">
          {departments.map((d) => {
            const on = s.audience.includes(d);
            return (
              <label key={d} className="inline-flex items-center gap-1.5 rounded-md" style={{ padding: "3px 8px", fontSize: 12, border: `1px solid ${on ? "#C7D2FE" : "#E4E4E7"}`, background: on ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
                <input type="checkbox" checked={on} name={`audience-${d}`}
                  onChange={() => change({ audience: on ? s.audience.filter((x) => x !== d) : [...s.audience, d] })} />
                {d}
              </label>
            );
          })}
        </div>
        {roles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2" data-testid="audience-roles">
            {roles.map((r) => {
              const on = s.audienceRoles.includes(r.id);
              return (
                <label key={r.id} className="inline-flex items-center gap-1.5 rounded-md" style={{ padding: "3px 8px", fontSize: 12, border: `1px solid ${on ? "#C7D2FE" : "#E4E4E7"}`, background: on ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
                  <input type="checkbox" checked={on} name={`audience-role-${r.name}`}
                    onChange={() => change({ audienceRoles: on ? s.audienceRoles.filter((x) => x !== r.id) : [...s.audienceRoles, r.id] })} />
                  {r.name}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={head}>After approval</div>
        <div style={note}>Start a follow-up for the same requester, with every answer both forms ask already filled in. It waits as a draft for them to check and submit.</div>
        <select value={s.followup} onChange={(e) => change({ followup: e.target.value })} aria-label="Follow-up form" style={ctl}>
          <option value="">Nothing follows</option>
          {forms.map((f) => <option key={f.id} value={f.id}>Start: {f.name}</option>)}
        </select>
      </div>

      <div style={card} data-testid="classification">
        <div style={head}>Classification and search</div>
        <div style={note}>NFAs are classified so they can be told apart in lists and reports; keywords find the form from the search box.</div>
        <select value={s.classification} onChange={(e) => change({ classification: e.target.value })} aria-label="Classification" style={ctl}>
          <option value="">Not classified</option>
          <option value="budgetary">Budgetary</option>
          <option value="non_budgetary">Non-budgetary</option>
          <option value="regulatory">Regulatory</option>
          <option value="operational">Operational</option>
        </select>
        <input value={s.keywords} onChange={(e) => change({ keywords: e.target.value }, true)} aria-label="Keywords"
          placeholder="Keywords, separated by commas" style={{ ...ctl, marginTop: 8 }} />
      </div>

      <div style={card}>
        <div style={head}>Forwarding</div>
        <label className="flex items-start gap-2 mt-1" style={{ fontSize: 12.5, color: "#3F3F46" }}>
          <input type="checkbox" checked={s.withinLine} onChange={(e) => change({ withinLine: e.target.checked })}
            aria-label="Forward only within the reporting line" style={{ marginTop: 2 }} />
          <span>
            Forward only within the reporting line
            <span style={{ display: "block", fontSize: 11.5, color: "#71717A" }}>An approver may pass their step to the people above or below them, and nobody else.</span>
          </span>
        </label>
      </div>
    </fieldset>
  );
}
