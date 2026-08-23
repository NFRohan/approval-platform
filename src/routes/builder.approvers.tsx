import { LoadingRows } from "@/components/Loading";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { db } from "@/lib/db";
import { BuilderChrome, PrimaryButton, SecondaryButton } from "@/components/builder/BuilderChrome";
import { PeopleStep, type AutoEntry, type ManualEntry } from "@/components/builder/PeopleStep";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { Trash2, Plus } from "lucide-react";

const search = z.object({ templateId: z.string() });

export const Route = createFileRoute("/builder/approvers")({
  validateSearch: search,
  head: () => ({
    meta: [{ title: "Approvers · Form Builder" }],
  }),
  component: ApproversStep,
});

const ALL_AUTO_APPROVERS: AutoEntry[] = [
  {
    id: "auto-line-mgr",
    user_id: "EMP-1134",
    name: "Sara Khan",
    designation: "Line Manager",
    displayReason: "Added: Employee field",
    reason: "Added: Employee field",
    deadlineDays: 7,
    _requires: "employee",
  } as AutoEntry & { _requires: string },
  {
    id: "auto-admin",
    user_id: "EMP-0445",
    name: "Farzana Islam",
    designation: "Admin Officer",
    displayReason: "Added: Default",
    reason: "Added: Default",
    deadlineDays: 7,
  },
  {
    id: "auto-finance",
    user_id: "EMP-0312",
    name: "Finance Approver",
    designation: "Resolved at submission",
    displayReason: "Amount-based routing",
    reason: "slab_finance",
    slab: true,
    deadlineDays: 7,
    _requires: "money",
  } as AutoEntry & { _requires: string },
];

type SlabRow = { id?: string; min_amount: string; max_amount: string; approver_user_id: string };
type EmployeeOption = { employee_id: string; name: string };

function ApproversStep() {
  const { templateId } = Route.useSearch();
  const navigate = useNavigate();
  const { currentUser } = useCurrentUser();
  const [formName, setFormName] = useState("Employee Departure Due Diligence Form");
  const [manual, setManual] = useState<ManualEntry[]>([]);
  const [savedAgo, setSavedAgo] = useState("just now");
  const [fieldTypes, setFieldTypes] = useState<Set<string>>(new Set());
  const [slabs, setSlabs] = useState<SlabRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: tpl }, { data: fields }, { data: existingSlabs }, { data: emps }] = await Promise.all([
        db.from("form_templates").select("name").eq("id", templateId).maybeSingle(),
        db.from("form_fields").select("field_type").eq("form_template_id", templateId),
        db.from("approval_slabs").select("*").eq("form_template_id", templateId).order("order_index"),
        db.from("employees").select("employee_id, name").order("name"),
      ]);
      if (tpl?.name) setFormName(tpl.name);
      setFieldTypes(new Set((fields ?? []).map((f) => f.field_type ?? "").filter(Boolean)));
      setEmployees((emps ?? []) as EmployeeOption[]);
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

  const autoApprovers = ALL_AUTO_APPROVERS.filter((a) => {
    const req = (a as AutoEntry & { _requires?: string })._requires;
    return !req || fieldTypes.has(req);
  });

  async function handleNext() {
    // Replace existing approval_rules for this template
    await db.from("approval_rules").delete().eq("form_template_id", templateId);

    const rows = [
      ...autoApprovers.map((a) => ({
        form_template_id: templateId,
        approver_user_id: a.user_id,
        deadline_days: a.deadlineDays ?? 7,
        is_auto_added: true,
        label: a.reason,
      })),
      ...manual.map((m) => ({
        form_template_id: templateId,
        approver_user_id: m.user_id,
        deadline_days: m.deadlineDays,
        is_auto_added: false,
        label: "Manually added",
      })),
    ];

    const { error } = await db.from("approval_rules").insert(rows);
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
      await db.from("activity_log").insert({
        actor_id: currentUser.employee_id,
        action: "slab_updated",
        entity_type: "approval_slab",
        entity_id: templateId,
        detail: `Updated finance approval slabs for ${formName}`,
      });
    }

    setSavedAgo("just now");
    navigate({ to: "/builder/notifications", search: { templateId } });
  }

  function handleBack() {
    navigate({ to: "/builder", search: { templateId } });
  }

  return (
    <BuilderChrome
      step={2}
      formName={formName}
      savedAgo={savedAgo}
      rightActions={
        <>
          <SecondaryButton onClick={handleBack}>← Back</SecondaryButton>
          <PrimaryButton onClick={handleNext}>Next →</PrimaryButton>
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
        subtitle="Approvers act in order. Auto-added rules come from the field configuration and cannot be removed."
        autoEntries={autoApprovers}
        showDeadline
        manual={manual}
        onManualChange={setManual}
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
