import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Inbox, Clock } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/approvals")({
  head: () => ({
    meta: [{ title: "Approvals · Admin Services Portal" }],
  }),
  component: ApprovalsPage,
});

type Row = {
  id: string;
  submission_id: string | null;
  subject_id: string | null;
  subject_type: string | null;
  step_index: number | null;
  approver_user_id: string | null;
  reassigned_from: string | null;
  status: string | null;
  deadline_at: string | null;
  acted_at: string | null;
  comment: string | null;
  // joined
  formName?: string;
  subjectLabel?: string;
  submittedAt?: string | null;
  submittedBy?: string | null;
  submitterName?: string;
  submitterDept?: string;
  actingFor?: string;
};

type SubVal = { field_name: string | null; value: string | null };

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatValue(raw: string | null): ReactNode {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return <span style={{ color: "#A1A1AA" }}>—</span>;
  }

  // Boolean-like strings
  if (raw === "true" || raw === "Yes") {
    return (
      <span
        className="inline-flex items-center gap-1 font-medium"
        style={{ color: "#16A34A", fontSize: 13 }}
      >
        <span style={{ fontSize: 15 }}>✓</span> Yes
      </span>
    );
  }
  if (raw === "false" || raw === "No") {
    return <span style={{ color: "#A1A1AA" }}>No</span>;
  }

  // Try JSON
  try {
    const parsed = JSON.parse(raw);

    // Array → pill badges
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return <span style={{ color: "#A1A1AA" }}>—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {parsed.map((item, i) => (
            <span
              key={i}
              style={{
                padding: "2px 9px",
                fontSize: 11.5,
                borderRadius: 9999,
                background: "#F4F4F5",
                color: "#3F3F46",
                border: "1px solid #E4E4E7",
              }}
            >
              {String(item)}
            </span>
          ))}
        </div>
      );
    }

    // Employee object
    if (parsed.employee_id && parsed.name) {
      return (
        <span>
          <span style={{ fontWeight: 500, color: "#18181B" }}>{parsed.name}</span>
          <span style={{ color: "#71717A", marginLeft: 6 }}>
            {parsed.employee_id}
            {parsed.designation ? ` · ${parsed.designation}` : ""}
            {parsed.department ? ` · ${parsed.department}` : ""}
          </span>
        </span>
      );
    }

    // Date range
    if (parsed.from && parsed.to) {
      return `${fmtDate(parsed.from)} – ${fmtDate(parsed.to)}`;
    }

    return raw;
  } catch {
    // Pure number → add thousand separators
    if (/^\d+(\.\d+)?$/.test(raw.trim())) {
      const n = parseFloat(raw);
      return n.toLocaleString("en-US");
    }
    return raw;
  }
}

function ApprovalsPage() {
  const matchRoute = useMatchRoute();
  const isChild =
    !!matchRoute({ to: "/approvals/history" }) ||
    !!matchRoute({ to: "/approvals/delegate" });
  if (isChild) return <Outlet />;
  return <ApprovalsInbox />;
}

