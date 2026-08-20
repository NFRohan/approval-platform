// src/routes/maintenance.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { actOnSubject, startChain, type Step } from "@/lib/chain";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

export const Route = createFileRoute("/maintenance")({
  head: () => ({ meta: [{ title: "Maintenance · Admin Services Portal" }] }),
  component: MaintenancePage,
});

const ADMIN_ID = "EMP-0445";
const CATEGORIES = ["AC", "Water Purifier", "Generator", "General", "Others"] as const;

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  raised:      { label: "Raised",      color: "#1D4ED8", bg: "#EFF6FF" },
  approved:    { label: "Approved",    color: "#166534", bg: "#DCFCE7" },
  in_progress: { label: "In Progress", color: "#92400E", bg: "#FEF3C7" },
  on_hold:     { label: "On Hold",     color: "#6B7280", bg: "#F3F4F6" },
  completed:   { label: "Completed",   color: "#166534", bg: "#DCFCE7" },
  rejected:    { label: "Rejected",    color: "#B91C1C", bg: "#FEF2F2" },
};

type Item = { id: string; name: string; category: string };
type ReqItem = { id: string; item_id: string | null; description: string | null; quantity: number; itemName?: string };
type Req = {
  id: string; ref_number: string; requester_id: string; location: string; status: string;
  assigned_to: string | null; admin_comment: string | null; created_at: string;
  requesterName?: string; items?: ReqItem[];
  // The step this request is waiting on, if any. Who may act is decided
  // by owning that step, not by being one hardcoded administrator.
  step?: Step | null;
  tierLabel?: string;
};

// Divisional, then moderator, then admin — three tiers, each acting in
// turn. The names come from the rules rather than being written here, so
// changing the chain changes what the screen says.
const TIER_NAMES: Record<string, string> = {
  divisional: "Divisional review",
  moderator: "Moderator review",
  admin: "Admin review",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7",
  borderRadius: 6, background: "#fff", color: "#18181B", boxSizing: "border-box", fontFamily: "inherit",
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, color: "#52525B", bg: "#F4F4F5" };
  return <span style={{ padding: "3px 10px", fontSize: 11.5, borderRadius: 9999, color: s.color, background: s.bg, fontWeight: 500 }}>{s.label}</span>;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function NewRequestForm({ items, onCancel, onSaved }: { items: Item[]; onCancel: () => void; onSaved: () => void }) {
  const { currentUser } = useCurrentUser();
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("AC");
  const [lines, setLines] = useState<{ itemId: string; quantity: string }[]>([{ itemId: "", quantity: "1" }]);
  const [saving, setSaving] = useState(false);

  function addLine() { setLines((prev) => [...prev, { itemId: "", quantity: "1" }]); }
  function removeLine(i: number) { setLines((prev) => prev.filter((_, idx) => idx !== i)); }
  function updateLine(i: number, patch: Partial<{ itemId: string; quantity: string }>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function handleSubmit() {
    if (!location.trim()) { toast.error("Location is required"); return; }
    const validLines = lines.filter((l) => l.itemId);
    if (validLines.length === 0) { toast.error("Add at least one item"); return; }
    setSaving(true);
    const ref = "MR-" + Date.now().toString(36).toUpperCase();
    const { data: req, error } = await db.from("maintenance_requests").insert({
      ref_number: ref, requester_id: currentUser.employee_id, location: location.trim(), status: "raised",
    }).select("id").single();
    if (error || !req) { toast.error("Failed to submit: " + (error?.message ?? "unknown")); setSaving(false); return; }
    await db.from("maintenance_request_items").insert(
      validLines.map((l) => ({ request_id: req.id, item_id: l.itemId, quantity: parseInt(l.quantity, 10) || 1 })),
    );
    const { error: chainErr } = await startChain("maintenance_request", req.id);
    if (chainErr) toast.error("Raised, but approvals were not set up: " + chainErr.message);

    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id, action: "created", entity_type: "maintenance_request", entity_id: req.id,
      detail: `Raised maintenance request ${ref}`,
    });
    setSaving(false);
    toast.success(`Maintenance request ${ref} submitted`);
    onSaved();
  }

  const categoryItems = items.filter((i) => i.category === category);

  return (
    <div className="max-w-2xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <button onClick={onCancel} style={{ fontSize: 12.5, color: "#71717A", background: "none", border: "none", cursor: "pointer", marginBottom: 12 }}>← Back to Maintenance</button>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#18181B", margin: "0 0 20px" }}>New Maintenance Request</h1>
      <div className="flex flex-col gap-4 rounded-xl bg-white" style={{ padding: 20, border: "1px solid #E4E4E7" }}>
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Location</span>
          <input style={inputStyle} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. 4th Floor, Product & Technology Wing" />
        </label>
        <div className="flex gap-1 flex-wrap">
          {CATEGORIES.map((c) => (
            <button key={c} onClick={() => setCategory(c)} style={{ padding: "5px 12px", fontSize: 12, borderRadius: 9999, border: `1px solid ${category === c ? "#18181B" : "#E4E4E7"}`, background: category === c ? "#F4F4F5" : "#fff", cursor: "pointer" }}>
              {c}
            </button>
          ))}
        </div>
        {lines.map((line, i) => (
          <div key={i} className="flex gap-2 items-end">
            <label className="flex flex-col gap-1" style={{ flex: 1 }}>
              <span style={{ fontSize: 11.5, color: "#71717A" }}>Item</span>
              <select style={inputStyle} value={line.itemId} onChange={(e) => updateLine(i, { itemId: e.target.value })}>
                <option value="">Select item…</option>
                {categoryItems.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1" style={{ width: 90 }}>
              <span style={{ fontSize: 11.5, color: "#71717A" }}>Qty</span>
              <input type="number" min={1} style={inputStyle} value={line.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} />
            </label>
            {lines.length > 1 && (
              <button onClick={() => removeLine(i)} style={{ padding: 8, background: "none", border: "none", color: "#B91C1C", cursor: "pointer" }}><Trash2 size={14} /></button>
            )}
          </div>
        ))}
        <button onClick={addLine} className="inline-flex items-center gap-1.5" style={{ fontSize: 12.5, color: "#4F46E5", background: "none", border: "none", cursor: "pointer", alignSelf: "flex-start" }}>
          <Plus size={13} /> Add another item
        </button>
        <button onClick={handleSubmit} disabled={saving} className="rounded-md text-white font-medium" style={{ padding: "9px 16px", fontSize: 13.5, background: "var(--color-brand-500)", border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, alignSelf: "flex-start" }}>
          {saving ? "Submitting…" : "Submit Request"}
        </button>
      </div>
    </div>
  );
}

