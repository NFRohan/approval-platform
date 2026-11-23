import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Award, Clipboard, Clock, FileText, Link2, MessageCircleQuestion, Undo2, XCircle, FileDown } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { StatusBadge, type StatusKey } from "@/components/StatusBadge";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  ApprovalTimeline,
  StateChip,
  type Step,
  type StepState,
} from "@/components/ApprovalTimeline";
import { buildTimeline, type ChainRow } from "@/lib/timeline";
import { answerQuestion, cancelSubmission, copySubmission, recallSubmission } from "@/lib/chain";
import { CcPanel, DocumentsPanel, LinksPanel, NotesPanel } from "@/components/ticket/TicketPanels";
import { ProcessMap } from "@/components/ProcessMap";
import { fmtDateTime as fmtDateTimeLib } from "@/lib/dates";

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
  parent_submission_id?: string | null;
  ref_number?: string | null;
  priority?: string | null;
  flag?: string | null;
};

type EventRow = {
  id: string;
  actor_id: string | null;
  action: string;
  comment: string | null;
  target_id: string | null;
  created_at: string;
};

type QueryRow = {
  id: string;
  asked_by: string;
  asked_to: string;
  question: string;
  answer: string | null;
  answered_at: string | null;
  created_at: string;
};

type LinkedSub = { id: string; status: string | null; form_template_id: string; formName?: string };

// What each kind of event reads as in the history.
const EVENT_TEXT: Record<string, string> = {
  submitted: "submitted it",
  approved: "approved",
  rejected: "rejected it",
  clarification: "asked the requester for clarification",
  resumed: "resumed it",
  forwarded: "forwarded their step to",
  reviewer_added: "asked for a review from",
  returned: "returned it to",
  recalled: "took it back to edit",
  cancelled: "cancelled it",
  question: "asked a question of",
  answer: "answered",
  completed: "— every approver has cleared it",
  followup_created: "— a follow-up was started",
};

