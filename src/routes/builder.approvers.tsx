import { LoadingRows } from "@/components/Loading";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NoFormChosen } from "@/components/builder/NoFormChosen";
import { db } from "@/lib/db";
import { BuilderChrome, PrimaryButton, SecondaryButton } from "@/components/builder/BuilderChrome";
import { PeopleStep, type AutoEntry } from "@/components/builder/PeopleStep";
import { StageEditor } from "@/components/builder/StageEditor";
import { newApprover, newId, type Stage } from "@/components/builder/stages";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { Trash2, Plus } from "lucide-react";
import { ruleRole } from "@/lib/routing";
import { useBuilderAccess } from "@/components/builder/access";

// Optional: opened with no form (a bookmark, a reload), it says so rather than failing.
// The builder takes one search parameter, the form; a plain check rather
// than a schema library, which was 50 KB of every page's first download.
const search = (s: Record<string, unknown>): { templateId?: string } =>
  typeof s.templateId === "string" && s.templateId ? { templateId: s.templateId } : {};

export const Route = createFileRoute("/builder/approvers")({
  validateSearch: search,
  head: () => ({
    meta: [{ title: "Approvers · Form Builder" }],
  }),
  component: Page,
});

function Page() {
  const { templateId } = Route.useSearch();
  return templateId ? <ApproversStep templateId={templateId} /> : <NoFormChosen step="approvers" />;
}

// The approvers a form gets from its own fields.
//
// The line manager is a role, not a person: the engine resolves it to
// whoever raised the request's own manager when it is submitted. It was
// one employee, fixed here for every requester in the organisation, and
// labelled with a name that employee no longer had.
//
// `label` is what is saved on the rule and what the engine reads;
// app.rule_role in db/005_chain.sql is the list of roles it knows.
type Sla = { warnHours?: number | null; escalateDays?: number | null; escalateLevels?: number | null };
type AutoApprover = AutoEntry & Sla & { label: string; _requires?: string; ruleId?: string; requireSignature?: boolean; remindHours?: number | null };

const ALL_AUTO_APPROVERS: AutoApprover[] = [
  {
    id: "auto-line-mgr",
    user_id: null,
    label: "line_manager",
    name: "Requester's line manager",
    designation: "From the org chart, when submitted",
    displayReason: "Added: Employee field",
    reason: "Added: Employee field",
    deadlineDays: 7,
    _requires: "employee",
  },
  {
    id: "auto-admin",
    user_id: "EMP-0445",
    label: "admin",
    name: "Admin Officer",
    designation: "Admin",
    displayReason: "Added: Default",
    reason: "Added: Default",
    deadlineDays: 7,
  },
  {
    id: "auto-finance",
    user_id: null,
    label: "slab_finance",
    name: "Finance Approver",
    designation: "Resolved at submission",
    displayReason: "Amount-based routing",
    reason: "slab_finance",
    slab: true,
    deadlineDays: 7,
    _requires: "money",
  },
];

type SavedRule = Sla & { label: string; user_id: string | null; deadlineDays: number; ruleId: string; requireSignature: boolean; remindHours: number | null };

// The organisational roles a rule can name; see app.resolve_role.
const ROLE_LABELS = new Set(["line_manager", "skip_level", "department_head", "hrbp", "cxo"]);

type SlabRow = { id?: string; min_amount: string; max_amount: string; approver_user_id: string };
type EmployeeOption = { employee_id: string; name: string; designation: string | null };

