import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { BuilderChrome, PrimaryButton, SecondaryButton } from "@/components/builder/BuilderChrome";
import { PeopleStep, type AutoEntry, type ManualEntry } from "@/components/builder/PeopleStep";
import { toast } from "sonner";

const search = z.object({ templateId: z.string() });

export const Route = createFileRoute("/builder/notifications")({
  validateSearch: search,
  head: () => ({
    meta: [{ title: "Notifications · Form Builder" }],
  }),
  component: NotificationsStep,
});

type AutoEntryWithRequires = AutoEntry & { _requires?: string };

const BASE_AUTO_NOTIFY: AutoEntryWithRequires[] = [
  {
    id: "auto-creator",
    user_id: "EMP-0201",
    name: "Nadia Hossain",
    designation: "HR Business Partner",
    reason: "Added: Form creator",
  },
  {
    id: "auto-line-mgr",
    user_id: "EMP-1134",
    name: "Sara Khan",
    designation: "Line Manager",
    reason: "Added: Employee field",
    _requires: "employee",
  },
  {
    id: "auto-admin",
    user_id: "EMP-0445",
    name: "Farzana Islam",
    designation: "Admin Officer",
    reason: "Added: Default",
  },
  {
    id: "auto-submitter",
    user_id: "EMP-2847",
    name: "Ahmed Rahman",
    designation: "Departing Employee",
    reason: "Added: Submitter",
  },
];

function formatSlabRange(min: number, max: number | null): string {
  const fmt = (n: number) => n.toLocaleString("en-IN");
  if (max === null) return `Slab: > BDT ${fmt(min)}`;
  return min === 0 ? `Slab: ≤ BDT ${fmt(max)}` : `Slab: BDT ${fmt(min)} – ${fmt(max)}`;
}

function NotificationsStep() {
  const { templateId } = Route.useSearch();
  const navigate = useNavigate();
  const [formName, setFormName] = useState("Employee Departure Due Diligence Form");
  const [manual, setManual] = useState<ManualEntry[]>([]);
  const [savedAgo, setSavedAgo] = useState("just now");
  const [publishing, setPublishing] = useState(false);
  const [fieldTypes, setFieldTypes] = useState<Set<string>>(new Set());
  const [slabNotify, setSlabNotify] = useState<AutoEntryWithRequires[]>([]);

  useEffect(() => {
    (async () => {
      const [{ data: tpl }, { data: fields }, { data: slabRows }, { data: emps }] = await Promise.all([
        supabase.from("form_templates").select("name").eq("id", templateId).maybeSingle(),
        supabase.from("form_fields").select("field_type").eq("form_template_id", templateId),
        supabase.from("approval_slabs").select("*").eq("form_template_id", templateId).order("order_index"),
        supabase.from("employees").select("employee_id, name, designation"),
      ]);
      if (tpl?.name) setFormName(tpl.name);
      setFieldTypes(new Set((fields ?? []).map((f) => f.field_type ?? "").filter(Boolean)));
      const empMap: Record<string, { name: string; designation: string | null }> = {};
      (emps ?? []).forEach((e) => { empMap[e.employee_id] = { name: e.name, designation: e.designation }; });
      setSlabNotify(
        (slabRows ?? []).map((s, i) => ({
          id: `auto-finance-${i}`,
          user_id: s.approver_user_id,
          name: empMap[s.approver_user_id]?.name ?? s.approver_user_id,
          designation: empMap[s.approver_user_id]?.designation ?? "",
          reason: formatSlabRange(s.min_amount, s.max_amount),
          _requires: "money",
        })),
      );
    })();
  }, [templateId]);

  const autoNotify = [
    ...BASE_AUTO_NOTIFY.filter((a) => !a._requires || fieldTypes.has(a._requires)),
    ...(fieldTypes.has("money") ? slabNotify : []),
  ];

  async function handlePublish() {
    setPublishing(true);
    try {
      await supabase.from("notification_rules").delete().eq("form_template_id", templateId);

      const rows = [
        ...autoNotify.map((a) => ({
          form_template_id: templateId,
          notifyee_user_id: a.user_id,
          is_auto_added: true,
          label: a.reason,
        })),
        ...manual.map((m) => ({
          form_template_id: templateId,
          notifyee_user_id: m.user_id,
          is_auto_added: false,
          label: "Manually added",
        })),
      ];
      const { error: nrErr } = await supabase.from("notification_rules").insert(rows);
      if (nrErr) {
        toast.error("Failed to save notifications: " + nrErr.message);
        return;
      }

      const { error: pubErr } = await supabase
        .from("form_templates")
        .update({ status: "published" })
        .eq("id", templateId);
      if (pubErr) {
        toast.error("Failed to publish form: " + pubErr.message);
        return;
      }

      setSavedAgo("just now");
      toast.success("Form published. Employees can now submit.");
      navigate({ to: "/forms" });
    } finally {
      setPublishing(false);
    }
  }

  function handleBack() {
    navigate({ to: "/builder/approvers", search: { templateId } });
  }

  return (
    <BuilderChrome
      step={3}
      formName={formName}
      savedAgo={savedAgo}
      rightActions={
        <>
          <SecondaryButton onClick={handleBack}>← Back</SecondaryButton>
          <PrimaryButton onClick={handlePublish} disabled={publishing}>
            {publishing ? "Publishing…" : "Publish Form"}
          </PrimaryButton>
        </>
      }
    >
      <PeopleStep
        title="Who should be notified?"
        subtitle="These people receive a notification each time the form is submitted or progresses."
        autoEntries={autoNotify}
        showDeadline={false}
        manual={manual}
        onManualChange={setManual}
      />
    </BuilderChrome>
  );
}
