import { useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { FieldRenderer } from "./FieldRenderer";
import { isEmbedded, isPermission, isLayout } from "./palette";
import { evaluateFormula } from "@/lib/formula";
import type { PlacedField } from "./types";

type PreviewStep = {
  title: string;
  subtitle: string;
  fields: PlacedField[];
};

function groupSteps(fields: PlacedField[]): PreviewStep[] {
  const employeeFields = fields.filter((f) => f.kind === "employee" || f.kind.startsWith("gen_"));
  const linkedFields = fields.filter((f) => isEmbedded(f.kind));

  // Section headers whose sibling data fields ended up in a different step group look
  // orphaned and confusing. Keep only those that have at least one data field immediately
  // following them (before the next section header) within this same group.
  const rawMain = fields.filter(
    (f) =>
      !isPermission(f.kind) &&
      !f.kind.startsWith("gen_") &&
      !isEmbedded(f.kind) &&
      f.kind !== "employee",
  );

  const mainFields = rawMain.filter((f, i, arr) => {
    if (!isLayout(f.kind)) return true;
    // Keep a section_header only if it is followed by at least one data field
    // before the next section_header (or end of array).
    const rest = arr.slice(i + 1);
    const nextDivider = rest.findIndex((x) => isLayout(x.kind));
    const between = nextDivider >= 0 ? rest.slice(0, nextDivider) : rest;
    return between.some((x) => !isLayout(x.kind));
  });

  const steps: PreviewStep[] = [];
  if (employeeFields.length > 0)
    steps.push({ title: "Employee Details", subtitle: "Identify the employee", fields: employeeFields });
  if (linkedFields.length > 0)
    steps.push({ title: "Linked Forms", subtitle: "Auto-linked workflows will be created", fields: linkedFields });
  if (mainFields.length > 0)
    steps.push({ title: "Form Details", subtitle: "Fill in the required fields", fields: mainFields });
  steps.push({ title: "Review & Submit", subtitle: "Confirm your answers before submitting", fields: [] });
  return steps;
}

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          style={{
            width: i === current ? 20 : 8,
            height: 8,
            borderRadius: 9999,
            background: i < current ? "var(--color-brand-500)" : i === current ? "var(--color-brand-500)" : "#E4E4E7",
            opacity: i < current ? 0.4 : 1,
            transition: "width 200ms, background 200ms",
          }}
        />
      ))}
    </div>
  );
}

function evalForSummary(
  formula: string,
  fields: PlacedField[],
  values: Record<string, unknown>,
  selfId?: string,
): string | null {
  const n = evaluateFormula(formula, fields, values, selfId);
  return n === null ? null : n.toLocaleString();
}