function RequestCard({ req, isAdmin, expanded, onToggle, onRefresh }: { req: Req; isAdmin: boolean; expanded: boolean; onToggle: () => void; onRefresh: () => void }) {
  const { currentUser } = useCurrentUser();
  const [comment, setComment] = useState("");
  const [assignedTo, setAssignedTo] = useState(req.assigned_to ?? "");
  const [actioning, setActioning] = useState(false);

  // Approving is not setting a status. It is acting on this tier's step,
  // which may hand the request to the next tier rather than finishing
  // it — so the chain decides what the request becomes.
  async function chainAct(action: "approve" | "reject" | "clarification") {
    setActioning(true);
    if (action === "approve" && (assignedTo.trim() || comment.trim())) {
      await db.from("maintenance_requests")
        .update({ assigned_to: assignedTo.trim() || null, admin_comment: comment.trim() || null })
        .eq("id", req.id);
    }
    const { error } = await actOnSubject("maintenance_request", req.id, action, comment);
    setActioning(false);
    if (error) { toast.error(error.message); return; }

    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: action === "approve" ? "approved" : action === "reject" ? "rejected" : "on_hold",
      entity_type: "maintenance_request", entity_id: req.id,
      detail: (action === "approve" ? "Approved " : action === "reject" ? "Rejected " : "Held ") + req.ref_number,
    });
    toast.success(
      action === "approve" ? "Approved — passed to the next tier if there is one"
      : action === "reject" ? "Rejected — the tiers above were not asked"
      : "Held pending clarification",
    );
    onRefresh();
  }

  // What happens after the chain has finished: the work itself.
  async function setFulfilment(status: string) {
    setActioning(true);
    const { error } = await db.from("maintenance_requests").update({ status }).eq("id", req.id);
    setActioning(false);
    if (error) { toast.error("Update failed: " + error.message); return; }
    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id, action: "status_changed",
      entity_type: "maintenance_request", entity_id: req.id,
      detail: `Set ${req.ref_number} to ${status}`,
    });
    toast.success(`Request marked ${status.replace("_", " ")}`);
    onRefresh();
  }

  // Whoever owns the open step may act, whichever tier they are.
  const myStep = req.step && req.step.approver_user_id === currentUser.employee_id ? req.step : null;

  return (
    <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7" }}>
      <button className="w-full text-left" onClick={onToggle} style={{ padding: "14px 18px", display: "block" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1"><Wrench size={13} style={{ color: "#A1A1AA" }} /><span style={{ fontWeight: 600, fontSize: 14.5, color: "#18181B" }}>{req.location}</span><StatusPill status={req.status} /></div>
            {req.tierLabel && (
              <div style={{ fontSize: 11.5, color: "#71717A", marginTop: 2 }}>
                {req.tierLabel}
                {req.step?.approver_user_id ? ` · with ${req.step.approver_user_id}` : ""}
              </div>
            )}
            <div style={{ fontSize: 12, color: "#A1A1AA" }}>Ref: <span className="font-mono">{req.ref_number}</span> · {isAdmin ? `${req.requesterName ?? req.requester_id} · ` : ""}{fmt(req.created_at)}</div>
          </div>
          <span style={{ color: "#A1A1AA" }}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: "1px solid #F4F4F5", background: "#FAFAFA", padding: "14px 18px" }}>
          <div style={{ fontSize: 11, color: "#A1A1AA", marginBottom: 6 }}>ITEMS</div>
          <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 13, color: "#3F3F46" }}>
            {(req.items ?? []).map((it) => <li key={it.id}>{it.itemName ?? it.description ?? "Item"} × {it.quantity}</li>)}
          </ul>
          {req.admin_comment && (
            <div className="rounded-md mb-3" style={{ padding: "8px 12px", background: "#FFF8F0", border: "1px solid #FED7AA", fontSize: 13, color: "#7C2D12" }}>{req.admin_comment}</div>
          )}
          {myStep && (
            <div className="flex flex-col gap-2 pt-2" style={{ borderTop: "1px solid #F0F0F0" }}>
              <div className="flex gap-2">
                <input style={{ ...inputStyle, fontSize: 12 }} placeholder="Assign vendor/technician" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} />
                <input style={{ ...inputStyle, fontSize: 12 }} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <button disabled={actioning} onClick={() => chainAct("approve")} className="rounded-md text-white font-medium" style={{ padding: "6px 12px", fontSize: 12.5, background: "#4F46E5", border: "none", cursor: "pointer" }}>Approve</button>
                <button disabled={actioning} onClick={() => chainAct("reject")} className="rounded-md font-medium bg-white" style={{ padding: "6px 12px", fontSize: 12.5, color: "#B91C1C", border: "1px solid #FECACA", cursor: "pointer" }}>Reject</button>
                <button disabled={actioning} onClick={() => chainAct("clarification")} className="rounded-md font-medium bg-white" style={{ padding: "6px 12px", fontSize: 12.5, color: "#52525B", border: "1px solid #E4E4E7", cursor: "pointer" }}>Hold</button>
              </div>
            </div>
          )}
          {isAdmin && req.status === "approved" && (
            <button disabled={actioning} onClick={() => setFulfilment("in_progress")} className="rounded-md font-medium" style={{ padding: "6px 14px", fontSize: 12.5, background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", cursor: "pointer" }}>Mark In Progress</button>
          )}
          {isAdmin && req.status === "in_progress" && (
            <button disabled={actioning} onClick={() => setFulfilment("completed")} className="rounded-md text-white font-medium" style={{ padding: "6px 14px", fontSize: 12.5, background: "#16A34A", border: "none", cursor: "pointer" }}>Mark Completed</button>
          )}
        </div>
      )}
    </div>
  );
}