type ApprovalRow = ChainRow & {
  submission_id: string | null;
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
  return fmtDateTimeLib(iso);
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
  const { currentUser } = useCurrentUser();
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [form, setForm] = useState<FormRow | null>(null);
  const [submitter, setSubmitter] = useState<EmployeeRow | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [employees, setEmployees] = useState<Record<string, EmployeeRow>>({});
  const [linkedFieldTypes, setLinkedFieldTypes] = useState<string[]>([]);
  const [gatePassCardNum, setGatePassCardNum] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [parent, setParent] = useState<LinkedSub | null>(null);
  const [followups, setFollowups] = useState<LinkedSub[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileFields, setFileFields] = useState<string[]>([]);
  const [view, setView] = useState<"timeline" | "map">("timeline");
  const navigate = useNavigate();
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
      .order("step_index", { ascending: true })
      .order("lane")
      .order("lane_step");
    const list = (appr as ApprovalRow[] | null) || [];
    setApprovals(list);

    // The trail, the questions asked about it, and what it is linked to.
    const [{ data: ev }, { data: qs }, { data: kids }] = await Promise.all([
      db.from("approval_events").select("id, actor_id, action, comment, target_id, created_at")
        .eq("subject_id", submissionId).order("created_at"),
      db.from("approval_queries").select("id, asked_by, asked_to, question, answer, answered_at, created_at")
        .eq("subject_id", submissionId).order("created_at"),
      db.from("form_submissions").select("id, status, form_template_id")
        .eq("parent_submission_id", submissionId),
    ]);
    setEvents((ev ?? []) as EventRow[]);
    setQueries((qs ?? []) as QueryRow[]);
    const parentId = (sub as SubmissionRow | null)?.parent_submission_id ?? null;
    const linked: LinkedSub[] = [...((kids ?? []) as LinkedSub[])];
    let parentRow: LinkedSub | null = null;
    if (parentId) {
      const { data: p } = await db.from("form_submissions")
        .select("id, status, form_template_id").eq("id", parentId).maybeSingle();
      parentRow = (p as LinkedSub | null) ?? null;
    }
    const tplIds = Array.from(new Set([...linked, ...(parentRow ? [parentRow] : [])].map((l) => l.form_template_id)));
    if (tplIds.length) {
      const { data: tpls } = await db.from("form_templates").select("id, name").in("id", tplIds);
      const names: Record<string, string> = {};
      (tpls ?? []).forEach((t) => { names[t.id] = t.name; });
      linked.forEach((l) => { l.formName = names[l.form_template_id]; });
      if (parentRow) parentRow.formName = names[parentRow.form_template_id];
    }
    setFollowups(linked);
    setParent(parentRow);

    // The questions a document can answer, so a new one can be attached
    // to the right one.
    if ((sub as SubmissionRow | null)?.form_template_id) {
      const { data: ff } = await db.from("form_fields").select("field_name")
        .eq("form_template_id", (sub as SubmissionRow).form_template_id as string).eq("field_type", "file");
      setFileFields((ff ?? []).map((f) => f.field_name as string).filter(Boolean));
    }

    const ids = Array.from(
      new Set([
        ...list.map((r) => r.approver_user_id),
        ...list.map((r) => r.reassigned_from),
        ...((ev ?? []) as EventRow[]).flatMap((e) => [e.actor_id, e.target_id]),
        ...((qs ?? []) as QueryRow[]).flatMap((q) => [q.asked_by, q.asked_to]),
      ].filter((x): x is string => !!x && !/^[0-9a-f]{8}-/.test(x))),
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

  // The engine keeps the submission's own status, and it knows things the
  // steps cannot say: taken back to edit, cancelled.
  const KNOWN: StatusKey[] = ["draft", "submitted", "in_progress", "on_hold", "completed", "rejected", "cancelled"];
  const overall: StatusKey = KNOWN.includes(submission.status as StatusKey)
    ? (submission.status as StatusKey)
    : deriveOverallStatus(approvals);
  const isRequester = submission.submitted_by === currentUser.employee_id;
  const canWithdraw =
    isRequester &&
    ["submitted", "in_progress", "on_hold"].includes(submission.status ?? "") &&
    !approvals.some((r) => r.status === "approved");
  const nameOf = (id?: string | null) => (id ? employees[id]?.name ?? id : "Somebody");
  // On the request: raised it, or an approver on it. Whoever is copied is
  // on it too; the database is the judge of every write either way.
  const involved = isRequester || approvals.some((r) => r.approver_user_id === currentUser.employee_id);
  const closed = submission.status === "cancelled";

  async function copy() {
    if (!submission?.form_template_id) return;
    setBusy(true);
    const { data, error } = await copySubmission(submission.id, currentUser.employee_id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Copied — edit it and submit when ready");
    navigate({ to: "/forms/$formId", params: { formId: submission.form_template_id }, search: { draft: data as string } });
  }

  async function recall() {
    if (!submission) return;
    setBusy(true);
    const { error } = await recallSubmission(submission.id, currentUser.employee_id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Taken back — edit it and submit again when ready");
    if (submission.form_template_id) {
      navigate({ to: "/forms/$formId", params: { formId: submission.form_template_id }, search: { draft: submission.id } });
    }
  }

  async function cancel() {
    if (!submission) return;
    setBusy(true);
    const { error } = await cancelSubmission(submission.id, currentUser.employee_id, cancelReason);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Cancelled");
    setCancelling(false);
    void loadAll();
  }

  async function answer(q: QueryRow) {
    const text = (answers[q.id] ?? "").trim();
    if (!text) { toast.error("Write an answer first"); return; }
    setBusy(true);
    const { error } = await answerQuestion(q.id, text, currentUser.employee_id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Answered");
    setAnswers((a) => ({ ...a, [q.id]: "" }));
    void loadAll();
  }
  const refCode = submission.ref_number ?? `AMS-${submissionId.slice(0, 8).toUpperCase()}`;

  // This screen is the requester's view and has no actions on it. An
  // approver who arrives here — from a notification, the dashboard, or a
  // link — could read the whole history and had no way to act on it
  // except finding the queue again through the sidebar.
  const myOpenStep = approvals.find(
    (r) =>
      r.approver_user_id === currentUser.employee_id &&
      (r.status === "pending" || r.status === "clarification"),
  );

  // Phases, lanes and steps, drawn the way the engine runs them.
  const steps: Step[] = buildTimeline(approvals, employees);

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

  // The engine's own trail, when there is one: it keeps what the steps
  // overwrite — a step approved, returned and approved again; a forward;
  // a question. Older requests predate it and fall back to the steps.
  if (events.length > 0) {
    activity.length = 0;
    for (const e of events) {
      const target = e.target_id && !/^[0-9a-f]{8}-/.test(e.target_id) ? ` ${nameOf(e.target_id)}` : "";
      activity.push({
        at: e.created_at,
        who: e.actor_id ? nameOf(e.actor_id) : "System",
        role: e.actor_id ? employees[e.actor_id]?.designation || "Approver" : "Approval engine",
        action: (EVENT_TEXT[e.action] ?? e.action) + target + (e.comment ? ` — "${e.comment}"` : ""),
        state: "pending" as StepState,
      });
    }
  }

  // Prepend the submission itself
  if (events.length === 0 && submission.submitted_at) {
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
          <div className="flex flex-col items-end gap-2" style={{ flexShrink: 0 }}>
            <StatusBadge status={overall} size="lg" showIcon />
            {/* The whole request — answers, every decision, signatures — as
                one document to file or forward. */}
            <a
              href={`/records/${submission.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md"
              style={{ padding: "5px 10px", fontSize: 12, fontWeight: 500, color: "#3F3F46", border: "1px solid #E4E4E7", background: "#fff", textDecoration: "none" }}
            >
              <FileDown size={13} /> Approval record (PDF)
            </a>
            <div className="flex gap-1.5">
              {submission.flag && (
                <span className="rounded-full text-[11.5px] font-semibold" style={{ padding: "2px 10px", background: "#FDF2F8", color: "#BE185D", border: "1px solid #FBCFE8" }}>
                  {submission.flag}
                </span>
              )}
              {submission.priority && submission.priority !== "normal" && (
                <span className="rounded-full text-[11.5px] font-semibold" style={{
                  padding: "2px 10px",
                  background: submission.priority === "urgent" ? "#FEF2F2" : "#FFFBEB",
                  color: submission.priority === "urgent" ? "#B91C1C" : "#B45309",
                  border: `1px solid ${submission.priority === "urgent" ? "#FECACA" : "#FDE68A"}`,
                }}>
                  {submission.priority === "urgent" ? "Urgent" : "High priority"}
                </span>
              )}
            </div>
            <button
              onClick={copy}
              disabled={busy}
              className="rounded-md text-[12.5px] font-medium"
              style={{ padding: "5px 10px", border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46" }}
            >
              Copy to a new request
            </button>
          </div>
        </div>
      </div>

      {/* Waiting on the person reading it */}
      {myOpenStep && (
        <Link
          to="/approvals"
          search={{ focus: submissionId }}
          className="flex items-center gap-3 rounded-xl mb-6"
          style={{ padding: "16px 20px", background: "#EEF2FF", border: "1px solid #C7D2FE", textDecoration: "none" }}
        >
          <Clock size={20} style={{ color: "#4338CA", flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[14px]" style={{ color: "#3730A3" }}>
              {myOpenStep.status === "clarification"
                ? "You put this on hold"
                : "This is waiting on you"}
            </div>
            <div className="text-[12px]" style={{ color: "#4338CA" }}>
              {myOpenStep.status === "clarification"
                ? "Open it in your queue to resume it"
                : "Open it in your queue to approve, reject or ask for clarification"}
            </div>
          </div>
          <span className="text-[13px] font-medium" style={{ color: "#4338CA" }}>Open →</span>
        </Link>
      )}

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

      {/* A draft is finished on the form, not here */}
      {submission.status === "draft" && isRequester && submission.form_template_id && (
        <Link
          to="/forms/$formId"
          params={{ formId: submission.form_template_id }}
          search={{ draft: submission.id }}
          className="flex items-center gap-3 rounded-xl mb-6"
          style={{ padding: "16px 20px", background: "#EEF2FF", border: "1px solid #C7D2FE", textDecoration: "none" }}
        >
          <FileText size={20} style={{ color: "#4338CA", flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[14px]" style={{ color: "#3730A3" }}>This is still a draft</div>
            <div className="text-[12px]" style={{ color: "#4338CA" }}>
              {parent ? "It was started for you with the details already filled in. " : ""}Open it to check it and submit.
            </div>
          </div>
          <span className="text-[13px] font-medium" style={{ color: "#4338CA" }}>Open →</span>
        </Link>
      )}

      <LinksPanel submissionId={submissionId} actor={currentUser.employee_id} canWrite={involved && !closed} parentId={submission.parent_submission_id ?? null} />

      {/* The requester can take it back until somebody approves */}
      {canWithdraw && (
        <div className="rounded-xl bg-white mb-6" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[13px]" style={{ color: "#3F3F46" }}>
              Nobody has approved this yet, so you can still take it back to edit, or cancel it.
            </div>
            <div className="flex gap-2">
              <button
                onClick={recall}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium"
                style={{ padding: "7px 12px", border: "1px solid #E4E4E7", background: "#fff", color: "#18181B" }}
              >
                <Undo2 size={13} /> Take back to edit
              </button>
              <button
                onClick={() => setCancelling((v) => !v)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium"
                style={{ padding: "7px 12px", border: "1px solid #FECACA", background: "#fff", color: "#B91C1C" }}
              >
                <XCircle size={13} /> Cancel request
              </button>
            </div>
          </div>
          {cancelling && (
            <div className="flex gap-2 mt-3">
              <input
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Why is it being cancelled? (optional)"
                className="flex-1 rounded-md text-[13px]"
                style={{ padding: "7px 10px", border: "1px solid #E4E4E7" }}
              />
              <button
                onClick={cancel}
                disabled={busy}
                className="rounded-md text-[13px] font-medium"
                style={{ padding: "7px 12px", background: "#DC2626", color: "#fff" }}
              >
                Confirm cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* Questions between approvers */}
      {queries.length > 0 && (
        <div className="rounded-xl bg-white mb-6" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: "#52525B" }}>
            <MessageCircleQuestion size={13} /> Questions between approvers
          </div>
          <div className="flex flex-col gap-3">
            {queries.map((q) => (
              <div key={q.id} className="rounded-lg" style={{ padding: "10px 12px", background: "#FAFAFA", border: "1px solid #F4F4F5" }}>
                <div className="text-[12px]" style={{ color: "#71717A" }}>
                  {nameOf(q.asked_by)} asked {nameOf(q.asked_to)} · {fmtDateTime(q.created_at)}
                </div>
                <div className="text-[13.5px] mt-1" style={{ color: "#18181B" }}>{q.question}</div>
                {q.answer ? (
                  <div className="text-[13px] mt-2" style={{ color: "#3F3F46", paddingLeft: 10, borderLeft: "2px solid #C7D2FE" }}>
                    {q.answer}
                    <span className="text-[11.5px]" style={{ color: "#A1A1AA" }}> — {nameOf(q.asked_to)}, {fmtDateTime(q.answered_at)}</span>
                  </div>
                ) : q.asked_to === currentUser.employee_id ? (
                  <div className="flex gap-2 mt-2">
                    <input
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      placeholder="Your answer"
                      className="flex-1 rounded-md text-[13px]"
                      style={{ padding: "7px 10px", border: "1px solid #E4E4E7", background: "#fff" }}
                    />
                    <button
                      onClick={() => answer(q)}
                      disabled={busy}
                      className="rounded-md text-[13px] font-medium"
                      style={{ padding: "7px 12px", background: "var(--color-brand-500)", color: "#fff" }}
                    >
                      Answer
                    </button>
                  </div>
                ) : (
                  <div className="text-[12px] mt-1.5" style={{ color: "#B45309" }}>Waiting for an answer</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <DocumentsPanel submissionId={submissionId} actor={currentUser.employee_id} canWrite={(involved || submission.status === "draft") && !closed} fileFields={fileFields} />
      <CcPanel submissionId={submissionId} actor={currentUser.employee_id} isRequester={isRequester && !closed} />
      <NotesPanel submissionId={submissionId} actor={currentUser.employee_id} canWrite={involved} />

      {/* Timeline, or the same route as a flowchart */}
      {steps.length > 0 && (
        <div className="flex gap-1 mb-4" role="tablist" aria-label="Route view">
          {(["timeline", "map"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className="rounded-md text-[12.5px] font-medium"
              style={{
                padding: "5px 12px",
                border: `1px solid ${view === v ? "#C7D2FE" : "#E4E4E7"}`,
                background: view === v ? "#EEF2FF" : "#fff",
                color: view === v ? "#4338CA" : "#52525B",
              }}
            >
              {v === "timeline" ? "Timeline" : "Process map"}
            </button>
          ))}
        </div>
      )}
      {steps.length > 0 && view === "map" ? (
        <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: 16 }}>
          <ProcessMap rows={approvals} people={employees} />
        </div>
      ) : steps.length > 0 ? (
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