function ApproversStep({ templateId }: { templateId: string }) {
  const navigate = useNavigate();
  const { currentUser } = useCurrentUser();
  const [formName, setFormName] = useState("");
  // The approvals added by hand, as stages: see StageEditor.
  const [stages, setStages] = useState<Stage[]>([]);
  const [fieldLabels, setFieldLabels] = useState<string[]>([]);
  // The template whose draft is started when this form is approved.
  const [savedAgo, setSavedAgo] = useState("just now");
  const [fieldTypes, setFieldTypes] = useState<Set<string>>(new Set());
  const [slabs, setSlabs] = useState<SlabRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [names, setNames] = useState<Record<string, { name: string; designation: string | null }>>({});
  // The automatic rules this form was saved with, or null for a form that
  // has never had approvers. An existing form keeps what it has; only a
  // new one is given the defaults.
  const [savedAuto, setSavedAuto] = useState<SavedRule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const access = useBuilderAccess(templateId);

  useEffect(() => {
    (async () => {
      const [{ data: tpl }, { data: fields }, { data: existingSlabs }, { data: emps }, { data: rules }] = await Promise.all([
        db.from("form_templates").select("name").eq("id", templateId).maybeSingle(),
        db.from("form_fields").select("field_type, field_name, order_index").eq("form_template_id", templateId).order("order_index"),
        db.from("approval_slabs").select("*").eq("form_template_id", templateId).order("order_index"),
        db.from("employees").select("employee_id, name, designation").order("name"),
        db.from("approval_rules")
          .select("id, approver_user_id, deadline_days, is_auto_added, label, step_index, quorum, condition, stage_label, lane, position, require_signature, flag, remind_hours, warn_hours, escalate_days, escalate_levels")
          .eq("form_template_id", templateId)
          .order("step_index")
          .order("position"),
      ]);
      if (tpl?.name) setFormName(tpl.name);
      setFieldLabels(
        (fields ?? [])
          .filter((f) => f.field_name && !["section_header", "file", "signature"].includes(f.field_type ?? ""))
          .map((f) => f.field_name as string),
      );
      setFieldTypes(new Set((fields ?? []).map((f) => f.field_type ?? "").filter(Boolean)));
      setEmployees((emps ?? []) as EmployeeOption[]);
      const byId: Record<string, { name: string; designation: string | null }> = {};
      (emps ?? []).forEach((e) => { byId[e.employee_id] = { name: e.name, designation: e.designation }; });
      setNames(byId);
      // The approvers added by hand last time, as the stages they were
      // saved in. This step used to start from an empty list and then
      // replace every rule on save, so opening a form's approvers and
      // pressing Next deleted the ones added before.
      type SavedManual = {
        id: string;
        approver_user_id: string | null; deadline_days: number | null; label: string | null;
        step_index: number | null; quorum: number | null; stage_label: string | null; lane: string | null;
        condition: { field?: string; op?: string; value?: string } | null;
        require_signature: boolean | null; flag: string | null; remind_hours: number | null;
        warn_hours?: number | null; escalate_days?: number | null; escalate_levels?: number | null;
      };
      const byStage = new Map<number, SavedManual[]>();
      for (const r of (rules ?? []) as (SavedManual & { is_auto_added: boolean | null })[]) {
        if (r.is_auto_added) continue;
        const role = ruleRole(r.label);
        const isRole = ROLE_LABELS.has(role ?? "");
        if (!r.approver_user_id && !isRole) continue;
        const k = r.step_index ?? 0;
        if (!byStage.has(k)) byStage.set(k, []);
        byStage.get(k)!.push(r);
      }
      setStages(
        [...byStage.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, rs]) => ({
            id: newId("st"),
            label: rs.find((r) => r.stage_label)?.stage_label ?? "",
            quorum: rs.find((r) => r.quorum)?.quorum ?? null,
            approvers: rs.map((r) => {
              // A role stays a role even when it names a fallback person:
              // loading it as that person would turn "the requester's line
              // manager" into "always Sam" the next time it is saved.
              const role = ruleRole(r.label);
              const isRole = ROLE_LABELS.has(role ?? "");
              return {
                ...newApprover(isRole ? `role:${role}` : (r.approver_user_id as string)),
                ruleId: r.id,
                fallback: isRole ? r.approver_user_id : null,
                label: isRole ? null : r.label,
                requireSignature: !!r.require_signature,
                flag: r.flag,
                remindHours: r.remind_hours ?? null,
                warnHours: r.warn_hours ?? null, escalateDays: r.escalate_days ?? null, escalateLevels: r.escalate_levels ?? null,
                deadlineDays: r.deadline_days ?? 7,
                track: r.lane ?? "",
                condition: r.condition?.field
                  ? { field: r.condition.field, op: r.condition.op ?? "eq", value: r.condition.value ?? "" }
                  : null,
              };
            }),
          })),
      );
      setSavedAuto(
        rules && rules.length > 0
          ? rules
              .filter((r) => r.is_auto_added)
              .map((r) => ({
                label: r.label ?? "", user_id: r.approver_user_id, deadlineDays: r.deadline_days ?? 7,
                ruleId: r.id as string, requireSignature: !!r.require_signature,
                remindHours: (r as { remind_hours?: number | null }).remind_hours ?? null,
                warnHours: r.warn_hours ?? null, escalateDays: r.escalate_days ?? null, escalateLevels: r.escalate_levels ?? null,
              }))
          : null,
      );
      setLoading(false);
      if (existingSlabs && existingSlabs.length > 0) {
        setSlabs(
          existingSlabs.map((s) => ({
            id: s.id,
            min_amount: String(s.min_amount),
            max_amount: s.max_amount === null ? "" : String(s.max_amount),
            approver_user_id: s.approver_user_id,
          })),
        );
      } else {
        // No bands saved: none invented. Three defaults used to be filled
        // in here, so opening any form with an amount and pressing Next
        // added three finance approvers it had never had.
        setSlabs([]);
      }
    })();
  }, [templateId]);

  function updateSlab(index: number, patch: Partial<SlabRow>) {
    setSlabs((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function addSlab() {
    setSlabs((prev) => [...prev, { min_amount: "", max_amount: "", approver_user_id: employees[0]?.employee_id ?? "" }]);
  }
  function removeSlab(index: number) {
    setSlabs((prev) => prev.filter((_, i) => i !== index));
  }

  // A fixed person shows under their name as the org chart has it now,
  // not as it was when this file was written.
  const named = (a: AutoApprover): AutoApprover =>
    a.user_id && names[a.user_id] && ruleRole(a.label) !== "line_manager"
      ? { ...a, name: names[a.user_id].name, designation: names[a.user_id].designation ?? a.designation }
      : a;

  // Finance by amount is part of the route only when there are bands:
  // a form with an amount and no bands routes by people alone.
  const hasBands = slabs.some((x) => x.min_amount !== "" && x.approver_user_id);

  // What the form gets automatically.
  //
  // A new form gets the defaults its fields imply. A form that already
  // has approvers keeps the automatic ones it was saved with: this step
  // used to recompute the defaults every time, so opening a seeded form
  // and pressing Next quietly dropped its line manager (none of the
  // seeded forms has an Employee field) and added an Admin Officer it
  // had never had. Fields added since still bring their rule with them.
  const autoApprovers: AutoApprover[] = (() => {
    const defaults = ALL_AUTO_APPROVERS.filter((a) => !a._requires || fieldTypes.has(a._requires));
    if (savedAuto === null) return defaults.map(named);

    const kept: AutoApprover[] = savedAuto.map((r, i) => {
      const role = ruleRole(r.label);
      const def = ALL_AUTO_APPROVERS.find((a) => a.label === role && (role === "line_manager" || role === "slab_finance"));
      // The person on a line-manager rule is the fallback for somebody
      // with no manager on record, so it is kept.
      if (def) return { ...def, user_id: role === "line_manager" ? r.user_id : def.user_id, deadlineDays: r.deadlineDays, ruleId: r.ruleId, requireSignature: r.requireSignature, remindHours: r.remindHours, warnHours: r.warnHours, escalateDays: r.escalateDays, escalateLevels: r.escalateLevels };
      return named({
        ruleId: r.ruleId,
        requireSignature: r.requireSignature,
        remindHours: r.remindHours,
        warnHours: r.warnHours, escalateDays: r.escalateDays, escalateLevels: r.escalateLevels,
        id: `saved-auto-${i}`,
        user_id: r.user_id,
        label: r.label,
        name: r.user_id ?? "Unassigned",
        designation: "",
        displayReason: "Saved with this form",
        reason: r.label,
        deadlineDays: r.deadlineDays,
      });
    });
    const roles = new Set(kept.map((k) => ruleRole(k.label)));
    const added = defaults.filter((d) => d._requires && !roles.has(d.label));
    return [...kept, ...added];
  })().filter((a) => ruleRole(a.label) !== "slab_finance" || hasBands);

  // Task settings only: each saved step's deadline and signature, through
  // the one function that may change them, and nothing else.
  async function saveSettings() {
    const timing = (a: Sla & { remindHours?: number | null }) => ({
      remind_hours: a.remindHours ?? null, warn_hours: a.warnHours ?? null,
      escalate_days: a.escalateDays ?? null, escalate_levels: a.escalateLevels ?? null,
    });
    const changes = [
      ...autoApprovers.filter((a) => a.ruleId).map((a) => ({ id: a.ruleId!, days: a.deadlineDays ?? 7, sig: !!a.requireSignature, t: timing(a) })),
      ...stages.flatMap((st) => st.approvers.filter((a) => a.ruleId).map((a) => ({ id: a.ruleId!, days: a.deadlineDays, sig: !!a.requireSignature, t: timing(a) }))),
    ];
    for (const c of changes) {
      const { error } = await db.rpc("update_rule_settings", { p_rule: c.id, p_deadline_days: c.days, p_require_signature: c.sig, p_timing: c.t });
      if (error) {
        toast.error("Could not save the task settings: " + error.message);
        return;
      }
    }
    setSavedAgo("just now");
    toast.success("Task settings saved");
  }

  async function handleNext() {
    if (access === "settings") return saveSettings();
    if (access === "read") {
      navigate({ to: "/builder/notifications", search: { templateId } });
      return;
    }
    // Replace existing approval_rules for this template
    await db.from("approval_rules").delete().eq("form_template_id", templateId);

    // In the order the screen shows them, numbered. The engine walks
    // rules by step_index, and these were saved without one — every rule
    // at 0, so the tie fell to random ids and a form built here asked
    // its approvers in an order nobody chose.
    const rows = [
      ...autoApprovers.map((a) => ({
        form_template_id: templateId,
        approver_user_id: a.user_id,
        deadline_days: a.deadlineDays ?? 7,
        is_auto_added: true,
        label: a.label,
        remind_hours: a.remindHours ?? null,
        warn_hours: a.warnHours ?? null, escalate_days: a.escalateDays ?? null, escalate_levels: a.escalateLevels ?? null,
      })),
    ].map((r, i) => ({ ...r, step_index: i, position: 0 }));

    // Then the stages, one phase each. Inside a stage, position is the
    // order people were listed in, a named track is a lane, and the
    // stage's quorum and name go on every rule in it.
    const base = rows.length;
    const stageRows = stages
      .map((st) => ({ ...st, approvers: st.approvers.filter((a) => a.who) }))
      .filter((st) => st.approvers.length > 0)
      .flatMap((st, si) =>
        st.approvers.map((a, pi) => {
          const role = a.who.startsWith("role:") ? a.who.slice(5) : null;
          return {
            form_template_id: templateId,
            approver_user_id: role ? (a.fallback ?? null) : a.who,
            deadline_days: a.deadlineDays,
            is_auto_added: false,
            label: role ?? (a.label || "Manually added"),
            step_index: base + si,
            position: pi,
            lane: a.track.trim() || null,
            quorum: st.quorum,
            stage_label: st.label.trim() || null,
            condition: a.condition && a.condition.field ? a.condition : null,
            require_signature: !!a.requireSignature,
            flag: a.flag?.trim() || null,
            remind_hours: a.remindHours ?? null,
            warn_hours: a.warnHours ?? null, escalate_days: a.escalateDays ?? null, escalate_levels: a.escalateLevels ?? null,
          };
        }),
      );
    const allRows = [...rows.map((r) => ({ ...r, lane: null, quorum: null, stage_label: null, condition: null, require_signature: false, flag: null })), ...stageRows];

    const { error } = await db.from("approval_rules").insert(allRows);
    if (error) {
      toast.error("Failed to save approvers: " + error.message);
      return;
    }


    if (fieldTypes.has("money")) {
      await db.from("approval_slabs").delete().eq("form_template_id", templateId);
      const slabRows = slabs
        .filter((s) => s.min_amount !== "" && s.approver_user_id)
        .map((s, i) => ({
          form_template_id: templateId,
          min_amount: parseFloat(s.min_amount),
          // Never read — app.slab_approvers and resolveSlabChain both filter
          // on min_amount alone. Stored as null rather than left to imply a
          // ceiling the engine does not honour.
          max_amount: null,
          approver_user_id: s.approver_user_id,
          order_index: i,
        }));
      if (slabRows.length > 0) {
        const { error: slabErr } = await db.from("approval_slabs").insert(slabRows);
        if (slabErr) {
          toast.error("Failed to save approval slabs: " + slabErr.message);
          return;
        }
      }
      // The change is recorded by the database (configuration audit,
      // db/009_sow_gaps.sql), with who made it and what changed.
    }

    setSavedAgo("just now");
    navigate({ to: "/builder/notifications", search: { templateId } });
  }

  function handleBack() {
    navigate({ to: "/builder", search: { templateId } });
  }

  return (
    <BuilderChrome formId={templateId}
      step={2}
      formName={formName}
      savedAgo={savedAgo}
      rightActions={
        <>
          <SecondaryButton onClick={handleBack}>← Back</SecondaryButton>
          <PrimaryButton onClick={handleNext}>{access === "settings" ? "Save task settings" : "Next →"}</PrimaryButton>
        </>
      }
    >
      {loading ? (
        <div style={{ padding: "4px 0 8px" }}>
          <LoadingRows rows={3} height={72} />
        </div>
      ) : (
      <PeopleStep
        formTemplateId={templateId}
        title="Who needs to approve this form?"
        subtitle="Automatic approvers come first, from the form's fields; then the stages below, one after another."
        autoEntries={autoApprovers}
        showDeadline
        manual={[]}
        onManualChange={() => {}}
        manualSlot={
          <>
            <StageEditor stages={stages} onChange={setStages} employees={employees} fieldLabels={fieldLabels}
              lock={access === "full" ? "none" : access === "settings" ? "structure" : "all"} />
            {/* The amount bands, in the column with the stages: beside it they took the width and squeezed the approvers to a sliver. */}
            {fieldTypes.has("money") && (
              <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: 18, margin: "24px 0 0" }}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>Finance Approval Slabs</div>
                    <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>
                      Thresholds are cumulative: a claim is asked of every approver whose threshold it
                      reaches, lowest first. A claim of 620,000 climbs all three — it does not go
                      straight to the top one.
                    </div>
                  </div>
                  <button
                    onClick={addSlab}
                    className="inline-flex items-center gap-1.5 rounded-md"
                    style={{ padding: "6px 12px", fontSize: 12.5, background: "#fff", border: "1px solid #E4E4E7", color: "#3F3F46", cursor: "pointer" }}
                  >
                    <Plus size={13} /> Add Slab
                  </button>
                </div>
                {slabs.length === 0 && (
                  <div data-testid="no-bands" style={{ fontSize: 12.5, color: "#71717A", padding: "6px 0 2px" }}>
                    No bands: the amount does not change who approves this form. Add a band to send
                    larger amounts to finance approvers.
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {slabs.map((s, i) => (
                    <div key={i} className="flex items-center gap-2" style={{ padding: "8px 0", borderTop: i > 0 ? "1px solid #F4F4F5" : "none" }}>
                      <span style={{ color: "#A1A1AA", fontSize: 12 }}>from</span>
                      <input
                        type="number"
                        placeholder="Amount"
                        aria-label={`Band ${i + 1} from amount`}
                        value={s.min_amount}
                        onChange={(e) => updateSlab(i, { min_amount: e.target.value })}
                        style={{ width: 110, padding: "6px 8px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6 }}
                      />
                      <span style={{ color: "#A1A1AA", fontSize: 12 }}>and above</span>
                      <select
                        aria-label={`Band ${i + 1} approver`}
                        value={s.approver_user_id}
                        onChange={(e) => updateSlab(i, { approver_user_id: e.target.value })}
                        style={{ flex: 1, padding: "6px 8px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6 }}
                      >
                        {employees.map((e) => (
                          <option key={e.employee_id} value={e.employee_id}>{e.name} ({e.employee_id})</option>
                        ))}
                      </select>
                      <button
                        onClick={() => removeSlab(i)}
                        title="Remove slab"
                        style={{ padding: 6, background: "none", border: "none", color: "#B91C1C", cursor: "pointer" }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ fontSize: 12, color: "#A1A1AA", margin: "18px 2px 0" }}>
              Who can raise this form, what follows its approval, its classification and keywords, and
              forwarding are form settings now: step 1, with no field selected.
            </div>
          </>
        }
      />
      )}
    </BuilderChrome>
  );
}