function MaintenancePage() {
  const { currentUser } = useCurrentUser();
  const isAdmin = currentUser.employee_id === ADMIN_ID;
  const [view, setView] = useState<"list" | "new">("list");
  const [items, setItems] = useState<Item[]>([]);
  const [requests, setRequests] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // The open steps come first, because who may act and who may even
    // see a request both depend on them.
    const [{ data: itemsData }, { data: openSteps }, { data: tierRules }] = await Promise.all([
      db.from("maintenance_items").select("*").order("category"),
      db.from("approval_requests")
        .select("id, maintenance_request_id, approver_user_id, step_index, status")
        .eq("subject_type", "maintenance_request")
        .in("status", ["pending", "clarification"]),
      db.from("approval_rules")
        .select("label, step_index")
        .eq("subject_type", "maintenance_request")
        .order("step_index"),
    ]);
    setItems((itemsData ?? []) as Item[]);

    const stepFor: Record<string, Step> = {};
    (openSteps ?? []).forEach((st: Step & { maintenance_request_id: string | null }) => {
      if (st.maintenance_request_id) stepFor[st.maintenance_request_id] = st;
    });
    const tierName = (i: number | null | undefined) => {
      const rule = (tierRules ?? []).find((t: { step_index: number }) => t.step_index === i);
      return rule?.label ? (TIER_NAMES[rule.label] ?? rule.label) : undefined;
    };

    const { data: reqData } = await (isAdmin
      ? db.from("maintenance_requests").select("*")
      : db.from("maintenance_requests").select("*").eq("requester_id", currentUser.employee_id)
    ).order("created_at", { ascending: false });
    let reqRows = (reqData ?? []) as Req[];

    // An approver has to see what they must approve, even when somebody
    // else raised it. Being the administrator decides who sees
    // everything; owning the open step decides who sees this one.
    if (!isAdmin) {
      const missing = Object.entries(stepFor)
        .filter(([, st]) => st.approver_user_id === currentUser.employee_id)
        .map(([id]) => id)
        .filter((id) => !reqRows.some((r) => r.id === id));
      if (missing.length) {
        const { data: extra } = await db.from("maintenance_requests").select("*").in("id", missing);
        reqRows = [...reqRows, ...((extra ?? []) as Req[])]
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      }
    }

    const reqIds = reqRows.map((r) => r.id);
    const requesterIds = Array.from(new Set(reqRows.map((r) => r.requester_id)));
    const [{ data: lineItems }, { data: emps }] = await Promise.all([
      reqIds.length ? db.from("maintenance_request_items").select("*").in("request_id", reqIds) : Promise.resolve({ data: [] as ReqItem[] & { request_id: string }[] }),
      requesterIds.length ? db.from("employees").select("employee_id, name").in("employee_id", requesterIds) : Promise.resolve({ data: [] }),
    ]);
    const empMap: Record<string, string> = {};
    (emps ?? []).forEach((e: { employee_id: string; name: string }) => { empMap[e.employee_id] = e.name; });
    const itemMap: Record<string, string> = {};
    (itemsData ?? []).forEach((it) => { itemMap[it.id] = it.name; });
    reqRows.forEach((r) => {
      r.step = stepFor[r.id] ?? null;
      r.tierLabel = r.step ? tierName(r.step.step_index) : undefined;
      r.requesterName = empMap[r.requester_id];
      r.items = ((lineItems ?? []) as (ReqItem & { request_id: string })[])
        .filter((li) => li.request_id === r.id)
        .map((li) => ({ ...li, itemName: li.item_id ? itemMap[li.item_id] : undefined }));
    });
    setRequests(reqRows);
    setLoading(false);
  }, [currentUser.employee_id, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const visible = filterStatus === "all" ? requests : requests.filter((r) => r.status === filterStatus);

  if (view === "new") {
    return <NewRequestForm items={items} onCancel={() => setView("list")} onSaved={() => { setView("list"); load(); }} />;
  }

  return (
    <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }}>Maintenance</h1>
          <p style={{ marginTop: 5, fontSize: 13.5, color: "#71717A" }}>
            {isAdmin ? "Review and process maintenance requests." : "Request and track facility maintenance."}
          </p>
        </div>
        {!isAdmin && (
          <button onClick={() => setView("new")} className="inline-flex items-center gap-1.5 rounded-lg" style={{ padding: "9px 16px", fontSize: 13, fontWeight: 500, background: "var(--color-brand-500)", color: "#fff", border: "none", cursor: "pointer" }}>
            <Plus size={14} /> New Request
          </button>
        )}
      </div>

      <div className="flex gap-1 flex-wrap mb-5">
        {["all", "raised", "approved", "in_progress", "on_hold", "completed", "rejected"].map((s) => (
          <button key={s} onClick={() => setFilterStatus(s)} style={{ padding: "5px 12px", fontSize: 12, borderRadius: 9999, border: `1px solid ${filterStatus === s ? "#18181B" : "#E4E4E7"}`, background: filterStatus === s ? "#F4F4F5" : "#fff", cursor: "pointer", textTransform: "capitalize" }}>
            {s === "all" ? "All" : s.replace("_", " ")}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2" style={{ fontSize: 13, color: "#A1A1AA" }}><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl text-center" style={{ padding: "64px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>No requests found.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((r) => (
            <RequestCard key={r.id} req={r} isAdmin={isAdmin} expanded={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} onRefresh={load} />
          ))}
        </div>
      )}
    </div>
  );
}
