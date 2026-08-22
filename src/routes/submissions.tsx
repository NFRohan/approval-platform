import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { StatusBadge } from "@/components/StatusBadge";
import { FileText, Download } from "lucide-react";
import { toCsv, downloadCsv } from "@/lib/csv";

export const Route = createFileRoute("/submissions")({
  head: () => ({
    meta: [{ title: "My Submissions · Admin Services Portal" }],
  }),
  component: SubmissionsPage,
});

type Row = {
  id: string;
  status: string | null;
  submitted_at: string | null;
  form_template_id: string | null;
  formName?: string;
};

function fmt(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SubmissionsPage() {
  const { currentUser } = useCurrentUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data: subs } = await db
        .from("form_submissions")
        .select("id, status, submitted_at, form_template_id")
        .eq("submitted_by", currentUser.employee_id)
        .order("submitted_at", { ascending: false });
      const list = (subs || []) as Row[];
      const formIds = Array.from(
        new Set(list.map((r) => r.form_template_id).filter(Boolean) as string[]),
      );
      let formsMap: Record<string, string> = {};
      if (formIds.length) {
        const { data: forms } = await db
          .from("form_templates")
          .select("id, name")
          .in("id", formIds);
        (forms || []).forEach((f) => {
          formsMap[f.id] = f.name;
        });
      }
      const enriched = list.map((r) => ({
        ...r,
        formName: r.form_template_id ? formsMap[r.form_template_id] : undefined,
      }));
      if (active) {
        setRows(enriched);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [currentUser.employee_id]);

  function handleExportCsv() {
    const csv = toCsv(rows, [
      { key: "formName", label: "Form Name" },
      { key: "status", label: "Status" },
      { key: "submitted_at", label: "Submitted At" },
      { key: "id", label: "Submission ID" },
    ]);
    downloadCsv(`my-submissions-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  return (
    <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1
            style={{
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#18181B",
              margin: 0,
            }}
          >
            My Submissions
          </h1>
          <p style={{ marginTop: 6, fontSize: 14, color: "#71717A" }}>
            Forms you've submitted ({currentUser.name}).
          </p>
        </div>
        {rows.length > 0 && (
          <button
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 rounded-md shrink-0"
            style={{ padding: "8px 14px", fontSize: 13, background: "#fff", border: "1px solid #E4E4E7", color: "#3F3F46", cursor: "pointer" }}
          >
            <Download size={13} /> Export CSV
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center text-center"
          style={{ padding: "80px 20px" }}
        >
          <div
            className="inline-flex items-center justify-center rounded-full"
            style={{
              width: 72,
              height: 72,
              background: "#FAFAFA",
              border: "1px solid #E4E4E7",
              color: "#A1A1AA",
              marginBottom: 16,
            }}
          >
            <FileText size={32} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#A1A1AA" }}>
            No submissions yet
          </div>
          <div style={{ fontSize: 13, color: "#A1A1AA", marginTop: 6 }}>
            Submit a form from the Available Forms page to get started.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            // A draft has no chain to show, so it goes back to the form
            // it came from with everything already in it. Sending it to
            // the status screen would show a timeline of nothing.
            <Link
              key={r.id}
              {...(r.status === "draft" && r.form_template_id
                ? { to: "/forms/$formId" as const, params: { formId: r.form_template_id }, search: { draft: r.id } }
                : { to: "/status/$submissionId" as const, params: { submissionId: r.id } })}
              className="block rounded-xl bg-white"
              style={{ border: "1px solid #E4E4E7", padding: 18 }}
            >
              <div className="flex items-start justify-between gap-4">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#18181B",
                      marginBottom: 6,
                    }}
                  >
                    {r.formName || "Submission"}
                  </div>
                  <div style={{ fontSize: 12, color: "#71717A" }}>
                    Submitted {fmt(r.submitted_at)}
                  </div>
                </div>
                <StatusBadge status={(r.status as any) || "submitted"} size="sm" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
