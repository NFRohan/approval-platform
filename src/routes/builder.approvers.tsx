import { LoadingRows } from "@/components/Loading";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
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
const search = z.object({ templateId: z.string().optional() });

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
  const [formName, setFormName] = useState("Employee Departure Due Diligence Form");
  // The approvals added by hand, as stages: see StageEditor.
  const [stages, setStages] = useState<Stage[]>([]);
  const [fieldLabels, setFieldLabels] = useState<string[]>([]);
  // The template whose draft is started when this form is approved.
  const [followup, setFollowup] = useState<string>("");
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
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
  // Who may raise this form: departments, or everybody when empty.
  const [audience, setAudience] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  // ...or to whoever holds one of these roles.
  const [audienceRoles, setAudienceRoles] = useState<string[]>([]);
  const [roleList, setRoleList] = useState<{ id: string; name: string }[]>([]);
  // What kind of NFA it is, and the words that find it.
  const [classification, setClassification] = useState("");
  const [keywords, setKeywords] = useState("");
  // "Manually assigning different approvers only within a hierarchy."
  const [withinLine, setWithinLine] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: tpl }, { data: fields }, { data: existingSlabs }, { data: emps }, { data: rules }, { data: tpls }] = await Promise.all([
        db.from("form_templates").select("name, followup_template_id, audience_departments, audience_roles, classification, keywords, forward_within_line").eq("id", templateId).maybeSingle(),
        db.from("form_fields").select("field_type, field_name, order_index").eq("form_template_id", templateId).order("order_index"),
        db.from("approval_slabs").select("*").eq("form_template_id", templateId).order("order_index"),
        db.from("employees").select("employee_id, name, designation").order("name"),
        db.from("approval_rules")
          .select("id, approver_user_id, deadline_days, is_auto_added, label, step_index, quorum, condition, stage_label, lane, position, require_signature, flag, remind_hours, warn_hours, escalate_days, escalate_levels")
          .eq("form_template_id", templateId)
          .order("step_index")
          .order("position"),
        db.from("form_templates").select("id, name").order("name"),
      ]);
      if (tpl?.name) setFormName(tpl.name);
      setAudience(((tpl as { audience_departments?: string[] | null } | null)?.audience_departments) ?? []);
      setAudienceRoles(((tpl as { audience_roles?: string[] | null } | null)?.audience_roles) ?? []);
      void db.from("roles").select("id, name").eq("status", "active").order("name").then(({ data }) =>
        setRoleList((data ?? []) as { id: string; name: string }[]));
      setClassification((tpl as { classification?: string | null } | null)?.classification ?? "");
      setKeywords(((tpl as { keywords?: string[] | null } | null)?.keywords ?? []).join(", "));
      setWithinLine(!!(tpl as { forward_within_line?: boolean | null } | null)?.forward_within_line);
      void db.from("departments").select("name").order("name").then(({ data }) =>
        setDepartments(((data ?? []) as { name: string }[]).map((d) => d.name)));
      setFollowup((tpl as { followup_template_id?: string | null } | null)?.followup_template_id ?? "");
      setTemplates(((tpls ?? []) as { id: string; name: string }[]).filter((t) => t.id !== templateId));
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
        setSlabs([
          { min_amount: "0", max_amount: "100000", approver_user_id: "EMP-0312" },
          { min_amount: "100000.01", max_amount: "500000", approver_user_id: "EMP-0600" },
          { min_amount: "500000.01", max_amount: "", approver_user_id: "EMP-0700" },
        ]);
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
  })();

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

    const { error: fuErr } = await db
      .from("form_templates")
      .update({
        followup_template_id: followup || null, audience_departments: audience.length ? audience : null,
        audience_roles: audienceRoles.length ? audienceRoles : null,
        classification: classification || null,
        keywords: [...new Set(keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean))],
        forward_within_line: withinLine,
      })
      .eq("id", templateId);
    if (fuErr) {
      toast.error("Failed to save the follow-up: " + fuErr.message);
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
            <StageEditor stages={stages} onChange={setStages} employees={employees} fieldLabels={fieldLabels} />
            <section className="rounded-xl bg-white mt-6" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>When it is approved</div>
              <div style={{ fontSize: 12, color: "#71717A", margin: "2px 0 10px" }}>
                Start a follow-up for the same requester, with every answer both forms ask already
                filled in. It waits as a draft for them to check and submit.
              </div>
              <select
                value={followup}
                onChange={(e) => setFollowup(e.target.value)}
                aria-label="Follow-up form"
                className="rounded-md bg-white"
                style={{ padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", minWidth: 280 }}
              >
                <option value="">Nothing follows</option>
                {templates.map((t) => <option key={t.id} value={t.id}>Start: {t.name}</option>)}
              </select>
            </section>
            <section className="rounded-xl bg-white mt-4" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }} data-testid="classification">
              <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>What it is, and how it is found</div>
              <div style={{ fontSize: 12, color: "#71717A", margin: "2px 0 10px" }}>
                NFAs are classified so they can be told apart in lists and reports; keywords find the form from the search box.
              </div>
              <div className="flex gap-3 flex-wrap">
                <select value={classification} onChange={(e) => setClassification(e.target.value)} aria-label="Classification"
                  className="rounded-md bg-white" style={{ padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", minWidth: 200 }}>
                  <option value="">Not classified</option>
                  <option value="budgetary">Budgetary</option>
                  <option value="non_budgetary">Non-budgetary</option>
                  <option value="regulatory">Regulatory</option>
                  <option value="operational">Operational</option>
                </select>
                <input value={keywords} onChange={(e) => setKeywords(e.target.value)} aria-label="Keywords" placeholder="Keywords, separated by commas"
                  className="rounded-md bg-white" style={{ padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", flex: 1, minWidth: 240 }} />
              </div>
              <label className="flex items-start gap-2 mt-3" style={{ fontSize: 13, color: "#3F3F46" }}>
                <input type="checkbox" checked={withinLine} onChange={(e) => setWithinLine(e.target.checked)}
                  aria-label="Forward only within the reporting line" style={{ marginTop: 3 }} />
                <span>
                  Forward only within the reporting line
                  <span style={{ display: "block", fontSize: 12, color: "#71717A" }}>
                    An approver may pass their step to the people above or below them, and nobody else.
                  </span>
                </span>
              </label>
            </section>
            <section className="rounded-xl bg-white mt-4" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }} data-testid="audience">
              <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>Who can raise it</div>
              <div style={{ fontSize: 12, color: "#71717A", margin: "2px 0 10px" }}>
                Offered only to people in these departments, or holding these roles. Leave all unticked for everybody.
              </div>
              <div className="flex flex-wrap gap-2">
                {departments.map((d) => {
                  const on = audience.includes(d);
                  return (
                    <label key={d} className="inline-flex items-center gap-1.5 rounded-md" style={{ padding: "4px 9px", fontSize: 12.5, border: `1px solid ${on ? "#C7D2FE" : "#E4E4E7"}`, background: on ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
                      <input type="checkbox" checked={on} name={`audience-${d}`}
                        onChange={() => setAudience((a) => on ? a.filter((x) => x !== d) : [...a, d])} />
                      {d}
                    </label>
                  );
                })}
                {departments.length === 0 && <span style={{ fontSize: 12, color: "#A1A1AA" }}>No departments yet.</span>}
              </div>
              {roleList.length > 0 && (
                <>
                  <div style={{ fontSize: 12, color: "#71717A", margin: "12px 0 6px" }}>Roles</div>
                  <div className="flex flex-wrap gap-2" data-testid="audience-roles">
                    {roleList.map((r) => {
                      const on = audienceRoles.includes(r.id);
                      return (
                        <label key={r.id} className="inline-flex items-center gap-1.5 rounded-md" style={{ padding: "4px 9px", fontSize: 12.5, border: `1px solid ${on ? "#C7D2FE" : "#E4E4E7"}`, background: on ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
                          <input type="checkbox" checked={on} name={`audience-role-${r.name}`}
                            onChange={() => setAudienceRoles((a) => on ? a.filter((x) => x !== r.id) : [...a, r.id])} />
                          {r.name}
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          </>
        }
      />
      )}
      {fieldTypes.has("money") && (
        <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: 18, margin: "16px 24px" }}>
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
          <div className="flex flex-col gap-2">
            {slabs.map((s, i) => (
              <div key={i} className="flex items-center gap-2" style={{ padding: "8px 0", borderTop: i > 0 ? "1px solid #F4F4F5" : "none" }}>
                <span style={{ color: "#A1A1AA", fontSize: 12 }}>from</span>
                <input
                  type="number"
                  placeholder="Amount"
                  value={s.min_amount}
                  onChange={(e) => updateSlab(i, { min_amount: e.target.value })}
                  style={{ width: 110, padding: "6px 8px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6 }}
                />
                <span style={{ color: "#A1A1AA", fontSize: 12 }}>and above</span>
                <select
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
    </BuilderChrome>
  );
}
