import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { StatusBadge } from "@/components/StatusBadge";
import { Copy, FileText, Download, Search } from "lucide-react";
import { toCsv, downloadCsv } from "@/lib/csv";
import { fmtDate } from "@/lib/dates";
import { todayInOrg } from "@/lib/workdays";
import { copySubmission } from "@/lib/chain";

export const Route = createFileRoute("/submissions")({
  validateSearch: (s: Record<string, unknown>): { archived?: number } => (Number(s.archived) === 1 ? { archived: 1 } : {}),
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
  submitted_by: string | null;
  ref_number: string | null;
  priority: string | null;
  flag: string | null;
  archived_at?: string | null;
  legacy_ref?: string | null;
  legacy_source?: string | null;
  closed_at?: string | null;
  formName?: string;
  requesterName?: string;
};

// What a person finds here: what they raised, and what they were copied
// on. Copied requests are the "ad-hoc report" the scope of work says CC'd
// people currently cannot get at. The archive holds what retention has
// put away — settled more than a year ago — and tickets migrated from
// ManageEngine; out of the working lists, still found here and by search.
type Tab = "mine" | "copied" | "archive";

function SubmissionsPage() {
  const { currentUser, can } = useCurrentUser();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [tab, setTab] = useState<Tab>(search.archived ? "archive" : "mine");
  const [archivedCount, setArchivedCount] = useState(0);
  // Records officers and auditors see the whole organisation's archive.
  const wholeArchive = can("records.manage") || can("audit.view");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  // Find a record by its reference, its form, or when it was raised.
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      let list: Row[] = [];
      const columns = "id, status, submitted_at, form_template_id, submitted_by, ref_number, priority, flag, archived_at, legacy_ref, legacy_source, closed_at";
      if (tab === "mine") {
        const { data } = await db.from("form_submissions").select(columns)
          .eq("submitted_by", currentUser.employee_id)
          .order("submitted_at", { ascending: false });
        const all = (data || []) as Row[];
        list = all.filter((r) => !r.archived_at);
        if (!wholeArchive && active) setArchivedCount(all.length - list.length);
      } else if (tab === "archive") {
        let q = db.from("form_submissions").select(columns);
        if (!wholeArchive) q = q.eq("submitted_by", currentUser.employee_id);
        const { data } = await q.order("submitted_at", { ascending: false }).limit(2000);
        list = ((data || []) as Row[]).filter((r) => r.archived_at);
      } else {
        const { data: cc } = await db.from("submission_cc").select("submission_id").eq("employee_id", currentUser.employee_id);
        const ids = (cc ?? []).map((c) => c.submission_id as string);
        if (ids.length) {
          const { data } = await db.from("form_submissions").select(columns).in("id", ids)
            .order("submitted_at", { ascending: false });
          list = ((data || []) as Row[]).filter((r) => r.status !== "draft" && !r.archived_at);
        }
      }
      const formIds = Array.from(new Set(list.map((r) => r.form_template_id).filter(Boolean) as string[]));
      const people = Array.from(new Set(list.map((r) => r.submitted_by).filter(Boolean) as string[]));
      const [{ data: forms }, { data: emps }] = await Promise.all([
        formIds.length ? db.from("form_templates").select("id, name").in("id", formIds) : Promise.resolve({ data: [] }),
        people.length ? db.from("employees").select("employee_id, name").in("employee_id", people) : Promise.resolve({ data: [] }),
      ]);
      const formsMap: Record<string, string> = {};
      (forms || []).forEach((f: { id: string; name: string }) => { formsMap[f.id] = f.name; });
      const names: Record<string, string> = {};
      (emps || []).forEach((e: { employee_id: string; name: string }) => { names[e.employee_id] = e.name; });
      if (active) {
        setRows(list.map((r) => ({
          ...r,
          formName: r.form_template_id ? formsMap[r.form_template_id] : undefined,
          requesterName: r.submitted_by ? names[r.submitted_by] : undefined,
        })));
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [currentUser.employee_id, tab, wholeArchive]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (status && r.status !== status) return false;
      // Dates are compared on Dhaka's calendar, as they are written.
      const day = r.submitted_at ? todayInOrg(new Date(r.submitted_at)) : "";
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (q && !`${r.ref_number ?? ""} ${r.legacy_ref ?? ""} ${r.formName ?? ""} ${r.requesterName ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, query, status, from, to]);

  function handleExportCsv() {
    const csv = toCsv(
      shown.map((r) => ({ ...r, submitted: fmtDate(r.submitted_at) })),
      [
        { key: "ref_number", label: "Reference" },
        { key: "formName", label: "Form Name" },
        { key: "requesterName", label: "Raised by" },
        { key: "status", label: "Status" },
        { key: "priority", label: "Priority" },
        { key: "submitted", label: "Submitted" },
      ],
    );
    downloadCsv(`${tab === "mine" ? "my-submissions" : tab === "copied" ? "copied-to-me" : "archive"}-${todayInOrg()}.csv`, csv);
  }

  async function copy(r: Row) {
    if (!r.form_template_id) return;
    const { data, error } = await copySubmission(r.id, currentUser.employee_id);
    if (error) { toast.error(error.message); return; }
    toast.success("Copied — edit it and submit when ready");
    navigate({ to: "/forms/$formId", params: { formId: r.form_template_id }, search: { draft: data as string } });
  }

  const ctl: React.CSSProperties = { padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", borderRadius: 6, background: "#fff" };

  return (
    <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }}>
            My Submissions
          </h1>
          <p style={{ marginTop: 6, fontSize: 14, color: "#71717A" }}>
            What you raised, and what you were copied on ({currentUser.name}).
          </p>
        </div>
        {shown.length > 0 && (
          <button
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 rounded-md shrink-0"
            style={{ padding: "8px 14px", fontSize: 13, background: "#fff", border: "1px solid #E4E4E7", color: "#3F3F46", cursor: "pointer" }}
          >
            <Download size={13} /> Export CSV
          </button>
        )}
      </div>

      <div className="flex gap-1 mb-4" role="tablist">
        {(["mine", "copied", "archive"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="rounded-md text-[13px] font-medium"
            style={{ padding: "6px 12px", border: `1px solid ${tab === t ? "#C7D2FE" : "#E4E4E7"}`, background: tab === t ? "#EEF2FF" : "#fff", color: tab === t ? "#4338CA" : "#52525B" }}
          >
            {t === "mine" ? "Raised by me" : t === "copied" ? "Copied to me" : wholeArchive ? "Archive" : `Archived${archivedCount ? ` (${archivedCount})` : ""}`}
          </button>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap items-center mb-4">
        <label className="inline-flex items-center gap-1.5 flex-1" style={{ ...ctl, minWidth: 220 }}>
          <Search size={13} style={{ color: "#A1A1AA" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Reference, form or person"
            aria-label="Search submissions"
            style={{ border: "none", outline: "none", flex: 1, fontSize: 13 }}
          />
        </label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={ctl}>
          <option value="">Any status</option>
          {["draft", "submitted", "in_progress", "on_hold", "completed", "rejected", "cancelled"].map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" style={ctl} />
        <span style={{ fontSize: 12, color: "#A1A1AA" }}>to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" style={ctl} />
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center" style={{ padding: "64px 20px" }}>
          <div className="inline-flex items-center justify-center rounded-full" style={{ width: 72, height: 72, background: "#FAFAFA", border: "1px solid #E4E4E7", color: "#A1A1AA", marginBottom: 16 }}>
            <FileText size={32} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#A1A1AA" }}>
            {rows.length ? "Nothing matches those filters" : tab === "mine" ? "No submissions yet" : tab === "copied" ? "Nothing has been copied to you" : "Nothing has been archived"}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((r) => (
            <div key={r.id} className="rounded-xl bg-white flex items-start gap-3" style={{ border: "1px solid #E4E4E7", padding: 18 }}>
              {/* A draft goes back to its form with everything in it; anything
                  else to its status page. */}
              <Link
                {...(r.status === "draft" && r.form_template_id
                  ? { to: "/forms/$formId" as const, params: { formId: r.form_template_id }, search: { draft: r.id } }
                  : { to: "/status/$submissionId" as const, params: { submissionId: r.id } })}
                className="block flex-1"
                style={{ minWidth: 0 }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, color: "#18181B", marginBottom: 6 }}>
                  {r.formName || "Submission"}
                  <span className="font-mono" style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 500, color: "#71717A" }}>{r.ref_number}</span>
                  {r.flag && (
                    <span className="rounded-full" style={{ marginLeft: 8, padding: "1px 8px", fontSize: 11, fontWeight: 600, background: "#FDF2F8", color: "#BE185D", border: "1px solid #FBCFE8" }}>{r.flag}</span>
                  )}
                  {r.priority && r.priority !== "normal" && (
                    <span className="rounded-full" style={{ marginLeft: 6, padding: "1px 8px", fontSize: 11, fontWeight: 600, background: r.priority === "urgent" ? "#FEF2F2" : "#FFFBEB", color: r.priority === "urgent" ? "#B91C1C" : "#B45309" }}>
                      {r.priority === "urgent" ? "Urgent" : "High"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#71717A" }}>
                  {tab !== "mine" && r.requesterName ? `${r.requesterName} · ` : ""}{r.legacy_ref ? `Raised in ${r.legacy_source} ` : "Submitted "}{fmtDate(r.submitted_at)}
                  {r.archived_at && <span> · {r.legacy_ref ? `migrated ${fmtDate(r.archived_at)}` : `archived ${fmtDate(r.archived_at)}`}</span>}
                </div>
              </Link>
              <div className="flex flex-col items-end gap-2">
                <StatusBadge status={(r.status as never) || "submitted"} size="sm" />
                {r.archived_at && (
                  <span className="rounded-full" style={{ padding: "1px 8px", fontSize: 11, fontWeight: 600, background: "#F4F4F5", color: "#52525B", border: "1px solid #E4E4E7" }}>
                    {r.legacy_source ? `From ${r.legacy_source}` : "Archived"}
                  </span>
                )}
                {!r.legacy_ref && <button
                  onClick={() => copy(r)}
                  className="inline-flex items-center gap-1 rounded-md"
                  title="Start a new request from this one"
                  style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #E4E4E7", background: "#fff", color: "#52525B" }}
                >
                  <Copy size={12} /> Copy
                </button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
