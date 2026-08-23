import { LoadingRows } from "@/components/Loading";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

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
  category: string | null;
  created_by: string | null;
  created_at: string | null;
};

type Creator = { name: string; designation: string | null };

function fmtDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const TABS = ["Finance", "HR", "Admin"] as const;
type Tab = (typeof TABS)[number];

function FormsPage() {
  const [forms, setForms] = useState<FormRow[]>([]);
  const [creators, setCreators] = useState<Record<string, Creator>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("HR");
  const { currentUser } = useCurrentUser();
  const isAdmin = currentUser.employee_id === "EMP-0201";
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const { data } = await db
        .from("form_templates")
        .select("id, name, status, category, created_by, created_at")
        .eq("status", "published")
        .order("created_at", { ascending: false });
      const rows = (data ?? []) as FormRow[];
      setForms(rows);

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
  }, []);

  function handleDeleted(id: string) {
    setForms((prev) => prev.filter((f) => f.id !== id));
  }

  const visible = forms.filter(
    (f) => (f.category ?? "").toLowerCase() === tab.toLowerCase(),
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

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6" style={{ borderColor: "#E4E4E7" }}>
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
            No published forms in {tab}.
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
      <p className="text-[13px] mb-4" style={{ color: "#71717A" }}>
        {form.category ? `${form.category} form` : "Uncategorised"}
        {form.created_at ? ` · added ${fmtDate(form.created_at)}` : ""}
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
