import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Link2, Loader2, Sparkles, User } from "lucide-react";
import { db } from "@/lib/db";
import { validateField } from "@/lib/validateField";
import { evaluateFormula } from "@/lib/formula";
import { toast } from "sonner";
import { FieldRenderer } from "@/components/builder/FieldRenderer";
import type { FieldKind, PlacedField } from "@/components/builder/types";
import { DEFAULT_LABELS, isEmbedded, isPermission } from "@/components/builder/palette";
import { resolveSlabChain, type ApprovalSlab } from "@/lib/approvalSlabs";

export const Route = createFileRoute("/forms/$formId")({
  // Resuming a draft is the same screen with something already in it.
  validateSearch: (search: Record<string, unknown>): { draft?: string } => ({
    draft: typeof search.draft === "string" ? search.draft : undefined,
  }),
  head: () => ({ meta: [{ title: "Fill Form · Admin Services Portal" }] }),
  component: FillFormPage,
});

type EmployeeRow = {
  employee_id: string;
  name: string;
  designation: string | null;
  department: string | null;
  gate_pass_card_number: string | null;
};

type ApproverRule = {
  approver_user_id: string | null;
  deadline_days: number | null;
  label: string | null;
  is_auto_added: boolean | null;
  employee?: { name: string; designation: string | null };
};

type NotifRule = {
  notifyee_user_id: string | null;
  label: string | null;
  is_auto_added: boolean | null;
  employee?: { name: string; designation: string | null };
};

type WizardStep = {
  title: string;
  subtitle: string;
  fields: PlacedField[];
};

