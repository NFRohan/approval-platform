import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Award, Clipboard, FileText, Link2 } from "lucide-react";
import { db } from "@/lib/db";
import { StatusBadge, type StatusKey } from "@/components/StatusBadge";
import {
  ApprovalTimeline,
  StateChip,
  type Step,
  type StepState,
} from "@/components/ApprovalTimeline";

export const Route = createFileRoute("/status/$submissionId")({
  head: () => ({
    meta: [{ title: "Submission Status · Admin Services Portal" }],
  }),
  component: StatusPage,
});

type SubmissionRow = {
  id: string;
  status: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  form_template_id: string | null;
};

type ApprovalRow = {
  id: string;
  submission_id: string | null;
  approver_user_id: string | null;
  status: string | null;
  acted_at: string | null;
  comment: string | null;
  deadline_at: string | null;
};

type EmployeeRow = {
  employee_id: string;
  name: string;
  designation: string | null;
  department: string | null;
};

type FormRow = { id: string; name: string };

const LINKED_LABELS: Record<string, string> = {
  linked_gate_pass_revocation: "Gate Pass Revocation",
  linked_office_access: "Office Access Request",
  linked_asset_return: "Asset Return Form",
};

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function fmtDateTime(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function mapApprovalState(s: string | null): StepState {
  switch ((s || "").toLowerCase()) {
    case "approved":
    case "completed":
      return "completed";
    case "rejected":
      return "rejected";
    case "on_hold":
      return "on_hold";
    case "clarification":
    case "clarification_requested":
      return "clarification";
    case "pending":
      // The live step, and the only one anybody can act on. The steps
      // above it are "waiting"; collapsing both into "pending" made an
      // advancing chain look frozen to whoever submitted it.
      return "active";
    case "waiting":
      return "locked";
    case "skipped":
      // Never asked, because a rejection below ended the chain.
      return "idle";
    default:
      return "pending";
  }
}

function deriveOverallStatus(rows: ApprovalRow[]): StatusKey {
  if (!rows.length) return "submitted";
  const states = rows.map((r) => mapApprovalState(r.status));
  if (states.every((s) => s === "completed")) return "completed";
  if (states.some((s) => s === "rejected")) return "rejected";
  if (states.some((s) => s === "on_hold" || s === "clarification")) return "on_hold";
  return "in_progress";
}

function StatusPage() {
  const { submissionId } = Route.useParams();
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [form, setForm] = useState<FormRow | null>(null);
  const [submitter, setSubmitter] = useState<EmployeeRow | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [employees, setEmployees] = useState<Record<string, EmployeeRow>>({});
  const [linkedFieldTypes, setLinkedFieldTypes] = useState<string[]>([]);
  const [gatePassCardNum, setGatePassCardNum] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    const { data: sub } = await db
      .from("form_submissions")
      .select("*")
      .eq("id", submissionId)
      .maybeSingle();
    setSubmission(sub as SubmissionRow | null);

    if (sub?.form_template_id) {
      const { data: f } = await db
        .from("form_templates")
        .select("id, name")
        .eq("id", sub.form_template_id)
        .maybeSingle();
      setForm(f as FormRow | null);

      const { data: linkedFields } = await db
        .from("form_fields")
        .select("field_type")
        .eq("form_template_id", sub.form_template_id)
        .like("field_type", "linked_%");
      setLinkedFieldTypes((linkedFields ?? []).map((r) => r.field_type ?? "").filter(Boolean));
    }

    // Gate pass card number from submission values (gen_gate_pass field)
    const { data: gpVal } = await db
      .from("submission_values")
      .select("value")
      .eq("submission_id", submissionId)
      .eq("field_name", "Gate Pass Card Number")
      .maybeSingle();
    setGatePassCardNum(gpVal?.value ?? null);

    if (sub?.submitted_by) {
      const { data: emp } = await db
        .from("employees")
        .select("employee_id, name, designation, department")
        .eq("employee_id", sub.submitted_by)
        .maybeSingle();
      setSubmitter(emp as EmployeeRow | null);
    }

    const { data: appr } = await db
      .from("approval_requests")
      .select("*")
      .eq("submission_id", submissionId)
      // By step, not by deadline. Every slab step of one rule shares a
      // deadline computed before the loop that creates them, so ordering
      // by date left the finance ladder in an arbitrary order — and a
      // rule with a shorter deadline could float above the step that
      // approves before it.
      .order("step_index", { ascending: true });
    const list = (appr as ApprovalRow[] | null) || [];
    setApprovals(list);

    const ids = Array.from(
      new Set(list.map((r) => r.approver_user_id).filter(Boolean) as string[]),
    );
    if (ids.length) {
      const { data: emps } = await db
        .from("employees")
        .select("employee_id, name, designation, department")
        .in("employee_id", ids);
      const map: Record<string, EmployeeRow> = {};
      (emps as EmployeeRow[] | null)?.forEach((e) => {
        map[e.employee_id] = e;
      });
      setEmployees(map);
    } else {
      setEmployees({});
    }
    setLoading(false);
  }, [submissionId]);

  useEffect(() => {
    loadAll();
    const channel = db
      .channel(`approvals-${submissionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "approval_requests",
          filter: `submission_id=eq.${submissionId}`,
        },
        () => {
          loadAll();
        },
      )
      .subscribe();

    return () => {
      db.removeChannel(channel);
    };
  }, [submissionId, loadAll]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-10 text-sm text-zinc-500">
        Loading submission…
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="max-w-4xl mx-auto p-10">
        <h1 className="text-xl font-semibold mb-2">Submission not found</h1>
        <p className="text-sm text-zinc-500 mb-6">
          We couldn't find a submission with ID{" "}
          <span className="font-mono">{submissionId}</span>.
        </p>
        <Link to="/forms" className="text-sm" style={{ color: "var(--color-brand-600)" }}>
          ← Back to Forms
        </Link>
      </div>
    );
  }

  const overall = deriveOverallStatus(approvals);
  const refCode = `AMS-${submissionId.slice(0, 8).toUpperCase()}`;

  const steps: Step[] = approvals.map((r, i) => {
    const emp = r.approver_user_id ? employees[r.approver_user_id] : undefined;
    const name = emp?.name || r.approver_user_id || "Unknown approver";
    const state = mapApprovalState(r.status);
    return {
      id: i + 1,
      kind: "single",
      title: emp?.designation || `Approver ${i + 1}`,
      state,
      approver: {
        name,
        title: emp?.designation || "—",
        dept: emp?.department || undefined,
        initials: initials(name),
        state,
      },
      actionAt: r.acted_at ? fmtDateTime(r.acted_at) : undefined,
      actionLabel:
        state === "completed"
          ? "Approved"
          : state === "rejected"
          ? "Rejected"
          : state === "clarification"
          ? "Clarification requested"
          : state === "on_hold"
          ? "Placed on hold"
          : undefined,
      comment: r.comment || undefined,
    };
  });

  const activity = approvals
    .filter((r) => r.acted_at)
    .map((r) => {
      const emp = r.approver_user_id ? employees[r.approver_user_id] : undefined;
      const state = mapApprovalState(r.status);
      const action =
        state === "completed"
          ? "approved"
          : state === "rejected"
          ? "rejected"
          : state === "clarification"
          ? "requested clarification"
          : state === "on_hold"
          ? "placed on hold"
          : "updated";
      return {
        at: r.acted_at!,
        who: emp?.name || r.approver_user_id || "Unknown",
        role: emp?.designation || "Approver",
        action,
        state,
      };
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Prepend the submission itself
  if (submission.submitted_at) {
    activity.unshift({
      at: submission.submitted_at,
      who: submitter?.name || submission.submitted_by || "Submitter",
      role: submitter?.designation || "Submitter",
      action: "submitted the form",
      state: "pending",
    });
  }

  return (
    <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <Link
        to="/forms"
        className="inline-flex items-center text-sm mb-6"
        style={{ color: "#71717A" }}
      >
        ← Back to forms
      </Link>

      {/* Header */}
      <div
        className="rounded-xl bg-white"
        style={{ border: "1px solid #E4E4E7", padding: 24, marginBottom: 28 }}
      >
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="flex items-center gap-2.5 mb-2.5">
              <span
                className="font-mono"
                style={{
                  fontSize: 12,
                  color: "#71717A",
                  padding: "3px 8px",
                  background: "#F4F4F5",
                  borderRadius: 4,
                  letterSpacing: "0.02em",
                }}
              >
                {refCode}
              </span>
              <span style={{ fontSize: 12, color: "#A1A1AA" }}>Reference</span>
            </div>
            <h1
              style={{
                margin: "0 0 14px 0",
                fontSize: 22,
                fontWeight: 600,
                color: "#18181B",
                letterSpacing: "-0.005em",
              }}
            >
              {form?.name || "Submission"}
            </h1>
            <div
              className="grid"
              style={{
                gridTemplateColumns: "auto 1fr",
                columnGap: 24,
                rowGap: 8,
                fontSize: 13,
                maxWidth: 620,
              }}
            >
              <div style={{ color: "#A1A1AA" }}>Submitted</div>
              <div style={{ color: "#3F3F46" }}>{fmtDateTime(submission.submitted_at)}</div>
              <div style={{ color: "#A1A1AA" }}>Submitted by</div>
              <div style={{ color: "#3F3F46" }}>
                <span style={{ fontWeight: 500, color: "#18181B" }}>
                  {submitter?.name || submission.submitted_by}
                </span>
                {submission.submitted_by && (
                  <span style={{ color: "#A1A1AA" }}> · {submission.submitted_by}</span>
                )}
                {submitter?.designation && (
                  <>
                    <br />
                    <span style={{ color: "#71717A" }}>
                      {submitter.designation}
                      {submitter.department ? `, ${submitter.department}` : ""}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <StatusBadge status={overall} size="lg" showIcon />
          </div>
        </div>
      </div>

      {/* Clearance Certificate banner */}
      {overall === "completed" && (
        <Link
          to="/certificate/$submissionId"
          params={{ submissionId }}
          className="flex items-center gap-3 rounded-xl mb-6"
          style={{ padding: "16px 20px", background: "#F0FDF4", border: "1px solid #86EFAC", textDecoration: "none" }}
        >
          <Award size={20} style={{ color: "#16A34A", flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[14px]" style={{ color: "#15803D" }}>All approvals complete</div>
            <div className="text-[12px]" style={{ color: "#16A34A" }}>Your company clearance certificate is ready — click to view & download</div>
          </div>
          <span className="text-[13px] font-medium shrink-0" style={{ color: "#15803D" }}>View Certificate →</span>
        </Link>
      )}

      {/* Timeline */}
      {steps.length > 0 ? (
        <ApprovalTimeline steps={steps} />
      ) : (
        <div
          className="rounded-xl bg-white text-sm text-zinc-500"
          style={{ border: "1px solid #E4E4E7", padding: 24 }}
        >
          No approvers configured for this submission.
        </div>
      )}

      {/* Auto-linked submissions — only shown if form actually has linked fields */}
      {linkedFieldTypes.length > 0 && (
        <div
          style={{
            marginTop: 24,
            marginLeft: 56,
            border: "1px dashed #D4D4D8",
            borderRadius: 10,
            padding: 14,
            background: "#FAFAFA",
          }}
        >
          <div className="flex items-center gap-2 mb-2.5">
            <Link2 size={13} stroke="#71717A" />
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.10em",
                textTransform: "uppercase",
                color: "#71717A",
              }}
            >
              Auto-linked submission{linkedFieldTypes.length > 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex flex-col gap-2.5">
            {linkedFieldTypes.map((ft) => {
              const label = LINKED_LABELS[ft] ?? ft;
              const isGatePass = ft === "linked_gate_pass_revocation";
              return (
                <div key={ft} className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5" style={{ minWidth: 0 }}>
                    <span
                      className="inline-flex items-center justify-center"
                      style={{ width: 32, height: 32, borderRadius: 8, background: "#fff", border: "1px solid #E4E4E7" }}
                    >
                      <FileText size={15} stroke="#52525B" />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: "#18181B" }}>
                        {label} — Submitted
                      </div>
                      {isGatePass && gatePassCardNum && (
                        <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>
                          Card {gatePassCardNum} will be revoked upon full approval
                        </div>
                      )}
                    </div>
                  </div>
                  <StateChip state="pending" />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Activity feed */}
      <div
        className="rounded-xl bg-white overflow-hidden"
        style={{ border: "1px solid #E4E4E7", marginTop: 32 }}
      >
        <div
          className="flex items-center gap-2"
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid #E4E4E7",
            background: "#FAFAFA",
          }}
        >
          <Clipboard size={14} stroke="#52525B" />
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              color: "#52525B",
            }}
          >
            Activity feed
          </span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#A1A1AA" }}>
            {activity.length} events
          </span>
        </div>
        <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {activity.map((ev, i) => (
            <li
              key={i}
              style={{
                padding: "14px 20px",
                borderBottom: i === activity.length - 1 ? "none" : "1px solid #F4F4F5",
              }}
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <div style={{ fontSize: 13.5, color: "#3F3F46", lineHeight: 1.45 }}>
                  <span style={{ fontWeight: 600, color: "#18181B" }}>{ev.who}</span>
                  <span style={{ color: "#A1A1AA" }}> · {ev.role}</span>
                  <span style={{ marginLeft: 8 }}>{ev.action}</span>
                </div>
                <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>
                  {fmtDateTime(ev.at)}
                </span>
              </div>
            </li>
          ))}
          {activity.length === 0 && (
            <li style={{ padding: "20px", fontSize: 13, color: "#71717A" }}>No activity yet.</li>
          )}
        </ol>
      </div>
    </div>
  );
}