function ApprovalsInbox() {
  const { currentUser } = useCurrentUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, SubVal[]>>({});
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  const [modal, setModal] = useState<
    | { kind: "reject" | "clarify" | "forward" | "reviewer"; row: Row }
    | null
  >(null);
  const [comment, setComment] = useState("");
  const [personId, setPersonId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    // There is no scheduler behind a demo, so the screen that shows
    // overdue work is the thing that asks for the reminders. In a real
    // deployment this would be a timer, not a page load — the function
    // itself only writes one reminder per person per day, so calling it
    // on every visit is harmless.
    await db.rpc("remind_overdue", {});

    const today = new Date().toISOString().slice(0, 10);

    // Load active delegations TO the current user (with optional form scope)
    const { data: delegations } = await db
      .from("delegation_rules")
      .select("delegator_id, delegate_id, form_template_ids")
      .eq("delegate_id", currentUser.employee_id)
      .lte("start_date", today)
      .gte("end_date", today);

    const delegatorIds = (delegations ?? []).map((d) => d.delegator_id);

    // Map: delegator_id → scoped form_template_ids (null = all forms)
    const delegationScope: Record<string, string[] | null> = {};
    (delegations ?? []).forEach((d) => { delegationScope[d.delegator_id] = (d as { form_template_ids: string[] | null }).form_template_ids ?? null; });

    let delegatorNames: Record<string, string> = {};
    if (delegatorIds.length > 0) {
      const { data: delEmps } = await db
        .from("employees")
        .select("employee_id, name")
        .in("employee_id", delegatorIds);
      (delEmps ?? []).forEach((e) => { delegatorNames[e.employee_id] = e.name; });
    }

    const approverIds = [currentUser.employee_id, ...delegatorIds];

    const { data: appr, error } = await db
      .from("approval_requests")
      .select("*")
      .in("approver_user_id", approverIds)
      // 'clarification' belongs here too. A step paused for clarification
      // is still assigned to you and still needs you to act — leaving it
      // out meant the only screen that could resume it never showed it,
      // and the request could never move again.
      .in("status", ["pending", "clarification"])
      // Soonest target first, so the queue is ordered by what is most
      // pressing rather than by insertion. This is the one thing the
      // target date actually drives — see the note in the timeline.
      .order("deadline_at");
    if (error) {
      toast.error("Failed to load approvals");
      setLoading(false);
      return;
    }
    const list = ((appr || []) as Row[]).map((r) => ({
      ...r,
      actingFor:
        r.approver_user_id !== currentUser.employee_id
          ? delegatorNames[r.approver_user_id ?? ""] ?? r.approver_user_id ?? undefined
          : undefined,
    }));

    const submissionIds = Array.from(
      new Set(list.map((r) => r.submission_id).filter(Boolean) as string[]),
    );
    let subsMap: Record<
      string,
      { form_template_id: string | null; submitted_at: string | null; submitted_by: string | null }
    > = {};
    let formsMap: Record<string, string> = {};
    let empMap: Record<string, { name: string; department: string | null }> = {};

    if (submissionIds.length) {
      const { data: subs } = await db
        .from("form_submissions")
        .select("id, form_template_id, submitted_at, submitted_by")
        .in("id", submissionIds);
      (subs || []).forEach((s) => {
        subsMap[s.id] = s;
      });
      const formIds = Array.from(
        new Set((subs || []).map((s) => s.form_template_id).filter(Boolean) as string[]),
      );
      const submitterIds = Array.from(
        new Set((subs || []).map((s) => s.submitted_by).filter(Boolean) as string[]),
      );
      if (formIds.length) {
        const { data: forms } = await db
          .from("form_templates")
          .select("id, name")
          .in("id", formIds);
        (forms || []).forEach((f) => {
          formsMap[f.id] = f.name;
        });
      }
      if (submitterIds.length) {
        const { data: emps } = await db
          .from("employees")
          .select("employee_id, name, department")
          .in("employee_id", submitterIds);
        (emps || []).forEach((e) => {
          empMap[e.employee_id] = { name: e.name, department: e.department };
        });
      }
    }

    // The queue is one queue. A step hangs off a submission, a notice, a
    // stationery request or a maintenance request, and each of them
    // names itself differently — so each is looked up in its own table
    // and reduced to a label and a requester.
    const subjectLabels: Record<string, string> = {};
    const subjectRequesters: Record<string, string> = {};

    const idsOf = (t: string) =>
      Array.from(new Set(
        list.filter((r) => r.subject_type === t)
            .map((r) => r.subject_id)
            .filter(Boolean) as string[]));

    const noticeIds = idsOf("notice");
    if (noticeIds.length) {
      const { data } = await db
        .from("notices").select("id, title, created_by").in("id", noticeIds);
      (data ?? []).forEach((n) => {
        subjectLabels[n.id] = n.title ?? "Notice";
        if (n.created_by) subjectRequesters[n.id] = n.created_by;
      });
    }

    const stationeryIds = idsOf("stationery_request");
    if (stationeryIds.length) {
      const { data } = await db
        .from("stationery_requests").select("id, kind, name, requester_id").in("id", stationeryIds);
      (data ?? []).forEach((r) => {
        const kind = r.kind === "business_card" ? "Business card"
          : r.kind === "stamp_seal" ? "Stamp and seal" : String(r.kind ?? "Stationery");
        subjectLabels[r.id] = r.name ? kind + " — " + r.name : kind;
        if (r.requester_id) subjectRequesters[r.id] = r.requester_id;
      });
    }

    const maintenanceIds = idsOf("maintenance_request");
    if (maintenanceIds.length) {
      const { data } = await db
        .from("maintenance_requests").select("id, ref_number, location, requester_id").in("id", maintenanceIds);
      (data ?? []).forEach((m) => {
        subjectLabels[m.id] = [m.ref_number, m.location].filter(Boolean).join(" — ") || "Maintenance";
        if (m.requester_id) subjectRequesters[m.id] = m.requester_id;
      });
    }

    const extraRequesters = Array.from(new Set(Object.values(subjectRequesters)))
      .filter((id) => !(id in empMap));
    if (extraRequesters.length) {
      const { data } = await db
        .from("employees").select("employee_id, name, department").in("employee_id", extraRequesters);
      (data ?? []).forEach((e) => {
        empMap[e.employee_id] = { name: e.name, department: e.department };
      });
    }

    const enriched: Row[] = list
      .filter((r) => {
        if (r.approver_user_id === currentUser.employee_id) return true;
        // Delegated row — check form scope
        const scope = r.approver_user_id ? delegationScope[r.approver_user_id] : null;
        if (!scope) return true; // null = all forms
        // A delegation scoped to particular forms does not carry a
        // notice or a maintenance request with it.
        if (r.subject_type !== "form_submission") return false;
        const sub = r.submission_id ? subsMap[r.submission_id] : undefined;
        return sub?.form_template_id ? scope.includes(sub.form_template_id) : false;
      })
      .map((r) => {
        const sub = r.submission_id ? subsMap[r.submission_id] : undefined;
        const requester = sub?.submitted_by
          ?? (r.subject_id ? subjectRequesters[r.subject_id] : undefined);
        const submitter = requester ? empMap[requester] : undefined;
        const label = sub?.form_template_id
          ? formsMap[sub.form_template_id]
          : (r.subject_id ? subjectLabels[r.subject_id] : undefined);
        return {
          ...r,
          formName: label,
          subjectLabel: label,
          submittedAt: sub?.submitted_at,
          submittedBy: requester,
          submitterName: submitter?.name,
          submitterDept: submitter?.department || undefined,
        };
      });

    setRows(enriched);
    setLoading(false);
  }, [currentUser.employee_id]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleExpand = async (row: Row) => {
    if (expanded === row.id) {
      setExpanded(null);
      return;
    }
    setExpanded(row.id);
    if (row.submission_id && !values[row.submission_id]) {
      const { data } = await db
        .from("submission_values")
        .select("field_name, value")
        .eq("submission_id", row.submission_id);
      setValues((v) => ({ ...v, [row.submission_id!]: (data || []) as SubVal[] }));
    }
  };

  const fadeAndRemove = (id: string) => {
    setRemoving((s) => new Set(s).add(id));
    setTimeout(() => {
      setRows((r) => r.filter((x) => x.id !== id));
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }, 320);
  };

  // One way to act on a step, whatever kind of thing it is attached to.
  //
  // The transition is not done here. Marking the step, opening the next
  // one and moving the subject's status are three writes that have to
  // agree, and whether it is even this approver's turn is not a question
  // a browser should answer — so the client asks, and the database
  // decides. What used to live here recomputed the submission's status
  // by counting siblings, which was wrong the moment steps had an order:
  // it read "waiting" as "not approved yet" and completed nothing.
  const act = async (
    row: Row,
    action: "approve" | "reject" | "clarification" | "resume",
    note?: string,
  ): Promise<boolean> => {
    const { error } = await db.rpc("act_on_approval", {
      p_request_id: row.id,
      p_action: action,
      p_comment: note?.trim() || null,
    });
    if (error) {
      toast.error(error.message);
      return false;
    }

    const what = row.subjectLabel ?? row.formName ?? "a request";
    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action:
        action === "approve" ? "approved"
        : action === "reject" ? "rejected"
        : action === "resume" ? "resumed"
        : "clarification_requested",
      entity_type: row.subject_type ?? "form_submission",
      entity_id: row.subject_id,
      detail:
        (action === "approve" ? "Approved "
         : action === "reject" ? "Rejected "
         : action === "resume" ? "Resumed "
         : "Requested clarification on ") + what,
    });
    return true;
  };

  const handleApprove = async (row: Row) => {
    if (!(await act(row, "approve"))) return;
    toast.success("Approved — it has moved to the next approver");
    fadeAndRemove(row.id);
  };

  // Resuming puts the step back to pending with you, so it stays in the
  // queue rather than leaving it — reload instead of fading out.
  const handleResume = async (row: Row) => {
    if (!(await act(row, "resume"))) return;
    toast.success("Resumed — it is back with you to decide");
    void load();
  };

  // Forwarding moves this step to somebody else and keeps its place in
  // the chain. Adding a reviewer inserts a step after this one and
  // shuffles the rest up — both are the database's job, because both
  // have to leave the chain walkable.
  const submitPerson = async () => {
    if (!modal) return;
    const to = personId.trim();
    if (!to) {
      toast.error("Enter an employee ID");
      return;
    }
    setSubmitting(true);
    const { error } = modal.kind === "forward"
      ? await db.rpc("reassign_approval", {
          p_request_id: modal.row.id, p_to: to, p_comment: comment.trim() || null,
        })
      : await db.rpc("add_reviewer", {
          p_request_id: modal.row.id, p_employee: to, p_deadline_days: 7,
        });
    if (error) {
      toast.error(error.message);
      setSubmitting(false);
      return;
    }

    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: modal.kind === "forward" ? "reassigned" : "reviewer_added",
      entity_type: modal.row.subject_type ?? "form_submission",
      entity_id: modal.row.subject_id,
      detail: (modal.kind === "forward" ? "Forwarded to " : "Added " + to + " as a reviewer on ")
        + (modal.kind === "forward" ? to + " — " + (modal.row.subjectLabel ?? "a request")
                                    : (modal.row.subjectLabel ?? "a request")),
    });

    toast.success(modal.kind === "forward"
      ? "Forwarded — it is with " + to + " now"
      : to + " will be asked after you");
    // Forwarding hands the step away, so it leaves this queue. Adding a
    // reviewer does not: the step is still ours to answer.
    if (modal.kind === "forward") fadeAndRemove(modal.row.id);
    setModal(null);
    setComment("");
    setPersonId("");
    setSubmitting(false);
  };

  const submitModal = async () => {
    if (!modal) return;
    if (modal.kind === "forward" || modal.kind === "reviewer") return submitPerson();
    if (!comment.trim()) {
      toast.error("Please provide a reason");
      return;
    }
    setSubmitting(true);
    const action = modal.kind === "reject" ? "reject" : "clarification";
    const ok = await act(modal.row, action, comment);
    if (!ok) {
      setSubmitting(false);
      return;
    }
    toast.success(
      modal.kind === "reject"
        ? "Request rejected — the approvers above were not asked"
        : "Clarification requested — the request is on hold with you",
    );
    fadeAndRemove(modal.row.id);
    setModal(null);
    setComment("");
    setSubmitting(false);
  };

  return (
    <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="mb-6">
        <h1
          style={{
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "#18181B",
            margin: 0,
          }}
        >
          Approvals
        </h1>
        <p style={{ marginTop: 6, fontSize: 14, color: "#71717A" }}>
          Pending requests assigned to you ({currentUser.name}).
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const isOverdue =
              r.deadline_at && new Date(r.deadline_at).getTime() < Date.now();
            const isExpanded = expanded === r.id;
            const isRemoving = removing.has(r.id);
            const submissionVals = r.submission_id ? values[r.submission_id] : undefined;
            return (
              <div
                key={r.id}
                className="rounded-xl bg-white"
                style={{
                  border: "1px solid #E4E4E7",
                  transition: "opacity 320ms, transform 320ms",
                  opacity: isRemoving ? 0 : 1,
                  transform: isRemoving ? "translateY(-6px)" : "none",
                }}
              >
                <button
                  onClick={() => toggleExpand(r)}
                  className="w-full text-left"
                  style={{ padding: 18, display: "block" }}
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
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
                          {r.submitterName || r.submittedBy || "—"}
                        </span>
                        {r.submitterDept && (
                          <span style={{ color: "#71717A" }}> · {r.submitterDept}</span>
                        )}
                      </div>
                      {r.actingFor && (
                        <div
                          className="inline-flex items-center gap-1 rounded-full font-medium mt-1"
                          style={{ padding: "2px 8px", fontSize: 11, background: "#FFF7ED", color: "#C2410C", border: "1px solid #FED7AA" }}
                        >
                          Acting for {r.actingFor}
                        </div>
                      )}
                      <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 8 }}>
                        <span
                          className="inline-flex items-center gap-1"
                          style={{ fontSize: 12, color: "#71717A" }}
                        >
                          <Clock size={12} /> Submitted {fmtDate(r.submittedAt)}
                        </span>
                        <span style={{ fontSize: 12, color: "#71717A" }}>
                          Deadline {fmtDate(r.deadline_at)}
                        </span>
                        {isOverdue && (
                          <span
                            className="inline-flex items-center rounded-full font-medium"
                            style={{
                              padding: "2px 8px",
                              fontSize: 11,
                              background: "#FEF2F2",
                              color: "#B91C1C",
                              border: "1px solid #FECACA",
                            }}
                          >
                            Overdue
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {r.status === "clarification" ? (
                        <>
                          <span
                            className="inline-flex items-center rounded-full font-medium"
                            style={{
                              padding: "2px 8px",
                              fontSize: 11,
                              background: "#FFFBEB",
                              color: "#B45309",
                              border: "1px solid #FDE68A",
                            }}
                          >
                            Awaiting clarification
                          </span>
                          <button
                            onClick={() => handleResume(r)}
                            className="rounded-md text-white font-medium"
                            style={{
                              padding: "7px 14px",
                              fontSize: 13,
                              background: "#4F46E5",
                              border: "1px solid #4F46E5",
                            }}
                          >
                            Resume
                          </button>
                        </>
                      ) : (
                      <>
                      <button
                        onClick={() => handleApprove(r)}
                        className="rounded-md text-white font-medium"
                        style={{
                          padding: "7px 14px",
                          fontSize: 13,
                          background: "#4F46E5",
                          border: "1px solid #4F46E5",
                        }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => {
                          setComment("");
                          setModal({ kind: "reject", row: r });
                        }}
                        className="rounded-md font-medium bg-white"
                        style={{
                          padding: "7px 12px",
                          fontSize: 13,
                          color: "#B91C1C",
                          border: "1px solid #FECACA",
                        }}
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => {
                          setComment("");
                          setModal({ kind: "clarify", row: r });
                        }}
                        className="rounded-md font-medium bg-white"
                        style={{
                          padding: "7px 12px",
                          fontSize: 13,
                          color: "#52525B",
                          border: "1px solid #E4E4E7",
                        }}
                      >
                        Clarify
                      </button>
                      <button
                        onClick={() => {
                          setComment("");
                          setPersonId("");
                          setModal({ kind: "forward", row: r });
                        }}
                        className="rounded-md font-medium bg-white"
                        style={{
                          padding: "7px 12px",
                          fontSize: 13,
                          color: "#52525B",
                          border: "1px solid #E4E4E7",
                        }}
                      >
                        Forward
                      </button>
                      <button
                        onClick={() => {
                          setComment("");
                          setPersonId("");
                          setModal({ kind: "reviewer", row: r });
                        }}
                        className="rounded-md font-medium bg-white"
                        style={{
                          padding: "7px 12px",
                          fontSize: 13,
                          color: "#52525B",
                          border: "1px solid #E4E4E7",
                        }}
                      >
                        Add reviewer
                      </button>
                      </>
                      )}
                      <span style={{ color: "#A1A1AA", marginLeft: 4 }}>
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </span>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div style={{ borderTop: "1px solid #F4F4F5", background: "#FAFAFA" }}>
                    {!submissionVals ? (
                      <div style={{ padding: "16px 18px", fontSize: 13, color: "#A1A1AA" }}>Loading…</div>
                    ) : submissionVals.length === 0 ? (
                      <div style={{ padding: "16px 18px", fontSize: 13, color: "#A1A1AA" }}>No values submitted.</div>
                    ) : (
                      <div style={{ padding: "4px 0" }}>
                        {submissionVals.map((v, i) => {
                          // Section headers have no meaningful value — render as divider
                          const isEmpty = v.value === null || v.value === "";
                          if (isEmpty) {
                            return (
                              <div
                                key={i}
                                style={{
                                  padding: "10px 18px 4px",
                                  fontSize: 10.5,
                                  fontWeight: 700,
                                  letterSpacing: "0.09em",
                                  textTransform: "uppercase",
                                  color: "#A1A1AA",
                                  borderTop: i > 0 ? "1px solid #F0F0F0" : undefined,
                                  marginTop: i > 0 ? 4 : 0,
                                }}
                              >
                                {v.field_name}
                              </div>
                            );
                          }
                          return (
                            <div
                              key={i}
                              className="flex gap-4"
                              style={{
                                padding: "8px 18px",
                                borderBottom: "1px solid #F4F4F5",
                                alignItems: "flex-start",
                              }}
                            >
                              <div
                                style={{
                                  width: 180,
                                  flexShrink: 0,
                                  fontSize: 12.5,
                                  color: "#71717A",
                                  paddingTop: 1,
                                  lineHeight: 1.5,
                                }}
                              >
                                {v.field_name}
                              </div>
                              <div style={{ flex: 1, fontSize: 13, color: "#18181B", lineHeight: 1.5 }}>
                                {formatValue(v.value)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {r.submission_id && (
                      <div style={{ padding: "12px 18px", borderTop: "1px solid #F0F0F0" }}>
                        <Link
                          to="/status/$submissionId"
                          params={{ submissionId: r.submission_id }}
                          className="text-sm font-medium"
                          style={{ color: "#4F46E5" }}
                        >
                          View full timeline →
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {modal?.kind === "reject" ? "Reason for rejection"
                : modal?.kind === "clarify" ? "What clarification is needed?"
                : modal?.kind === "forward" ? "Forward this step to somebody else"
                : "Add a reviewer after this step"}
            </DialogTitle>
          </DialogHeader>
          {(modal?.kind === "forward" || modal?.kind === "reviewer") && (
            <label className="flex flex-col gap-1">
              <span style={{ fontSize: 11.5, color: "#71717A" }}>Employee ID</span>
              <input
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
                placeholder="EMP-0312"
                className="rounded-md"
                style={{ padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7" }}
              />
              <span style={{ fontSize: 11.5, color: "#A1A1AA" }}>
                {modal?.kind === "forward"
                  ? "The step keeps its place in the chain; only who answers it changes."
                  : "They are asked after you, before anyone above you."}
              </span>
            </label>
          )}
          {modal?.kind !== "reviewer" && <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            placeholder={
              modal?.kind === "reject"
                ? "Explain why this request is being rejected…"
                : modal?.kind === "clarify" ? "Describe what needs to be clarified…"
                : "Why are you forwarding this? (optional)"
            }
          />}
          <DialogFooter>
            <button
              onClick={() => setModal(null)}
              className="rounded-md font-medium bg-white"
              style={{
                padding: "7px 12px",
                fontSize: 13,
                color: "#52525B",
                border: "1px solid #E4E4E7",
              }}
            >
              Cancel
            </button>
            <button
              onClick={submitModal}
              disabled={submitting}
              className="rounded-md text-white font-medium"
              style={{
                padding: "7px 14px",
                fontSize: 13,
                background: modal?.kind === "reject" ? "#B91C1C" : "#4F46E5",
                border: "1px solid",
                borderColor: modal?.kind === "reject" ? "#B91C1C" : "#4F46E5",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              Confirm
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState() {
  return (
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
        <Inbox size={32} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 500, color: "#A1A1AA" }}>
        No pending approvals
      </div>
      <div style={{ fontSize: 13, color: "#A1A1AA", marginTop: 6 }}>
        You're all caught up.
      </div>
    </div>
  );
}
