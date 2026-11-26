import { LoadingRows } from "@/components/Loading";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { fmtDate } from "@/lib/dates";

export const Route = createFileRoute("/forms/")({
  head: () => ({
    meta: [{ title: "Forms · Admin Services Portal" }],
  }),
  component: FormsPage,
});

type FormRow = {
  id: string;
  name: string;
  status: string | null;
  audience_departments?: string[] | null;
  classification?: string | null;
  keywords?: string[] | null;
  category: string | null;
  created_by: string | null;
  created_at: string | null;
};

type Creator = { name: string; designation: string | null };


// The divisions the scope of work names. Compliance holds the ABC
// declarations; Commercial the campaign requests and their NFAs.
const TABS = ["Finance", "HR", "Admin", "Compliance", "Commercial"] as const;
type Tab = (typeof TABS)[number];

function FormsPage() {
  const [forms, setForms] = useState<FormRow[]>([]);
  const [creators, setCreators] = useState<Record<string, Creator>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("HR");
  // Find a form by its name or keywords, across every tab; or narrow a
  // tab to budgetary or non-budgetary NFAs.
  const [q, setQ] = useState("");
  const [cls, setCls] = useState("");
  const { currentUser, can } = useCurrentUser();
  // Whoever designs workflows manages the published ones — a permission
  // from their roles, not one person's id.
  const isAdmin = can("forms.build");
  const [myDepartment, setMyDepartment] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const { data } = await db
        .from("form_templates")
        .select("id, name, status, category, created_by, created_at, audience_departments, classification, keywords")
        .eq("status", "published")
        .order("created_at", { ascending: false });
      const rows = (data ?? []) as FormRow[];
      setForms(rows);
      const { data: me } = await db.from("employees").select("department").eq("employee_id", currentUser.employee_id).maybeSingle();
      setMyDepartment((me as { department: string | null } | null)?.department ?? null);

      // The card used to name a person who was typed into the markup and
      // did not exist in the employee table. Resolve the real one.
      const ids = Array.from(
        new Set(rows.map((r) => r.created_by).filter(Boolean) as string[]),
      );
      if (ids.length > 0) {
        const { data: emps } = await db
          .from("employees")
          .select("employee_id, name, designation")
          .in("employee_id", ids);
        const map: Record<string, Creator> = {};
        (emps ?? []).forEach((e: { employee_id: string; name: string; designation: string | null }) => {
          map[e.employee_id] = { name: e.name, designation: e.designation };
        });
        setCreators(map);
      }
      setLoading(false);
    })();
  }, [currentUser.employee_id]);

  function handleDeleted(id: string) {
    setForms((prev) => prev.filter((f) => f.id !== id));
  }

  // A form for some departments is offered to them; a designer sees all
  // of them. The database refuses a request from outside the audience
  // either way.
  const offered = (f: FormRow) =>
    isAdmin || !f.audience_departments?.length || (!!myDepartment && f.audience_departments.includes(myDepartment));
  const term = q.trim().toLowerCase();
  const visible = forms.filter((f) =>
    offered(f)
    && (term
      ? f.name.toLowerCase().includes(term) || (f.keywords ?? []).some((k) => k.toLowerCase().includes(term))
      : (f.category ?? "").toLowerCase() === tab.toLowerCase())
    && (!cls || f.classification === cls),
  );

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Forms</h1>
        {isAdmin && (
          <Link
            to="/builder"
            className="inline-flex items-center gap-1.5 rounded-md text-white px-3.5 py-2 text-sm font-medium"
            style={{ background: "var(--color-brand-500)" }}
          >
            + New Form
          </Link>
        )}
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <input
          aria-label="Find a form"
          placeholder="Find a form by name or keyword — e.g. capex, leave, campaign"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-md bg-white"
          style={{ padding: "8px 11px", fontSize: 13, border: "1px solid #E4E4E7", flex: 1, minWidth: 260 }}
        />
        <select aria-label="Classification" value={cls} onChange={(e) => setCls(e.target.value)}
          className="rounded-md bg-white" style={{ padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7" }}>
          <option value="">Every classification</option>
          <option value="budgetary">Budgetary</option>
          <option value="non_budgetary">Non-budgetary</option>
          <option value="regulatory">Regulatory</option>
          <option value="operational">Operational</option>
        </select>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6 overflow-x-auto scroll-thin" style={{ borderColor: "#E4E4E7", opacity: term ? 0.4 : 1 }}>
        {TABS.map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-4 py-2.5 text-sm font-medium transition-colors"
              style={{
                color: active ? "var(--color-brand-500)" : "#71717A",
                borderBottom: `2px solid ${active ? "var(--color-brand-500)" : "transparent"}`,
                marginBottom: -1,
              }}
            >
              {t}
            </button>
          );
        })}
      </div>

      {/* Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {loading && (
          <div className="col-span-full">
            <LoadingRows rows={4} height={104} />
          </div>
        )}
        {!loading && visible.map((f) => (
          <FormCard
            key={f.id}
            form={f}
            creator={f.created_by ? creators[f.created_by] : undefined}
            isAdmin={isAdmin}
            onEdit={() => navigate({ to: "/builder", search: { templateId: f.id } })}
            onDeleted={() => handleDeleted(f.id)}
          />
        ))}
        {!loading && visible.length === 0 && (
          <div className="col-span-full text-center text-muted-foreground py-12 border rounded-xl bg-white">
            {term ? <>No form matches “{q}”.</> : <>No published forms in {tab}.</>}
          </div>
        )}
      </div>
    </div>
  );
}

function FormCard({
  form,
  creator,
  isAdmin,
  onEdit,
  onDeleted,
}: {
  form: FormRow;
  creator?: Creator;
  isAdmin: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    await db.from("form_templates").update({ status: "draft" }).eq("id", form.id);
    setDeleting(false);
    onDeleted();
  }

  return (
    <div className="rounded-xl border bg-white p-5 flex flex-col" style={{ borderColor: "#E4E4E7" }}>
      <div className="flex items-start justify-between mb-2 gap-2">
        <h3 className="font-semibold text-[15px] leading-snug" style={{ color: "#18181B" }}>
          {form.name}
        </h3>
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium shrink-0"
          style={
            form.status === "published"
              ? { background: "#DCFCE7", color: "#166534" }
              : { background: "#F4F4F5", color: "#52525B" }
          }
        >
          {form.status === "published" ? "Published" : "Draft"}
        </span>
      </div>
      {(form.classification || (form.keywords ?? []).length > 0) && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {form.classification && (
            <span className="rounded-full text-[11px] font-medium" style={{ padding: "1px 8px",
              background: form.classification === "budgetary" ? "#EEF2FF" : "#F4F4F5",
              color: form.classification === "budgetary" ? "#3730A3" : "#52525B",
              border: `1px solid ${form.classification === "budgetary" ? "#C7D2FE" : "#E4E4E7"}` }}>
              {form.classification === "non_budgetary" ? "Non-budgetary" : form.classification.replace(/^./, (c) => c.toUpperCase())}
            </span>
          )}
          {(form.keywords ?? []).slice(0, 4).map((k) => (
            <span key={k} className="text-[11px]" style={{ color: "#A1A1AA" }}>#{k}</span>
          ))}
        </div>
      )}
      <p className="text-[13px] mb-4" style={{ color: "#71717A" }}>
        {form.category ? `${form.category} form` : "Uncategorised"}
      </p>
      <div className="text-[12px] mb-4" style={{ color: "#52525B" }}>
        {creator ? (
          <>
            Created by{" "}
            <span className="font-medium" style={{ color: "#18181B" }}>
              {creator.name}
            </span>
            {creator.designation ? `, ${creator.designation}` : ""}
          </>
        ) : (
          "Creator not recorded"
        )}
      </div>

      <div className="mt-auto flex items-center gap-2">
        <Link
          to="/forms/$formId"
          params={{ formId: form.id }}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md text-white px-3.5 py-2 text-sm font-medium"
          style={{ background: "var(--color-brand-500)" }}
        >
          Fill Form →
        </Link>

        {isAdmin && !confirming && (
          <>
            <button
              onClick={onEdit}
              title="Edit form"
              className="inline-flex items-center justify-center rounded-md border text-sm"
              style={{ width: 36, height: 36, borderColor: "#E4E4E7", color: "#52525B" }}
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={() => setConfirming(true)}
              title="Delete form"
              className="inline-flex items-center justify-center rounded-md border text-sm"
              style={{ width: 36, height: 36, borderColor: "#FCA5A5", color: "#DC2626" }}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}

        {isAdmin && confirming && (
          <div className="flex items-center gap-1.5">
            <span className="text-[12px]" style={{ color: "#71717A" }}>Delete?</span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md text-white text-[12px] font-medium px-2.5 py-1"
              style={{ background: "#DC2626", opacity: deleting ? 0.6 : 1 }}
            >
              {deleting ? "…" : "Yes"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-md text-[12px] font-medium px-2.5 py-1 border"
              style={{ borderColor: "#E4E4E7", color: "#52525B" }}
            >
              No
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
