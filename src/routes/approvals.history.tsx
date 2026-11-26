import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, Download } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { StatusBadge } from "@/components/StatusBadge";
import { toCsv, downloadCsv } from "@/lib/csv";
import { fmtDateTime } from "@/lib/dates";

export const Route = createFileRoute("/approvals/history")({
  head: () => ({
    meta: [{ title: "Approval History · Admin Services Portal" }],
  }),
  component: HistoryPage,
});

type Row = {
  id: string;
  submission_id: string | null;
  status: string | null;
  acted_at: string | null;
  comment: string | null;
  formName?: string;
  submitterName?: string;
};

function fmt(iso?: string | null) {
  return fmtDateTime(iso);
}

const statusToBadge = (s: string | null) => {
  switch (s) {
    case "approved":
      return "completed" as const;
    case "rejected":
      return "rejected" as const;
    case "clarification":
      return "on_hold" as const;
    default:
      return "submitted" as const;
  }
};

function HistoryPage() {
  const { currentUser } = useCurrentUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data: appr } = await db
        .from("approval_requests")
        .select("*")
        .eq("approver_user_id", currentUser.employee_id)
        // Acted on, which is narrower than "not pending". A rejection
        // lower down marks everything above it 'skipped' and leaves
        // acted_at null — those were never asked of this person, and
        // listing them here claimed they had dealt with them. 'waiting'
        // is excluded for the same reason.
        .in("status", ["approved", "rejected", "clarification"])
        .order("acted_at", { ascending: false });
      const list = (appr || []) as Row[];

      const subIds = Array.from(
        new Set(list.map((r) => r.submission_id).filter(Boolean) as string[]),
      );
      let formNameMap: Record<string, string> = {};
      let submitterNameMap: Record<string, string> = {};

      if (subIds.length) {
        const { data: subs } = await db
          .from("form_submissions")
          .select("id, form_template_id, submitted_by, ref_number")
          .in("id", subIds);
        const formIds = Array.from(
          new Set((subs || []).map((s) => s.form_template_id).filter(Boolean) as string[]),
        );
        const empIds = Array.from(
          new Set((subs || []).map((s) => s.submitted_by).filter(Boolean) as string[]),
        );
        if (formIds.length) {
          const { data: f } = await db
            .from("form_templates")
            .select("id, name")
            .in("id", formIds);
          (f || []).forEach((x) => (formNameMap[x.id] = x.name));
        }
        if (empIds.length) {
          const { data: e } = await db
            .from("employees")
            .select("employee_id, name")
            .in("employee_id", empIds);
          const nameByEmp: Record<string, string> = {};
          (e || []).forEach((x) => (nameByEmp[x.employee_id] = x.name));
          (subs || []).forEach((s) => {
            if (s.submitted_by && nameByEmp[s.submitted_by]) {
              submitterNameMap[s.id] = nameByEmp[s.submitted_by];
            }
          });
        }
        const subFormMap: Record<string, string> = {};
        (subs || []).forEach((s) => {
          if (s.form_template_id && formNameMap[s.form_template_id]) {
            subFormMap[s.id] = formNameMap[s.form_template_id];
          }
        });
        const refMap: Record<string, string> = {};
        (subs || []).forEach((s) => { if (s.ref_number) refMap[s.id] = s.ref_number; });
        list.forEach((r) => {
          if (r.submission_id) {
            (r as { reference?: string }).reference = refMap[r.submission_id];
            r.formName = subFormMap[r.submission_id];
            r.submitterName = submitterNameMap[r.submission_id];
          }
        });
      }

      // Notices and movement orders are decided here too; they have no
      // request, so they are named by what they are (not "Submission").
      const ids = (t: string) => Array.from(new Set(list.filter((r) => (r as { subject_type?: string }).subject_type === t).map((r) => (r as { subject_id?: string }).subject_id).filter(Boolean) as string[]));
      const noticeIds = ids("notice"), moveIds = ids("movement_order");
      const [{ data: ns }, { data: ms }] = await Promise.all([
        noticeIds.length ? db.from("notices").select("id, title, created_by").in("id", noticeIds) : Promise.resolve({ data: [] }),
        moveIds.length ? db.from("movement_orders").select("id, ref_number, item_name, requester_id").in("id", moveIds) : Promise.resolve({ data: [] }),
      ]);
      const people = Array.from(new Set([...(ns ?? []).map((n) => n.created_by), ...(ms ?? []).map((m) => m.requester_id)].filter(Boolean) as string[]));
      const who: Record<string, string> = {};
      if (people.length) {
        const { data: e } = await db.from("employees").select("employee_id, name").in("employee_id", people);
        (e ?? []).forEach((x) => { who[x.employee_id] = x.name; });
      }
      for (const r of list) {
        const sid = (r as { subject_id?: string }).subject_id;
        const n = (ns ?? []).find((x) => x.id === sid);
        const m = (ms ?? []).find((x) => x.id === sid);
        if (n) { r.formName = `Notice · ${n.title}`; r.submitterName = who[n.created_by ?? ""] ?? n.created_by ?? undefined; }
        if (m) { r.formName = `Movement order · ${m.ref_number ?? m.item_name ?? ""}`; r.submitterName = who[m.requester_id ?? ""] ?? m.requester_id ?? undefined; }
      }

      if (active) {
        setRows([...list]);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [currentUser.employee_id]);

  function handleExportCsv() {
    // Dates as the screen writes them; each decision names its request.
    const out = rows.map((r) => ({ ...r, acted_at: r.acted_at ? fmtDateTime(r.acted_at) : "" }));
    const csv = toCsv(out, [
      { key: "formName", label: "Form Name" },
      { key: "submitterName", label: "Submitter" },
      { key: "status", label: "Status" },
      { key: "acted_at", label: "Acted At" },
      { key: "comment", label: "Comment" },
      { key: "reference" as keyof typeof out[number], label: "Reference" },
    ]);
    downloadCsv(`approval-history-${new Date().toISOString().slice(0, 10)}.csv`, csv);
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
            Approval History
          </h1>
          <p style={{ marginTop: 6, fontSize: 14, color: "#71717A" }}>
            Requests you've already acted on.
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
            <CheckCircle2 size={32} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#A1A1AA" }}>
            No approval history yet
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className="rounded-xl bg-white"
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
                  <div style={{ fontSize: 13, color: "#52525B" }}>
                    Submitted by{" "}
                    <span style={{ fontWeight: 500, color: "#18181B" }}>
                      {r.submitterName || "—"}
                    </span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, color: "#71717A" }}>
                    Acted {fmt(r.acted_at)}
                  </div>
                  {r.comment && (
                    <div
                      style={{
                        marginTop: 10,
                        padding: 10,
                        background: "#FAFAFA",
                        border: "1px solid #F4F4F5",
                        borderRadius: 8,
                        fontSize: 13,
                        color: "#3F3F46",
                      }}
                    >
                      "{r.comment}"
                    </div>
                  )}
                </div>
                <div className="shrink-0 flex flex-col items-end gap-2">
                  <StatusBadge status={statusToBadge(r.status)} size="sm" />
                  {r.submission_id && (
                    <Link
                      to="/status/$submissionId"
                      params={{ submissionId: r.submission_id }}
                      className="text-xs font-medium"
                      style={{ color: "#4F46E5" }}
                    >
                      View timeline →
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
