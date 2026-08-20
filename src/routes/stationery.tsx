// src/routes/stationery.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CreditCard, Stamp } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { actOnSubject, openStep, startChain } from "@/lib/chain";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

export const Route = createFileRoute("/stationery")({
  head: () => ({ meta: [{ title: "Stationery Requests · Admin Services Portal" }] }),
  component: StationeryPage,
});

type Kind = "business_card" | "stamp_seal";
type Req = {
  id: string; kind: Kind; requester_id: string | null; name: string | null; designation: string | null;
  department: string | null; division: string | null; email: string | null; contact_number: string | null;
  reason: string | null; comments: string | null; status: string; current_approver_id: string | null; created_at: string;
};


const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  open:      { label: "Open",      color: "#1D4ED8", bg: "#EFF6FF" },
  approved:  { label: "Approved",  color: "#166534", bg: "#DCFCE7" },
  fulfilled: { label: "Fulfilled", color: "#166534", bg: "#DCFCE7" },
  rejected:  { label: "Rejected",  color: "#B91C1C", bg: "#FEF2F2" },
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7",
  borderRadius: 6, background: "#fff", color: "#18181B", boxSizing: "border-box", fontFamily: "inherit",
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, color: "#52525B", bg: "#F4F4F5" };
  return <span style={{ padding: "3px 10px", fontSize: 11.5, borderRadius: 9999, color: s.color, background: s.bg, fontWeight: 500 }}>{s.label}</span>;
}