function SummaryTable({ fields, values }: { fields: PlacedField[]; values: Record<string, unknown> }) {
  const dataFields = fields.filter((f) => !isPermission(f.kind) && !isLayout(f.kind) && !f.kind.startsWith("gen_"));
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #E4E4E7" }}>
      <div
        className="grid uppercase font-semibold"
        style={{ gridTemplateColumns: "1fr 1.5fr", background: "#FAFAFA", borderBottom: "1px solid #E4E4E7", padding: "8px 12px", fontSize: 10, letterSpacing: "0.06em", color: "#71717A", gap: 8 }}
      >
        <span>Field</span>
        <span>Answer</span>
      </div>
      {dataFields.map((f) => {
        let display = "—";
        if (f.kind === "calculation" && f.formula) {
          const result = evalForSummary(f.formula, fields, values, f.id);
          if (result !== null) display = result;
        } else {
          const v = values[f.id];
          if (v !== undefined && v !== null && v !== "") {
            if (Array.isArray(v)) display = v.join(", ");
            else if (typeof v === "object") display = JSON.stringify(v);
            else display = String(v);
          }
        }
        return (
          <div
            key={f.id}
            className="grid"
            style={{ gridTemplateColumns: "1fr 1.5fr", padding: "10px 12px", gap: 8, borderBottom: "1px solid #F4F4F5", fontSize: 12.5 }}
          >
            <span style={{ color: "#71717A", fontWeight: 500 }}>{f.label}</span>
            <span style={{ color: display === "—" ? "#A1A1AA" : "#18181B", fontWeight: f.kind === "calculation" ? 600 : 400 }}>
              {display}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function LivePreview({ fields, formName }: { fields: PlacedField[]; formName: string }) {
  const steps = useMemo(() => groupSteps(fields), [fields]);
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitted, setSubmitted] = useState(false);

  const currentStep = steps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  function handleChange(fieldId: string, value: unknown) {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  if (fields.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: "#FAFAFA" }}>
        <div className="text-center" style={{ maxWidth: 340 }}>
          <div
            className="inline-flex items-center justify-center rounded-full mx-auto mb-4"
            style={{ width: 48, height: 48, background: "#F4F4F5", color: "#A1A1AA" }}
          >
            <Eye size={22} />
          </div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "#18181B", margin: "0 0 8px" }}>No fields to preview</h3>
          <p style={{ fontSize: 13, color: "#71717A", lineHeight: 1.6, margin: 0 }}>
            Switch back to Build mode and drag some fields onto the canvas to see a live preview here.
          </p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: "#FAFAFA", padding: "40px 24px" }}>
        <div
          className="w-full text-center rounded-2xl"
          style={{ maxWidth: 480, background: "#fff", padding: "48px 40px", boxShadow: "0 4px 24px rgba(0,0,0,0.07)" }}
        >
          <div className="inline-flex items-center justify-center rounded-full mx-auto mb-5" style={{ width: 56, height: 56, background: "#F0FDF4" }}>
            <CheckCircle2 size={28} style={{ color: "#16A34A" }} />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: "#18181B", margin: "0 0 8px" }}>Submission preview complete</h3>
          <p style={{ fontSize: 13.5, color: "#71717A", lineHeight: 1.6, margin: "0 0 28px" }}>
            In production, this would create a submission record and notify the approvers.
          </p>
          <button
            onClick={() => { setSubmitted(false); setStepIndex(0); setValues({}); }}
            style={{ padding: "9px 20px", fontSize: 13, fontWeight: 500, borderRadius: 8, border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46", cursor: "pointer" }}
          >
            Reset preview
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 scroll-thin overflow-auto"
      style={{ background: "#FAFAFA", padding: "32px 24px 80px" }}
    >
      {/* Preview banner */}
      <div
        className="flex items-center gap-2.5 rounded-lg mb-6"
        style={{ maxWidth: 600, margin: "0 auto 20px", padding: "10px 14px", background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 12.5, color: "#92400E" }}
      >
        <Eye size={14} style={{ color: "#B45309", flexShrink: 0 }} />
        <span>
          <strong>Preview mode</strong> — This is an exact replica of what users will fill. No data is submitted or saved.
        </span>
      </div>

      {/* Form card */}
      <div
        className="w-full rounded-2xl overflow-hidden"
        style={{ maxWidth: 600, margin: "0 auto", background: "#fff", boxShadow: "0 2px 20px rgba(0,0,0,0.08)" }}
      >
        {/* Brand header bar */}
        <div style={{ background: "var(--color-brand-500)", padding: "20px 28px 18px" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{formName}</div>
          <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.75)" }}>HR Department · Admin Services</div>
        </div>

        {/* Step progress */}
        <div className="flex items-center gap-4" style={{ padding: "16px 28px", borderBottom: "1px solid #F4F4F5", background: "#FAFAFA" }}>
          <StepDots total={steps.length} current={stepIndex} />
          <div className="ml-auto text-right">
            <div style={{ fontSize: 12, fontWeight: 600, color: "#18181B" }}>
              Step {stepIndex + 1} of {steps.length}
            </div>
            <div style={{ fontSize: 11, color: "#A1A1AA" }}>{currentStep?.title}</div>
          </div>
        </div>

        {/* Step content */}
        <div style={{ padding: "24px 28px 20px" }}>
          {currentStep && (
            <>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "#18181B", margin: "0 0 4px" }}>{currentStep.title}</h2>
                <p style={{ fontSize: 12.5, color: "#71717A", margin: 0 }}>{currentStep.subtitle}</p>
              </div>

              {isLast ? (
                <SummaryTable fields={fields} values={values} />
              ) : (
                <div className="flex flex-col gap-4">
                  {currentStep.fields.map((f) => (
                    <FieldRenderer
                      key={f.id}
                      field={f}
                      value={values[f.id]}
                      onChange={(v) => handleChange(f.id, v)}
                      allFields={fields}
                      allValues={values}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Navigation */}
        <div
          className="flex items-center justify-between"
          style={{ padding: "16px 28px", borderTop: "1px solid #F4F4F5" }}
        >
          <button
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={isFirst}
            className="inline-flex items-center gap-1.5"
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 8,
              border: "1px solid #E4E4E7",
              background: "#fff",
              color: isFirst ? "#D4D4D8" : "#3F3F46",
              cursor: isFirst ? "not-allowed" : "pointer",
            }}
          >
            <ChevronLeft size={14} /> Back
          </button>

          {isLast ? (
            <button
              onClick={() => setSubmitted(true)}
              className="inline-flex items-center gap-1.5"
              style={{
                padding: "8px 18px",
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 8,
                border: "none",
                background: "var(--color-brand-500)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Submit Form
            </button>
          ) : (
            <button
              onClick={() => setStepIndex((i) => Math.min(steps.length - 1, i + 1))}
              className="inline-flex items-center gap-1.5"
              style={{
                padding: "8px 18px",
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 8,
                border: "none",
                background: "var(--color-brand-500)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Next <ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
