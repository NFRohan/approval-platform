import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Inbox, Clock } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { OPEN_STATUSES, answerQuestion, askQuestion, returnToApprover } from "@/lib/chain";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { todayInOrg } from "@/lib/workdays";
import { listAttachments, type AttachmentInfo } from "@/lib/attachment-fn";
import { AttachmentLink } from "@/components/AttachmentLink";
import { SignaturePad } from "@/components/SignaturePad";
import { ClearanceChecklist } from "@/components/ClearanceChecklist";
import { fmtDate as fmtDateLib } from "@/lib/dates";
import { AdminQueue } from "@/components/AdminQueue";

export const Route = createFileRoute("/approvals")({
  // A notification that says your approval is needed can name which
  // request it means, so the queue opens on that one rather than leaving
  // somebody to find it among the others.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
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
  require_signature?: boolean | null;
  // joined
  formName?: string;
  priority?: string | null;
  flag?: string | null;
  subjectLabel?: string;
  submittedAt?: string | null;
  raisedAt?: string | null;
  subjectRef?: string;
  submittedBy?: string | null;
  submitterName?: string;
  submitterDept?: string;
  actingFor?: string;
};

type SubVal = { field_name: string | null; value: string | null };

function fmtDate(iso?: string | null) {
  return fmtDateLib(iso);
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

    // "6000" parses as a number, so it never reached the catch below
    // that adds thousand separators.
    // An identifier that happens to be all digits — a bank account, a phone
    // number, anything led by 0 — stays exactly as typed.
    if (typeof parsed === "number") {
      const digits = raw.trim().replace(/\..*$/, "");
      if (digits.length > 10 || /^0\d/.test(digits)) return raw.trim();
      return parsed.toLocaleString("en-US", { maximumFractionDigits: 4 });
    }

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
    // A date answer, written the one way dates are written here.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return fmtDateLib(raw.trim());
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
  const [adminCount, setAdminCount] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { focus } = Route.useSearch();
  const [focused, setFocused] = useState(false);
  const [values, setValues] = useState<Record<string, SubVal[]>>({});
  const [attachments, setAttachments] = useState<Record<string, AttachmentInfo[]>>({});
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  const [modal, setModal] = useState<
    | { kind: "reject" | "clarify" | "forward" | "reviewer" | "return" | "ask"; row: Row }
    | null
  >(null);
  const [comment, setComment] = useState("");
  const [personId, setPersonId] = useState("");
  const [people, setPeople] = useState<{ employee_id: string; name: string; designation: string | null }[]>([]);
  // Who a step may be forwarded to, where its form keeps forwarding inside
  // the approver's reporting line; null where anybody will do.
  const [forwardOnly, setForwardOnly] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The rest of the chain the open dialog is about: who already approved
  // (somebody to return it to) and who else is on it (somebody to ask).
  const [chainRows, setChainRows] = useState<
    { id: string; approver_user_id: string | null; status: string | null; step_index: number | null; lane: number | null; lane_step: number | null }[]
  >([]);
  // Questions other approvers have asked me, waiting for an answer.
  const [questionRefs, setQuestionRefs] = useState<Record<string, string>>({});
  const [myQuestions, setMyQuestions] = useState<
    { id: string; subject_id: string; subject_type: string; asked_by: string; question: string; created_at: string }[]
  >([]);
  const [qAnswers, setQAnswers] = useState<Record<string, string>>({});
  const [upcoming, setUpcoming] = useState<{ id: string; submissionId: string | null; label: string; href: string | null }[]>([]);
  // A step that asks for a signature opens the pad instead of approving.
  const [signing, setSigning] = useState<Row | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    // There is no scheduler behind a demo, so the screen that shows
    // overdue work is the thing that asks for the reminders. In a real
    // deployment this would be a timer, not a page load — the function
    // itself only writes one reminder per person per day, so calling it
    // on every visit is harmless.
    await db.rpc("remind_overdue", {});

    const { data: qs } = await db
      .from("approval_queries")
      .select("id, subject_id, subject_type, asked_by, question, answer, created_at")
      .eq("asked_to", currentUser.employee_id)
      .is("answer", null)
      .order("created_at");
    setMyQuestions((qs ?? []) as typeof myQuestions);
    // The references everyone else sees, for the requests asked about.
    const qSubs = Array.from(new Set((qs ?? []).filter((q) => q.subject_type === "form_submission").map((q) => q.subject_id as string)));
    if (qSubs.length) {
      const { data: refs } = await db.from("form_submissions").select("id, ref_number").in("id", qSubs);
      setQuestionRefs(Object.fromEntries(((refs ?? []) as { id: string; ref_number: string | null }[]).map((r) => [r.id, r.ref_number ?? ""])));
    }

    // Dhaka's date, not UTC's: the database judges delegation windows on
    // the same calendar, so the queue and the check agree.
    const today = todayInOrg();

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
      .in("status", [...OPEN_STATUSES])
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
      {
        form_template_id: string | null; submitted_at: string | null; submitted_by: string | null;
        ref_number?: string | null; priority?: string | null; flag?: string | null;
      }
    > = {};
    let formsMap: Record<string, string> = {};
    let empMap: Record<string, { name: string; department: string | null }> = {};

    if (submissionIds.length) {
      const { data: subs } = await db
        .from("form_submissions")
        .select("id, form_template_id, submitted_at, submitted_by, ref_number, priority, flag")
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
    // When the request itself was raised — the only thing that tells the
    // one you just fired from the ones that came with the demo.
    const subjectRaised: Record<string, string> = {};

    const idsOf = (t: string) =>
      Array.from(new Set(
        list.filter((r) => r.subject_type === t)
            .map((r) => r.subject_id)
            .filter(Boolean) as string[]));

    const noticeIds = idsOf("notice");
    if (noticeIds.length) {
      const { data } = await db
        .from("notices").select("id, title, created_by, created_at").in("id", noticeIds);
      (data ?? []).forEach((n) => {
        subjectLabels[n.id] = n.title ?? "Notice";
        if (n.created_at) subjectRaised[n.id] = n.created_at;
        if (n.created_by) subjectRequesters[n.id] = n.created_by;
      });
    }

    const stationeryIds = idsOf("stationery_request");
    if (stationeryIds.length) {
      const { data } = await db
        .from("stationery_requests").select("id, kind, name, requester_id, created_at").in("id", stationeryIds);
      (data ?? []).forEach((r) => {
        const kind = r.kind === "business_card" ? "Business card"
          : r.kind === "stamp_seal" ? "Stamp and seal" : String(r.kind ?? "Stationery");
        subjectLabels[r.id] = r.name ? kind + " — " + r.name : kind;
        if (r.created_at) subjectRaised[r.id] = r.created_at;
        if (r.requester_id) subjectRequesters[r.id] = r.requester_id;
      });
    }

    const maintenanceIds = idsOf("maintenance_request");
    if (maintenanceIds.length) {
      const { data } = await db
        .from("maintenance_requests").select("id, ref_number, location, requester_id, created_at").in("id", maintenanceIds);
      (data ?? []).forEach((m) => {
        subjectLabels[m.id] = [m.ref_number, m.location].filter(Boolean).join(" — ") || "Maintenance";
        if (m.created_at) subjectRaised[m.id] = m.created_at;
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
          raisedAt: sub?.submitted_at ?? (r.subject_id ? subjectRaised[r.subject_id] : undefined),
          // Two claims against one form are otherwise the same sentence
          // twice. Same reference the status screen and the bell print.
          subjectRef: r.submission_id
            ? sub?.ref_number ?? `AMS-${r.submission_id.slice(0, 8).toUpperCase()}`
            : undefined,
          priority: sub?.priority ?? null,
          flag: sub?.flag ?? null,
          submittedBy: requester,
          submitterName: submitter?.name,
          submitterDept: submitter?.department || undefined,
        };
      });

    // Grouped by the request rather than by target date. The queue is
    // one queue across four kinds of thing, and with seeded requests
    // sitting in it there was no way to find the one you just raised —
    // a date three days out told you nothing about which was which.
    // Newest first, and anything without a timestamp settles at the end.
    // Urgent first, then high — "fasten the high-priority request
    // approval process" starts with it being the first thing seen.
    const rank = (p?: string | null) => (p === "urgent" ? 0 : p === "high" ? 1 : 2);
    enriched.sort((a, b) => {
      if (rank(a.priority) !== rank(b.priority)) return rank(a.priority) - rank(b.priority);
      const at = a.raisedAt ? Date.parse(a.raisedAt) : NaN;
      const bt = b.raisedAt ? Date.parse(b.raisedAt) : NaN;
      if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
      if (Number.isNaN(at)) return 1;
      if (Number.isNaN(bt)) return -1;
      if (bt !== at) return bt - at;
      // Same request, more than one step showing: keep chain order.
      return (a.step_index ?? 0) - (b.step_index ?? 0);
    });

    setRows(enriched);

    // What is coming: steps waiting on me behind somebody else. The
    // "list of approvals that will be processed" — upcoming, not yet
    // actionable, so shown apart from the queue.
    const { data: ahead } = await db
      .from("approval_requests")
      .select("id, submission_id, subject_id, subject_type, step_index, deadline_at")
      .in("approver_user_id", approverIds)
      .eq("status", "waiting")
      .order("deadline_at");
    const aheadSubs = Array.from(new Set((ahead ?? []).map((a) => a.submission_id).filter(Boolean) as string[]));
    const aheadInfo: Record<string, { ref: string | null; form: string | null }> = {};
    if (aheadSubs.length) {
      const { data: s2 } = await db.from("form_submissions").select("id, ref_number, form_template_id").in("id", aheadSubs);
      const tpl = Array.from(new Set((s2 ?? []).map((x) => x.form_template_id as string)));
      const { data: t2 } = tpl.length ? await db.from("form_templates").select("id, name").in("id", tpl) : { data: [] };
      (s2 ?? []).forEach((x) => {
        aheadInfo[x.id] = { ref: x.ref_number, form: (t2 ?? []).find((t) => t.id === x.form_template_id)?.name ?? null };
      });
    }
    // Notices, stationery, maintenance and movement orders coming my way
    // are named the way the queue names them; it only looked up its own.
    const aheadOf = (t: string) => Array.from(new Set((ahead ?? [])
      .filter((a) => a.subject_type === t && !a.submission_id && a.subject_id && !subjectLabels[a.subject_id as string])
      .map((a) => a.subject_id as string)));
    const [aNotices, aStationery, aMaintenance, aMoves] = await Promise.all([
      aheadOf("notice").length ? db.from("notices").select("id, title").in("id", aheadOf("notice")) : Promise.resolve({ data: [] }),
      aheadOf("stationery_request").length ? db.from("stationery_requests").select("id, kind, name").in("id", aheadOf("stationery_request")) : Promise.resolve({ data: [] }),
      aheadOf("maintenance_request").length ? db.from("maintenance_requests").select("id, ref_number, location").in("id", aheadOf("maintenance_request")) : Promise.resolve({ data: [] }),
      aheadOf("movement_order").length ? db.from("movement_orders").select("id, ref_number, item_name").in("id", aheadOf("movement_order")) : Promise.resolve({ data: [] }),
    ]);
    ((aNotices.data ?? []) as { id: string; title: string | null }[]).forEach((n) => { subjectLabels[n.id] = `Notice · ${n.title ?? "untitled"}`; });
    ((aStationery.data ?? []) as { id: string; kind: string | null; name: string | null }[]).forEach((r) => {
      const kind = r.kind === "business_card" ? "Business card" : r.kind === "stamp_seal" ? "Stamp and seal" : "Stationery";
      subjectLabels[r.id] = r.name ? `${kind} · ${r.name}` : kind;
    });
    ((aMaintenance.data ?? []) as { id: string; ref_number: string | null; location: string | null }[]).forEach((m) => {
      subjectLabels[m.id] = `Maintenance · ${[m.ref_number, m.location].filter(Boolean).join(" — ") || "request"}`;
    });
    ((aMoves.data ?? []) as { id: string; ref_number: string | null; item_name: string | null }[]).forEach((m) => {
      subjectLabels[m.id] = `Movement order · ${[m.ref_number, m.item_name].filter(Boolean).join(" — ") || "order"}`;
    });
    const PAGE: Record<string, string> = { movement_order: "/movement-orders" };
    setUpcoming((ahead ?? []).map((a) => ({
      id: a.id as string,
      submissionId: a.submission_id as string | null,
      label: a.submission_id
        ? `${aheadInfo[a.submission_id]?.form ?? "Request"} · ${aheadInfo[a.submission_id]?.ref ?? ""}`
        : subjectLabels[a.subject_id as string] ?? "Request",
      href: a.submission_id ? null
        : a.subject_type === "notice" && a.subject_id ? `/notices/${a.subject_id}`
        : PAGE[a.subject_type as string] ?? null,
    })));
    setLoading(false);
  }, [currentUser.employee_id]);

  useEffect(() => {
    load();
  }, [load]);

  // Everyone who could be forwarded to or added as a reviewer.
  useEffect(() => {
    (async () => {
      const { data } = await db
        .from("employees")
        .select("employee_id, name, designation")
        .order("name");
      setPeople((data ?? []) as { employee_id: string; name: string; designation: string | null }[]);
    })();
  }, []);

  const toggleExpand = async (row: Row) => {
    if (expanded === row.id) {
      setExpanded(null);
      return;
    }
    setExpanded(row.id);
    if (row.submission_id && !values[row.submission_id]) {
      const subId = row.submission_id;
      const [{ data }, files] = await Promise.all([
        db.from("submission_values").select("field_name, value").eq("submission_id", subId),
        listAttachments({ data: { submissionId: subId } }).catch(() => [] as AttachmentInfo[]),
      ]);
      setAttachments((a) => ({ ...a, [subId]: files }));
      setValues((v) => ({ ...v, [subId]: (data || []) as SubVal[] }));
    }
  };

  // Open the request the notification named, once, after the rows land.
  // Only once, or reopening it after somebody closed it would fight them.
  useEffect(() => {
    if (!focus || focused || rows.length === 0) return;
    const row = rows.find((r) => r.subject_id === focus || r.id === focus);
    setFocused(true);
    if (!row) {
      // It was theirs a moment ago and is not now — forwarded, withdrawn,
      // or already dealt with from another screen.
      toast.info("That request is no longer waiting on you.");
      return;
    }
    void toggleExpand(row);
    requestAnimationFrame(() => {
      document
        .getElementById(`approval-${row.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focus, focused, rows, toggleExpand]);

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
    signature?: string | null,
  ): Promise<boolean> => {
    const { error } = await db.rpc("act_on_approval", {
      p_request_id: row.id,
      p_action: action,
      p_comment: note?.trim() || null,
      // Acting for a delegator is still acting as yourself: the database
      // checks that this person holds a delegation covering the step.
      p_actor: currentUser.employee_id,
      p_signature: signature ?? null,
    });
    if (error) {
      toast.error(error.message.charAt(0).toUpperCase() + error.message.slice(1));
      // An unticked checklist: open the row, where the checklist is.
      if (/checklist/i.test(error.message) && expanded !== row.id) void toggleExpand(row);
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

  const handleApprove = async (row: Row, signed?: string | null) => {
    // A checklist still open is refused anyway; say so before asking for a
    // signature, not after it has been drawn.
    if (row.submission_id && !signed) {
      const { data } = await db.rpc("checklist_for", { p_submission: row.submission_id });
      const open = ((data ?? []) as { can_tick: boolean; state: string; items: { done: boolean }[] }[])
        .filter((t) => t.can_tick && t.state === "open")
        .reduce((n, t) => n + t.items.filter((i) => !i.done).length, 0);
      if (open > 0) {
        // The server's own words, and the row opened on the checklist, as a
        // refusal from the server would do.
        toast.error(`Tick the checklist first: ${open} item${open === 1 ? " is" : "s are"} still open`);
        if (expanded !== row.id) void toggleExpand(row);
        return;
      }
    }
    if (row.require_signature && !signed) {
      setSignature(null);
      setSigning(row);
      return;
    }
    if (!(await act(row, "approve", undefined, signed))) return;
    toast.success("Approved — it has moved to the next approver");
    setSigning(null);
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
      toast.error("Choose somebody first");
      return;
    }
    // The trail and the confirmation should name the person, not the id
    // the dropdown happens to carry.
    const toName = people.find((e) => e.employee_id === to)?.name ?? to;
    setSubmitting(true);
    const { error } = modal.kind === "forward"
      ? await db.rpc("reassign_approval", {
          p_request_id: modal.row.id, p_to: to, p_comment: comment.trim() || null,
          p_actor: currentUser.employee_id,
        })
      : await db.rpc("add_reviewer", {
          p_request_id: modal.row.id, p_employee: to, p_deadline_days: 7,
          p_actor: currentUser.employee_id,
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
      detail: (modal.kind === "forward" ? "Forwarded to " : "Added " + toName + " as a reviewer on ")
        + (modal.kind === "forward" ? toName + " — " + (modal.row.subjectLabel ?? "a request")
                                    : (modal.row.subjectLabel ?? "a request")),
    });

    toast.success(modal.kind === "forward"
      ? "Forwarded — it is with " + toName + " now"
      : toName + " will review it first; it comes back to you after");
    // Both hand the step on for now: forwarding for good, a review until
    // the reviewer has passed it back.
    fadeAndRemove(modal.row.id);
    setModal(null);
    setComment("");
    setPersonId("");
    setSubmitting(false);
  };

  // Return and Ask both choose from the request's own chain.
  const openChainDialog = async (kind: "return" | "ask", row: Row) => {
    setComment("");
    setPersonId("");
    setChainRows([]);
    setModal({ kind, row });
    const { data } = await db
      .from("approval_requests")
      .select("id, approver_user_id, status, step_index, lane, lane_step")
      .eq("subject_id", row.subject_id ?? "")
      .order("step_index")
      .order("lane")
      .order("lane_step");
    setChainRows((data ?? []) as typeof chainRows);
  };

  const nameFor = (id: string | null | undefined) =>
    (id && people.find((p) => p.employee_id === id)?.name) || id || "Somebody";

  const submitChainDialog = async () => {
    if (!modal) return;
    if (!personId) {
      toast.error(modal.kind === "return" ? "Choose who to return it to" : "Choose who to ask");
      return;
    }
    if (!comment.trim()) {
      toast.error(modal.kind === "return" ? "Say what needs another look" : "Write the question");
      return;
    }
    setSubmitting(true);
    const { error } = modal.kind === "return"
      ? await returnToApprover(modal.row.id, personId, currentUser.employee_id, comment)
      : await askQuestion(modal.row.subject_id ?? "", personId, comment, currentUser.employee_id);
    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (modal.kind === "return") {
      const target = chainRows.find((c) => c.id === personId);
      toast.success("Returned to " + nameFor(target?.approver_user_id) + " — it comes back to you after");
      fadeAndRemove(modal.row.id);
    } else {
      toast.success("Asked " + nameFor(personId) + " — the answer will appear on the request");
    }
    setModal(null);
    setComment("");
    setPersonId("");
  };

  const answerMine = async (id: string) => {
    const text = (qAnswers[id] ?? "").trim();
    if (!text) {
      toast.error("Write an answer first");
      return;
    }
    const { error } = await answerQuestion(id, text, currentUser.employee_id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Answered");
    setMyQuestions((qs) => qs.filter((q) => q.id !== id));
  };

  const submitModal = async () => {
    if (!modal) return;
    if (modal.kind === "forward" || modal.kind === "reviewer") return submitPerson();
    if (modal.kind === "return" || modal.kind === "ask") return submitChainDialog();
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

      <AdminQueue employeeId={currentUser.employee_id} onCount={setAdminCount} />

      {myQuestions.length > 0 && (
        <div className="rounded-xl bg-white mb-5" style={{ border: "1px solid #C7D2FE", padding: "14px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#3730A3", marginBottom: 10 }}>
            Questions for you from other approvers
          </div>
          <div className="flex flex-col gap-3">
            {myQuestions.map((q) => (
              <div key={q.id} className="rounded-lg" style={{ padding: "10px 12px", background: "#F8FAFF", border: "1px solid #E0E7FF" }}>
                <div style={{ fontSize: 12, color: "#6366F1" }}>
                  {nameFor(q.asked_by)} asked about{" "}
                  {q.subject_type === "form_submission" ? (
                    <Link to="/status/$submissionId" params={{ submissionId: q.subject_id }} style={{ color: "#4338CA", textDecoration: "underline" }}>
                      {questionRefs[q.subject_id] || `AMS-${q.subject_id.slice(0, 8).toUpperCase()}`}
                    </Link>
                  ) : (
                    <span>AMS-{q.subject_id.slice(0, 8).toUpperCase()}</span>
                  )}
                </div>
                <div style={{ fontSize: 13.5, color: "#18181B", margin: "4px 0 8px" }}>{q.question}</div>
                <div className="flex gap-2">
                  <input
                    value={qAnswers[q.id] ?? ""}
                    onChange={(e) => setQAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                    placeholder="Your answer"
                    className="flex-1 rounded-md"
                    style={{ padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", background: "#fff" }}
                  />
                  <button
                    onClick={() => answerMine(q.id)}
                    className="rounded-md text-white font-medium"
                    style={{ padding: "7px 12px", fontSize: 13, background: "#4F46E5" }}
                  >
                    Answer
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : rows.length === 0 ? (
        adminCount > 0 ? null : <EmptyState />
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
                id={`approval-${r.id}`}
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
                        {r.subjectRef && (
                          <span
                            className="font-mono"
                            style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 500, color: "#71717A", whiteSpace: "nowrap", display: "inline-block" }}
                          >
                            {r.subjectRef}
                          </span>
                        )}
                        {r.flag && (
                          <span className="rounded-full" style={{ marginLeft: 8, padding: "1px 8px", fontSize: 11, fontWeight: 600, background: "#FDF2F8", color: "#BE185D", border: "1px solid #FBCFE8" }}>
                            {r.flag}
                          </span>
                        )}
                        {r.priority && r.priority !== "normal" && (
                          <span className="rounded-full" style={{ marginLeft: 6, padding: "1px 8px", fontSize: 11, fontWeight: 600,
                            background: r.priority === "urgent" ? "#FEF2F2" : "#FFFBEB",
                            color: r.priority === "urgent" ? "#B91C1C" : "#B45309",
                            border: `1px solid ${r.priority === "urgent" ? "#FECACA" : "#FDE68A"}` }}>
                            {r.priority === "urgent" ? "Urgent" : "High"}
                          </span>
                        )}
                        {r.require_signature && (
                          <span className="rounded-full" style={{ marginLeft: 6, padding: "1px 8px", fontSize: 11, fontWeight: 500, background: "#F4F4F5", color: "#52525B", border: "1px solid #E4E4E7" }}>
                            Signature required
                          </span>
                        )}
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
                    <div className="row-actions flex items-center gap-2 flex-wrap md:flex-nowrap md:shrink-0 w-full md:w-auto" onClick={(e) => e.stopPropagation()}>
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
                          setForwardOnly(null);
                          setModal({ kind: "forward", row: r });
                          void db.rpc("forward_candidates", { p_request: r.id }).then(({ data }) => {
                            const c = data as { restricted?: boolean; ids?: string[] } | null;
                            setForwardOnly(c?.restricted ? c.ids ?? [] : null);
                          });
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
                      <button
                        onClick={() => openChainDialog("return", r)}
                        className="rounded-md font-medium bg-white"
                        style={{
                          padding: "7px 12px",
                          fontSize: 13,
                          color: "#52525B",
                          border: "1px solid #E4E4E7",
                        }}
                      >
                        Return
                      </button>
                      <button
                        onClick={() => openChainDialog("ask", r)}
                        className="rounded-md font-medium bg-white"
                        style={{
                          padding: "7px 12px",
                          fontSize: 13,
                          color: "#52525B",
                          border: "1px solid #E4E4E7",
                        }}
                      >
                        Ask
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
                                {(() => {
                                  // A file question answers with the file,
                                  // not just the name it was uploaded as.
                                  const file = r.submission_id
                                    ? attachments[r.submission_id]?.find((a) => a.field_name === v.field_name)
                                    : undefined;
                                  return file ? <AttachmentLink file={file} /> : formatValue(v.value);
                                })()}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {r.submission_id && (
                      <ClearanceChecklist submissionId={r.submission_id} onlyMine
                        style={{ padding: "12px 18px 0", borderTop: "1px solid #F0F0F0" }} />
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

      {upcoming.length > 0 && (
        <div className="rounded-xl bg-white mt-8" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>Coming your way</div>
          <div style={{ fontSize: 12, color: "#71717A", margin: "2px 0 10px" }}>
            Requests that will reach you once the approvers before you have acted.
          </div>
          <div className="flex flex-col gap-1.5">
            {upcoming.map((u) =>
              u.submissionId ? (
                <Link key={u.id} to="/status/$submissionId" params={{ submissionId: u.submissionId }} style={{ fontSize: 13, color: "#4338CA" }}>
                  {u.label}
                </Link>
              ) : u.href ? (
                <a key={u.id} href={u.href} style={{ fontSize: 13, color: "#4338CA" }}>{u.label}</a>
              ) : (
                <span key={u.id} style={{ fontSize: 13, color: "#3F3F46" }}>{u.label}</span>
              ),
            )}
          </div>
        </div>
      )}

      <Dialog open={!!signing} onOpenChange={(o) => !o && setSigning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>This step needs your signature</DialogTitle>
          </DialogHeader>
          <SignaturePad onChange={setSignature} />
          <DialogFooter>
            <button
              onClick={() => setSigning(null)}
              className="rounded-md font-medium bg-white"
              style={{ padding: "7px 12px", fontSize: 13, color: "#52525B", border: "1px solid #E4E4E7" }}
            >
              Cancel
            </button>
            <button
              onClick={() => signing && handleApprove(signing, signature)}
              disabled={!signature}
              className="rounded-md text-white font-medium"
              style={{ padding: "7px 14px", fontSize: 13, background: "#4F46E5", opacity: signature ? 1 : 0.5 }}
            >
              Sign and approve
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {modal?.kind === "reject" ? "Reason for rejection"
                : modal?.kind === "clarify" ? "What clarification is needed?"
                : modal?.kind === "forward" ? "Forward this step to somebody else"
                : modal?.kind === "return" ? "Return it to an earlier approver"
                : modal?.kind === "ask" ? "Ask another approver a question"
                : "Ask somebody to review it before you decide"}
            </DialogTitle>
          </DialogHeader>
          {(modal?.kind === "forward" || modal?.kind === "reviewer") && (
            <label className="flex flex-col gap-1">
              <span style={{ fontSize: 11.5, color: "#71717A" }}>
                {modal?.kind === "forward" ? "Forward to" : "Reviewer"}
              </span>
              <select
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
                className="rounded-md bg-white"
                style={{ padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7" }}
              >
                <option value="">Choose somebody…</option>
                {people
                  // Sending it to whoever already holds it does nothing.
                  .filter((e) => e.employee_id !== modal?.row.approver_user_id)
                  .filter((e) => modal?.kind !== "forward" || !forwardOnly || forwardOnly.includes(e.employee_id))
                  .map((e) => (
                    <option key={e.employee_id} value={e.employee_id}>
                      {e.name}
                      {e.designation ? ` — ${e.designation}` : ""}
                    </option>
                  ))}
              </select>
              <span style={{ fontSize: 11.5, color: "#A1A1AA" }}>
                {modal?.kind === "forward"
                  ? forwardOnly
                    ? "This form forwards only within the reporting line: the people above and below whoever holds the step."
                    : "The step keeps its place in the chain; only who answers it changes."
                  : "They are asked first. It comes back to you once they have reviewed it."}
              </span>
            </label>
          )}
          {modal?.kind === "return" && (
            <label className="flex flex-col gap-1">
              <span style={{ fontSize: 11.5, color: "#71717A" }}>Return to</span>
              <select
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
                className="rounded-md bg-white"
                style={{ padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7" }}
              >
                <option value="">Choose somebody who already approved it…</option>
                {chainRows
                  .filter((c) => c.status === "approved")
                  .map((c) => (
                    <option key={c.id} value={c.id}>{nameFor(c.approver_user_id)}</option>
                  ))}
              </select>
              <span style={{ fontSize: 11.5, color: "#A1A1AA" }}>
                {chainRows.some((c) => c.status === "approved")
                  ? "It goes back to them, and everyone after them approves it again in order — you included."
                  : "Nobody has approved this yet, so there is nobody to return it to."}
              </span>
            </label>
          )}
          {modal?.kind === "ask" && (
            <label className="flex flex-col gap-1">
              <span style={{ fontSize: 11.5, color: "#71717A" }}>Ask</span>
              <select
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
                className="rounded-md bg-white"
                style={{ padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7" }}
              >
                <option value="">Choose an approver on this request…</option>
                {Array.from(new Set(chainRows.map((c) => c.approver_user_id).filter(Boolean) as string[]))
                  .filter((id) => id !== currentUser.employee_id)
                  .map((id) => (
                    <option key={id} value={id}>{nameFor(id)}</option>
                  ))}
              </select>
              <span style={{ fontSize: 11.5, color: "#A1A1AA" }}>
                The request does not wait: it is a question beside it. To ask the requester, use Clarify.
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
                : modal?.kind === "return" ? "What needs another look?"
                : modal?.kind === "ask" ? "Your question"
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