function FillFormPage() {
  // Whoever the viewer is acting as. This was a constant that named one
  // person and carried somebody else's id, so the screen said one name
  // and the submission recorded another.
  const { currentUser } = useCurrentUser();
  const { formId } = Route.useParams();
  const navigate = useNavigate();

  const [formName, setFormName] = useState("Form");
  const [fields, setFields] = useState<PlacedField[]>([]);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const { draft: draftId } = Route.useSearch();
  // The submission being edited. Set from ?draft= on arrival, or the
  // moment a draft is first saved, so saving twice updates one row
  // rather than leaving a trail of abandoned ones.
  const [openDraft, setOpenDraft] = useState<string | null>(draftId ?? null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [employeeData, setEmployeeData] = useState<EmployeeRow | null>(null);
  const [approvalRules, setApprovalRules] = useState<ApproverRule[]>([]);
  const [notifRules, setNotifRules] = useState<NotifRule[]>([]);
  const [slabs, setSlabs] = useState<ApprovalSlab[]>([]);
  const [empMap, setEmpMap] = useState<Record<string, { name: string; designation: string | null }>>({});

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      const [{ data: tpl }, { data: rows }, { data: aRules }, { data: nRules }, { data: slabRows }] =
        await Promise.all([
          db.from("form_templates").select("name").eq("id", formId).maybeSingle(),
          db.from("form_fields").select("*").eq("form_template_id", formId).order("order_index"),
          db.from("approval_rules").select("*").eq("form_template_id", formId),
          db.from("notification_rules").select("*").eq("form_template_id", formId),
          db.from("approval_slabs").select("*").eq("form_template_id", formId).order("order_index"),
        ]);
      if (cancel) return;

      if (tpl?.name) setFormName(tpl.name);
      setSlabs((slabRows ?? []) as ApprovalSlab[]);

      const placed: PlacedField[] = (rows ?? []).map((row) => {
        const cfg = (row.field_config as { helper?: string; options?: string[]; placeholder?: string; formula?: string } | null) ?? {};
        const kind = (row.field_type ?? "text") as FieldKind;
        return {
          id: row.id,
          kind,
          label: row.field_name ?? DEFAULT_LABELS[kind] ?? "Field",
          required: row.is_required ?? false,
          helper: cfg.helper ?? "",
          options: cfg.options,
          placeholder: cfg.placeholder,
          formula: cfg.formula,
          order_index: row.order_index ?? 0,
        };
      });
      setFields(placed);

      // Enrich rules with employee names (including possible slab approvers)
      const approverIds = (aRules ?? []).map((r) => r.approver_user_id).filter(Boolean) as string[];
      const notifIds = (nRules ?? []).map((r) => r.notifyee_user_id).filter(Boolean) as string[];
      const slabIds = (slabRows ?? []).map((s) => s.approver_user_id).filter(Boolean) as string[];
      const allIds = Array.from(new Set([...approverIds, ...notifIds, ...slabIds]));
      let empMap: Record<string, { name: string; designation: string | null }> = {};
      if (allIds.length > 0) {
        const { data: emps } = await db
          .from("employees")
          .select("employee_id, name, designation")
          .in("employee_id", allIds);
        (emps ?? []).forEach((e) => { empMap[e.employee_id] = { name: e.name, designation: e.designation }; });
      }
      setEmpMap(empMap);

      setApprovalRules((aRules ?? []).map((r) => ({ ...r, employee: r.approver_user_id ? empMap[r.approver_user_id] : undefined })));
      setNotifRules((nRules ?? []).map((r) => ({ ...r, employee: r.notifyee_user_id ? empMap[r.notifyee_user_id] : undefined })));
      setLoading(false);
    })();
    return () => { cancel = true; };
  }, [formId]);

  const steps: WizardStep[] = useMemo(() => {
    const employeeFields = fields.filter((f) => f.kind === "employee" || f.kind.startsWith("gen_"));
    const linkedFields = fields.filter((f) => isEmbedded(f.kind));
    const mainFields = fields.filter(
      (f) => !isPermission(f.kind) && !f.kind.startsWith("gen_") && !isEmbedded(f.kind) && f.kind !== "employee"
    );
    const result: WizardStep[] = [];
    if (employeeFields.length > 0)
      result.push({ title: "Employee Details", subtitle: "Identify the departing employee", fields: employeeFields });
    if (linkedFields.length > 0)
      result.push({ title: "Linked Forms", subtitle: "Confirm auto-linked workflows", fields: linkedFields });
    if (mainFields.length > 0)
      result.push({ title: "Form Details", subtitle: "Complete the remaining fields", fields: mainFields });
    result.push({ title: "Review & Submit", subtitle: "Confirm your answers before submitting", fields: [] });
    return result;
  }, [fields]);

  // The person filling the form in, so the fields marked "auto-filled"
  // have something to fill from.
  //
  // employeeData was only ever set by an employee-picker field, and no
  // seeded form has one — so every gen_ field resolved to an empty
  // string, and because they are required, handleNext refused to move
  // on. Four of the five forms could not be submitted at all, and the
  // field the person was told to fill had no input to fill it with.
  useEffect(() => {
    if (!currentUser.employee_id) return;
    let cancelled = false;
    (async () => {
      const { data } = await db
        .from("employees")
        .select("employee_id, name, designation, department, gate_pass_card_number")
        .eq("employee_id", currentUser.employee_id)
        .maybeSingle();
      // A picker on the form still wins: it is asking about somebody
      // else, which is the whole point of having one.
      if (!cancelled && data) setEmployeeData((prev) => prev ?? (data as EmployeeRow));
    })();
    return () => { cancelled = true; };
  }, [currentUser.employee_id]);

  function setValue(id: string, v: unknown) {
    setValues((prev) => ({ ...prev, [id]: v }));
    const field = fields.find((f) => f.id === id);
    if (field?.kind === "employee" && v && typeof v === "object") {
      setEmployeeData(v as EmployeeRow);
    }
  }

  function genValue(kind: FieldKind): string {
    if (!employeeData) return "";
    if (kind === "gen_employee_name") return employeeData.name;
    if (kind === "gen_designation") return employeeData.designation ?? "";
    if (kind === "gen_gate_pass") return employeeData.gate_pass_card_number ?? "";
    return "";
  }

  // What is wrong with this field, or null. This used to answer only
  // "is it empty", so every min, max, length and pattern the builder
  // collected went unenforced — and a date range passed with one end
  // filled, because it asked whether *every* half was empty.
  function problemWith(field: PlacedField): string | null {
    if (isPermission(field.kind) || field.kind === "calculation") return null;
    if (field.kind.startsWith("gen_")) {
      return field.required && !genValue(field.kind) ? `${field.label} is required` : null;
    }
    return validateField(field, values[field.id]);
  }

  function handleNext() {
    const current = steps[stepIndex];
    const problems = current.fields.map(problemWith).filter(Boolean) as string[];
    if (problems.length > 0) {
      toast.error(problems[0]);
      return;
    }
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  }

  // Values are stored against the field's label rather than its id,
  // because that is what a submission is read back as. Coming the other
  // way means matching on the label, which is why two fields sharing one
  // label would collide — the builder should not allow that, and this is
  // where it would show.
  useEffect(() => {
    if (!openDraft || fields.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await db
        .from("submission_values")
        .select("field_name, value")
        .eq("submission_id", openDraft);
      if (cancelled || !data?.length) return;

      const byLabel: Record<string, string> = {};
      data.forEach((row) => { byLabel[row.field_name] = row.value; });

      setValues((prev) => {
        const next = { ...prev };
        for (const f of fields) {
          const saved = byLabel[f.label];
          if (saved === undefined) continue;
          next[f.id] = f.kind === "checkbox" ? saved === "Yes" : saved;
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDraft, fields.length]);

  /** Every answer, in the shape submission_values wants. */
  function answerRows(submissionId: string) {
    return fields
      .filter((f) => !isPermission(f.kind))
      .map((f) => {
        const str = f.kind.startsWith("gen_") ? genValue(f.kind) : (() => {
          if (f.kind === "calculation" && f.formula) {
            const result = evaluateFormula(f.formula, fields, values, f.id);
            return result !== null ? String(result) : "";
          }
          const v = values[f.id];
          if (v === undefined || v === null) return "";
          if (typeof v === "string") return v;
          if (typeof v === "boolean") return v ? "Yes" : "No";
          if (typeof v === "number") return String(v);
          return JSON.stringify(v);
        })();
        return { submission_id: submissionId, field_name: f.label, value: str };
      });
  }

  /**
   * Keep what has been entered without asking anybody to approve it.
   *
   * A draft deliberately gets no approval chain — that is the whole
   * difference between saving and submitting, and it is why nobody is
   * notified. Values are replaced rather than merged, so the draft is
   * always exactly what is on screen.
   */
  async function handleSaveDraft() {
    setSavingDraft(true);
    try {
      let id = openDraft;

      if (!id) {
        const { data, error } = await db
          .from("form_submissions")
          .insert({ form_template_id: formId, submitted_by: currentUser.employee_id, status: "draft" })
          .select("id")
          .single();
        if (error || !data) { toast.error("Could not save the draft: " + (error?.message ?? "unknown")); return; }
        id = data.id as string;
        setOpenDraft(id);
      }

      await db.from("submission_values").delete().eq("submission_id", id);
      const rows = answerRows(id).filter((r) => r.value !== "");
      if (rows.length) await db.from("submission_values").insert(rows);

      toast.success("Draft saved — it is in My Submissions");
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleSubmit() {
    // Every field, not the current step's. handleNext only ever checked
    // the step being left, so the last step was never checked at all —
    // and a single-step form was never checked once.
    const firstBad = fields.find((fl) => problemWith(fl) !== null);
    if (firstBad) {
      const offending = steps.findIndex((st) => st.fields.some((fl) => fl.id === firstBad.id));
      // Land on the step that needs attention rather than naming a
      // field the submitter cannot see from here.
      if (offending >= 0 && offending !== stepIndex) setStepIndex(offending);
      toast.error(problemWith(firstBad)!);
      return;
    }

    setSubmitting(true);
    try {
      // A draft becomes the submission rather than spawning a second
      // one, so resuming and submitting leaves one row with one history.
      let sub: { id: string } | null = null;

      if (openDraft) {
        const { error } = await db
          .from("form_submissions")
          .update({ status: "submitted", submitted_at: new Date().toISOString() })
          .eq("id", openDraft);
        if (error) { toast.error("Failed to submit: " + error.message); return; }
        await db.from("submission_values").delete().eq("submission_id", openDraft);
        sub = { id: openDraft };
      } else {
        const { data, error } = await db
          .from("form_submissions")
          .insert({ form_template_id: formId, submitted_by: currentUser.employee_id, status: "submitted" })
          .select("id")
          .single();
        if (error || !data) { toast.error("Failed to submit: " + (error?.message ?? "unknown")); return; }
        sub = { id: data.id as string };
      }

      const valueRows = fields
        .filter((f) => !isPermission(f.kind))
        .map((f) => {
          let str = f.kind.startsWith("gen_") ? genValue(f.kind) : (() => {
            if (f.kind === "calculation" && f.formula) {
              const result = evaluateFormula(f.formula, fields, values, f.id);
              return result !== null ? String(result) : "";
            }
            const v = values[f.id];
            if (v === undefined || v === null) return "";
            if (typeof v === "string") return v;
            if (typeof v === "boolean") return v ? "Yes" : "No";
            if (typeof v === "number") return String(v);
            return JSON.stringify(v);
          })();
          return { submission_id: sub.id, field_name: f.label, value: str };
        });
      if (valueRows.length > 0) await db.from("submission_values").insert(valueRows);

      // How far a claim climbs depends on the amount, so the amount is
      // what gets sent. Which approvers that means, in what order, and
      // which of them is live is decided in the database — it is several
      // rows that have to agree, and it must not be a client's opinion.
      const moneyField = fields.find((f) => f.kind === "money");
      const moneyAmount = moneyField
        ? parseFloat(String(values[moneyField.id] ?? "0").replace(/[^0-9.]/g, "")) || 0
        : 0;

      const { error: chainErr } = await db.rpc("build_approval_chain", {
        p_subject_type: "form_submission",
        p_subject_id: sub.id,
        p_form_template_id: formId,
        p_amount: moneyAmount,
      });
      if (chainErr) {
        // The submission exists; only its routing failed. Saying
        // "submitted" and nothing else would leave it invisible.
        toast.error("Submitted, but approvals were not set up: " + chainErr.message);
      }

      toast.success("Submitted successfully!");
      navigate({ to: "/status/$submissionId", params: { submissionId: sub.id } });
    } finally {
      setSubmitting(false); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex items-center gap-2 text-sm" style={{ color: "#71717A" }}>
          <Loader2 size={14} className="animate-spin" /> Loading form…
        </div>
      </div>
    );
  }

  if (steps.length === 0) {
    return <div className="flex items-center justify-center min-h-screen text-sm" style={{ color: "#71717A" }}>This form has no fields.</div>;
  }

  const current = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;

  return (
    <div className="min-h-screen" style={{ background: "var(--color-zinc-50)" }}>
      {/* Header */}
      <div className="bg-white flex items-center gap-3" style={{ height: 56, padding: "0 24px", borderBottom: "1px solid #E4E4E7" }}>
        <span className="rounded-full" style={{ width: 10, height: 10, background: "var(--color-brand-500)", boxShadow: "0 0 0 4px color-mix(in oklab, var(--color-brand-500) 10%, transparent)" }} />
        <span className="font-semibold text-[14px]" style={{ color: "#18181B" }}>{formName}</span>
        <span className="ml-auto text-[12px]" style={{ color: "#71717A" }}>
          Submitting as <span className="font-medium" style={{ color: "#18181B" }}>{currentUser.name}</span>
        </span>
      </div>

      {/* Step progress */}
      <div className="bg-white" style={{ borderBottom: "1px solid #F4F4F5", padding: "16px 24px" }}>
        <div style={{ maxWidth: 600, margin: "0 auto" }}>
          <div className="flex items-center">
            {steps.map((s, i) => (
              <div key={i} className="flex items-center" style={{ flex: i < steps.length - 1 ? 1 : "none" }}>
                <div className="flex flex-col items-center gap-1">
                  <div
                    className="flex items-center justify-center rounded-full font-semibold transition-all duration-200"
                    style={{
                      width: 28, height: 28, fontSize: 12,
                      background: i <= stepIndex ? "var(--color-brand-500)" : "#F4F4F5",
                      color: i <= stepIndex ? "#fff" : "#A1A1AA",
                      border: i === stepIndex ? "2px solid var(--color-brand-600)" : "2px solid transparent",
                    }}
                  >
                    {i < stepIndex ? <CheckCircle2 size={13} /> : i + 1}
                  </div>
                  <span className="text-[10px] font-medium whitespace-nowrap" style={{ color: i === stepIndex ? "var(--color-brand-600)" : i < stepIndex ? "#52525B" : "#A1A1AA" }}>
                    {s.title}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className="flex-1 h-px mx-2 mb-4 transition-all duration-200" style={{ background: i < stepIndex ? "var(--color-brand-400)" : "#E4E4E7" }} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: "32px 24px 100px" }}>
        <div style={{ maxWidth: 600, margin: "0 auto" }}>
          <div className="mb-6">
            <h2 className="font-semibold text-[18px]" style={{ color: "#18181B" }}>{current.title}</h2>
            <p className="text-[13px] mt-1" style={{ color: "#71717A" }}>{current.subtitle}</p>
          </div>

          {isLastStep ? (
            <SummaryStep fields={fields} values={values} genValue={genValue} approvalRules={approvalRules} notifRules={notifRules} employeeData={employeeData} slabs={slabs} empMap={empMap} />
          ) : (
            <div className="flex flex-col gap-3.5">
              {current.fields.map((f) =>
                f.kind.startsWith("gen_") ? (
                  <GenFieldDisplay key={f.id} field={f} value={genValue(f.kind)} />
                ) : (
                  <FieldRenderer key={f.id} field={f} value={values[f.id]} onChange={(v) => setValue(f.id, v)} allFields={fields} allValues={values} />
                )
              )}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between mt-8">
            <button
              onClick={stepIndex === 0 ? () => window.history.back() : () => setStepIndex((i) => i - 1)}
              className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border bg-white"
              style={{ padding: "8px 14px", borderColor: "#E4E4E7", color: "#3F3F46" }}
            >
              <ChevronLeft size={14} />
              {stepIndex === 0 ? "Cancel" : "Back"}
            </button>

            <div className="flex items-center gap-3">
              <span className="text-[12px]" style={{ color: "#A1A1AA" }}>Step {stepIndex + 1} of {steps.length}</span>
              {isLastStep ? (
                <>
                <button
                  onClick={handleSaveDraft}
                  disabled={savingDraft || submitting}
                  className="rounded-md font-medium bg-white"
                  style={{
                    padding: "10px 16px", fontSize: 13.5, color: "#52525B",
                    border: "1px solid #E4E4E7", marginRight: 8,
                    cursor: savingDraft ? "not-allowed" : "pointer",
                  }}
                >
                  {savingDraft ? "Saving…" : openDraft ? "Update draft" : "Save draft"}
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-white"
                  style={{ padding: "8px 18px", background: "var(--color-brand-500)", opacity: submitting ? 0.7 : 1, cursor: submitting ? "not-allowed" : "pointer" }}
                >
                  {submitting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  {submitting ? "Submitting…" : "Confirm & Submit"}
                </button>
                </>
              ) : (
                <button
                  onClick={handleNext}
                  className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-white"
                  style={{ padding: "8px 16px", background: "var(--color-brand-500)" }}
                >
                  Next <ChevronRight size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GenFieldDisplay({ field, value }: { field: PlacedField; value: string }) {
  return (
    <div className="rounded-[10px]" style={{ background: "#fff", border: "1px solid #FBC5DF", padding: "14px 16px" }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center justify-center rounded-md" style={{ width: 22, height: 22, background: "#FDE8F2", color: "#C40F5E" }}>
          <Sparkles size={12} />
        </span>
        <span className="font-medium text-[13px]" style={{ color: "#18181B" }}>{field.label}</span>
        <span className="inline-flex items-center gap-1 rounded-full font-medium ml-auto" style={{ padding: "2px 8px", fontSize: 11, background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE" }}>
          <Sparkles size={10} /> Auto-filled
        </span>
      </div>
      <div className="rounded-md text-[13px]" style={{ padding: "9px 12px", background: "#FAFAFA", border: "1px solid #E4E4E7", color: value ? "#18181B" : "#A1A1AA", fontStyle: value ? "normal" : "italic" }}>
        {value || "Will auto-populate from Employee ID"}
      </div>
    </div>
  );
}

function SummaryStep({ fields, values, genValue, approvalRules, notifRules, employeeData, slabs, empMap }: {
  fields: PlacedField[];
  values: Record<string, unknown>;
  genValue: (kind: FieldKind) => string;
  approvalRules: ApproverRule[];
  notifRules: NotifRule[];
  employeeData: EmployeeRow | null;
  slabs: ApprovalSlab[];
  empMap: Record<string, { name: string; designation: string | null }>;
}) {
  const displayFields = fields.filter((f) => !isPermission(f.kind) && !isEmbedded(f.kind));
  const hasLinked = fields.some((f) => isEmbedded(f.kind));
  const cardNumber = employeeData?.gate_pass_card_number;

  // Resolve slab-based approver/notifier from current money field value
  const moneyField = fields.find((f) => f.kind === "money");
  const moneyAmount = moneyField
    ? parseFloat(String(values[moneyField.id] ?? "0").replace(/[^0-9.]/g, "")) || 0
    : 0;
  // One rule labelled slab_finance becomes as many steps as the amount
  // has thresholds, so the person submitting sees the whole ladder
  // before they commit to it rather than the top of it afterwards.
  const financeChain = resolveSlabChain(moneyAmount, slabs);
  const inChain = new Set(financeChain);
  const slabApproverIds = new Set(slabs.map((s) => s.approver_user_id));

  const resolvedApprovalRules: ApproverRule[] = approvalRules.flatMap((r) => {
    if (r.label !== "slab_finance") return [r];
    return financeChain.map((id) => ({ ...r, approver_user_id: id, employee: empMap[id] }));
  });

  const resolvedNotifRules: NotifRule[] = notifRules.filter((r) => {
    if (r.notifyee_user_id && slabApproverIds.has(r.notifyee_user_id)) {
      return inChain.has(r.notifyee_user_id);
    }
    return true;
  });

  function displayValue(f: PlacedField): string {
    if (f.kind.startsWith("gen_")) return genValue(f.kind) || "—";
    const v = values[f.id];
    if (v === undefined || v === null || v === "") return "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if ("from" in obj || "to" in obj) return `${obj.from ?? "?"} → ${obj.to ?? "?"}`;
      if ("name" in obj) return String((obj as { name?: string }).name ?? "");
    }
    return String(v);
  }

  function deadline(days: number | null) {
    const d = new Date();
    d.setDate(d.getDate() + (days ?? 7));
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Answers */}
      <div className="rounded-xl bg-white overflow-hidden" style={{ border: "1px solid #E4E4E7" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #F4F4F5", background: "#FAFAFA" }}>
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#52525B" }}>Your Answers</span>
        </div>
        <div>
          {displayFields.map((f, i) => (
            <div key={f.id} className="flex items-start justify-between gap-4" style={{ padding: "10px 16px", borderBottom: i < displayFields.length - 1 ? "1px solid #F4F4F5" : "none" }}>
              <span className="text-[12px]" style={{ color: "#71717A", minWidth: 140 }}>{f.label}</span>
              <span className="text-[13px] font-medium text-right" style={{ color: "#18181B" }}>{displayValue(f)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Gate pass notice */}
      {hasLinked && cardNumber && (
        <div className="rounded-xl flex items-start gap-3" style={{ padding: "14px 16px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
          <Link2 size={14} style={{ color: "#B45309", marginTop: 1, flexShrink: 0 }} />
          <div>
            <div className="text-[13px] font-semibold" style={{ color: "#92400E" }}>Gate Pass Revocation will be auto-submitted</div>
            <div className="text-[12px] mt-0.5" style={{ color: "#B45309" }}>Card #{cardNumber} will be revoked upon full approval of this form.</div>
          </div>
        </div>
      )}

      {/* Who approves */}
      {resolvedApprovalRules.length > 0 && (
        <div className="rounded-xl bg-white overflow-hidden" style={{ border: "1px solid #E4E4E7" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #F4F4F5", background: "#FAFAFA" }}>
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#52525B" }}>Who will approve</span>
          </div>
          <div>
            {resolvedApprovalRules.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-3" style={{ padding: "10px 16px", borderBottom: i < resolvedApprovalRules.length - 1 ? "1px solid #F4F4F5" : "none" }}>
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center justify-center rounded-full font-semibold" style={{ width: 28, height: 28, background: "#FDE8F2", color: "#C40F5E", fontSize: 11 }}>
                    <User size={12} />
                  </span>
                  <div>
                    <div className="text-[13px] font-medium" style={{ color: "#18181B" }}>{r.employee?.name ?? r.approver_user_id}</div>
                    {r.employee?.designation && <div className="text-[11px]" style={{ color: "#71717A" }}>{r.employee.designation}</div>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px]" style={{ color: "#71717A" }}>Due by</div>
                  <div className="text-[12px] font-medium" style={{ color: "#3F3F46" }}>{deadline(r.deadline_days)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Who gets notified */}
      {resolvedNotifRules.length > 0 && (
        <div className="rounded-xl bg-white overflow-hidden" style={{ border: "1px solid #E4E4E7" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #F4F4F5", background: "#FAFAFA" }}>
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#52525B" }}>Who will be notified</span>
          </div>
          <div className="flex flex-wrap gap-2" style={{ padding: "12px 16px" }}>
            {resolvedNotifRules.map((r, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-full text-[12px] font-medium" style={{ padding: "4px 10px", background: "#F4F4F5", color: "#3F3F46", border: "1px solid #E4E4E7" }}>
                <User size={11} /> {r.employee?.name ?? r.notifyee_user_id}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