function BusinessCardPreview({ name, designation, department, email, contactNumber }: { name: string; designation: string; department: string; email: string; contactNumber: string }) {
  return (
    <div style={{ width: 320, height: 180, borderRadius: 12, background: "linear-gradient(135deg, #4F46E5, #9D174D)", color: "#fff", padding: 20, boxShadow: "0 8px 24px rgba(226,19,110,0.25)", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em" }}>ASP</div>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{name || "Your Name"}</div>
        <div style={{ fontSize: 12.5, opacity: 0.9, marginTop: 2 }}>{designation || "Designation"}</div>
        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>{department || "Department"}</div>
      </div>
      <div style={{ fontSize: 10.5, opacity: 0.85 }}>
        {email || "you@example.com"} · {contactNumber || "01XXXXXXXXX"}
      </div>
    </div>
  );
}

function StampSealPreview() {
  return (
    <div style={{ width: 180, height: 180, borderRadius: "50%", border: "3px solid #9D174D", color: "#9D174D", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 11, fontWeight: 600, padding: 16 }}>
      SAMPLE — the organisation · Official Seal
    </div>
  );
}

function StationeryPage() {
  const { currentUser } = useCurrentUser();
  const [kind, setKind] = useState<Kind>("business_card");
  const [requests, setRequests] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(currentUser.name);
  const [designation, setDesignation] = useState(currentUser.designation);
  const [department, setDepartment] = useState("");
  const [division, setDivision] = useState("");
  const [email, setEmail] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [reason, setReason] = useState("");
  const [comments, setComments] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await db.from("stationery_requests").select("*").order("created_at", { ascending: false });
    setRequests((data ?? []) as Req[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSubmit() {
    if (!name.trim() || !designation.trim() || !reason.trim()) { toast.error("Name, designation, and reason are required"); return; }
    setSaving(true);
    const { data, error } = await db.from("stationery_requests").insert({
      kind, requester_id: currentUser.employee_id, name: name.trim(), designation: designation.trim(),
      department: department.trim() || null, division: division.trim() || null, email: email.trim() || null,
      contact_number: contactNumber.trim() || null, reason: reason.trim(), comments: comments.trim() || null,
      status: "open",
    }).select("id").single();
    setSaving(false);
    if (error || !data) { toast.error("Failed to submit: " + (error?.message ?? "unknown")); return; }
    const { error: chainErr } = await startChain("stationery_request", data.id);
    if (chainErr) toast.error("Submitted, but approvals were not set up: " + chainErr.message);

    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id, action: "created", entity_type: "stationery_request", entity_id: data.id,
      detail: `Requested a ${kind === "business_card" ? "business card" : "stamp seal"} for ${name.trim()}`,
    });
    toast.success("Request submitted");
    setReason(""); setComments("");
    load();
  }

  async function handleApprove(req: Req) {
    const { error } = await actOnSubject("stationery_request", req.id, "approve");
    if (error) { toast.error("Failed: " + error.message); return; }
    const isLastStep = !(await openStep("stationery_request", req.id));
    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id, action: "approved", entity_type: "stationery_request", entity_id: req.id,
      detail: `Approved ${req.kind === "business_card" ? "business card" : "stamp seal"} request for ${req.name}`,
    });
    toast.success(isLastStep ? "Approved — ready to fulfil" : "Approved — forwarded to next approver");
    load();
  }

  async function handleReject(req: Req) {
    const { error } = await actOnSubject("stationery_request", req.id, "reject");
    if (error) { toast.error("Failed: " + error.message); return; }
    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id, action: "rejected", entity_type: "stationery_request", entity_id: req.id,
      detail: `Rejected ${req.kind === "business_card" ? "business card" : "stamp seal"} request for ${req.name}`,
    });
    toast.success("Request rejected");
    load();
  }

  async function handleFulfil(req: Req) {
    const { error } = await db.from("stationery_requests").update({ status: "fulfilled" }).eq("id", req.id);
    if (error) { toast.error("Failed: " + error.message); return; }
    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id, action: "status_changed", entity_type: "stationery_request", entity_id: req.id,
      detail: `Marked ${req.kind === "business_card" ? "business card" : "stamp seal"} request for ${req.name} as fulfilled`,
    });
    toast.success("Marked as fulfilled");
    load();
  }

  const myRequests = requests.filter((r) => r.requester_id === currentUser.employee_id);
  const pendingForMe = requests.filter((r) => r.status === "open" && r.current_approver_id === currentUser.employee_id);
  const isHrbp = currentUser.employee_id === "EMP-0201";
  const awaitingFulfillment = requests.filter((r) => r.status === "approved");

  return (
    <div className="max-w-3xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: "0 0 20px" }}>Stationery Requests</h1>

      <div className="flex gap-2 mb-5">
        <button onClick={() => setKind("business_card")} className="inline-flex items-center gap-1.5 rounded-lg" style={{ padding: "8px 14px", fontSize: 13, border: `1px solid ${kind === "business_card" ? "#4F46E5" : "#E4E4E7"}`, background: kind === "business_card" ? "#FDE8F2" : "#fff", color: kind === "business_card" ? "#C40F5E" : "#3F3F46", cursor: "pointer" }}>
          <CreditCard size={14} /> Business Card
        </button>
        <button onClick={() => setKind("stamp_seal")} className="inline-flex items-center gap-1.5 rounded-lg" style={{ padding: "8px 14px", fontSize: 13, border: `1px solid ${kind === "stamp_seal" ? "#4F46E5" : "#E4E4E7"}`, background: kind === "stamp_seal" ? "#FDE8F2" : "#fff", color: kind === "stamp_seal" ? "#C40F5E" : "#3F3F46", cursor: "pointer" }}>
          <Stamp size={14} /> Stamp Seal
        </button>
      </div>

      <div className="flex gap-6 flex-wrap mb-8">
        <div className="flex flex-col gap-3" style={{ flex: 1, minWidth: 280 }}>
          <label className="flex flex-col gap-1"><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Name</span><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="flex flex-col gap-1"><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Designation</span><input style={inputStyle} value={designation} onChange={(e) => setDesignation(e.target.value)} /></label>
          <div className="flex gap-2">
            <label className="flex flex-col gap-1" style={{ flex: 1 }}><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Department</span><input style={inputStyle} value={department} onChange={(e) => setDepartment(e.target.value)} /></label>
            <label className="flex flex-col gap-1" style={{ flex: 1 }}><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Division</span><input style={inputStyle} value={division} onChange={(e) => setDivision(e.target.value)} /></label>
          </div>
          <div className="flex gap-2">
            <label className="flex flex-col gap-1" style={{ flex: 1 }}><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Email</span><input style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="flex flex-col gap-1" style={{ flex: 1 }}><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Contact Number</span><input style={inputStyle} value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} /></label>
          </div>
          <label className="flex flex-col gap-1"><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Reason for Request</span><textarea style={{ ...inputStyle, resize: "vertical" }} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="flex flex-col gap-1"><span style={{ fontSize: 11.5, color: "#3F3F46", fontWeight: 500 }}>Additional Comments (optional)</span><textarea style={{ ...inputStyle, resize: "vertical" }} rows={2} value={comments} onChange={(e) => setComments(e.target.value)} /></label>
          <button onClick={handleSubmit} disabled={saving} className="rounded-md text-white font-medium" style={{ padding: "9px 16px", fontSize: 13.5, background: "var(--color-brand-500)", border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, alignSelf: "flex-start" }}>
            {saving ? "Submitting…" : "Submit Request"}
          </button>
        </div>
        <div className="flex flex-col items-center gap-2" style={{ minWidth: 320 }}>
          <span style={{ fontSize: 11, color: "#A1A1AA", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {kind === "business_card" ? "Live Preview" : "Sample (no live preview for stamp seals)"}
          </span>
          {kind === "business_card"
            ? <BusinessCardPreview name={name} designation={designation} department={department} email={email} contactNumber={contactNumber} />
            : <StampSealPreview />}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : (
        <>
          {pendingForMe.length > 0 && (
            <div className="mb-6">
              <div style={{ fontSize: 12, fontWeight: 600, color: "#B45309", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Pending Your Approval</div>
              <div className="flex flex-col gap-2">
                {pendingForMe.map((r) => (
                  <div key={r.id} className="rounded-xl" style={{ padding: 14, background: "#FFFBEB", border: "1px solid #FDE68A" }}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>{r.name} — {r.kind === "business_card" ? "Business Card" : "Stamp Seal"}</div>
                        <div style={{ fontSize: 12, color: "#92400E", marginTop: 2 }}>{r.reason}</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleApprove(r)} className="rounded-md text-white font-medium" style={{ padding: "6px 12px", fontSize: 12.5, background: "#4F46E5", border: "none", cursor: "pointer" }}>Approve</button>
                        <button onClick={() => handleReject(r)} className="rounded-md font-medium bg-white" style={{ padding: "6px 12px", fontSize: 12.5, color: "#B91C1C", border: "1px solid #FECACA", cursor: "pointer" }}>Reject</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isHrbp && awaitingFulfillment.length > 0 && (
            <div className="mb-6">
              <div style={{ fontSize: 12, fontWeight: 600, color: "#166534", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Awaiting Fulfillment</div>
              <div className="flex flex-col gap-2">
                {awaitingFulfillment.map((r) => (
                  <div key={r.id} className="rounded-xl" style={{ padding: 14, background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>{r.name} — {r.kind === "business_card" ? "Business Card" : "Stamp Seal"}</div>
                        <div style={{ fontSize: 12, color: "#166534", marginTop: 2 }}>{r.reason}</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleFulfil(r)} className="rounded-md text-white font-medium" style={{ padding: "6px 12px", fontSize: 12.5, background: "#16A34A", border: "none", cursor: "pointer" }}>Mark Fulfilled</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ fontSize: 12, fontWeight: 600, color: "#52525B", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>My Requests</div>
          {myRequests.length === 0 ? (
            <div className="rounded-xl text-center" style={{ padding: "40px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>No requests yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {myRequests.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-xl bg-white" style={{ padding: 14, border: "1px solid #E4E4E7" }}>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500, color: "#18181B" }}>{r.kind === "business_card" ? "Business Card" : "Stamp Seal"}</div>
                    <div style={{ fontSize: 12, color: "#71717A" }}>{r.reason}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill status={r.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
