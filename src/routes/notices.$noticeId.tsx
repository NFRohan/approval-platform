// src/routes/notices.$noticeId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { actOnSubject, openStep } from "@/lib/chain";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/notices/$noticeId")({
  head: () => ({ meta: [{ title: "Notice · Admin Services Portal" }] }),
  component: NoticeDetailPage,
});


type Notice = {
  id: string; title: string; content: string; category: string | null;
  status: string; created_by: string | null; current_approver_id: string | null; created_at: string;
};
type Comment = { id: string; author_id: string | null; text: string; created_at: string; authorName?: string };

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function NoticeDetailPage() {
  const { noticeId } = Route.useParams();
  const { currentUser } = useCurrentUser();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [creatorName, setCreatorName] = useState("");
  const [loading, setLoading] = useState(true);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data: n } = await db.from("notices").select("*").eq("id", noticeId).maybeSingle();
    setNotice(n as Notice | null);
    if (n?.created_by) {
      const { data: emp } = await db.from("employees").select("name").eq("employee_id", n.created_by).maybeSingle();
      setCreatorName(emp?.name ?? n.created_by);
    }
    const { data: c } = await db.from("notice_comments").select("*").eq("notice_id", noticeId).order("created_at");
    const rows = (c ?? []) as Comment[];
    const authorIds = Array.from(new Set(rows.map((r) => r.author_id).filter(Boolean) as string[]));
    if (authorIds.length) {
      const { data: emps } = await db.from("employees").select("employee_id, name").in("employee_id", authorIds);
      const map: Record<string, string> = {};
      (emps ?? []).forEach((e) => { map[e.employee_id] = e.name; });
      rows.forEach((r) => { if (r.author_id) r.authorName = map[r.author_id]; });
    }
    setComments(rows);
    setLoading(false);
  }, [noticeId]);

  useEffect(() => { load(); }, [load]);

  async function handleApprove() {
    if (!notice || busy) return;
    setBusy(true);
    try {
      // Where this goes next is the chain's business, not this screen's.
      // What used to be here was a two-element array of employee ids that
      // had stopped existing, walked by index.
      const { error } = await actOnSubject("notice", notice.id, "approve");
      if (error) { toast.error("Failed to approve: " + error.message); return; }
      const isLastStep = !(await openStep("notice", notice.id));
      await db.from("activity_log").insert({
        actor_id: currentUser.employee_id,
        action: isLastStep ? "published" : "approved",
        entity_type: "notice",
        entity_id: notice.id,
        detail: isLastStep ? `Published notice "${notice.title}"` : `Approved notice "${notice.title}" (forwarded to next approver)`,
      });
      toast.success(isLastStep ? "Notice published" : "Approved — forwarded to next approver");
      load();
    } finally { setBusy(false); }
  }

  async function handleReject() {
    if (busy) return;
    if (!notice || !rejectReason.trim()) { toast.error("Please provide a reason"); return; }
    setBusy(true);
    try {
      const { error } = await actOnSubject("notice", notice.id, "reject", rejectReason);
      if (error) { toast.error("Failed to reject: " + error.message); return; }
      await db.from("activity_log").insert({
        actor_id: currentUser.employee_id,
        action: "rejected",
        entity_type: "notice",
        entity_id: notice.id,
        detail: `Rejected notice "${notice.title}": ${rejectReason.trim()}`,
      });
      setRejectOpen(false);
      setRejectReason("");
      toast.success("Notice rejected");
      load();
    } finally { setBusy(false); }
  }

  async function handleComment() {
    // Without this a fast double-click posted the same comment twice.
    if (!commentText.trim() || busy) return;
    setBusy(true);
    try {
      const { error } = await db.from("notice_comments").insert({
        notice_id: noticeId,
        author_id: currentUser.employee_id,
        text: commentText.trim(),
      });
      if (error) { toast.error("Failed to comment: " + error.message); return; }
      setCommentText("");
      load();
    } finally { setBusy(false); }
  }

  if (loading) return <div style={{ padding: 32, fontSize: 13, color: "#A1A1AA" }}>Loading…</div>;
  if (!notice) return <div style={{ padding: 32, fontSize: 13, color: "#A1A1AA" }}>Notice not found.</div>;

  const canApprove = notice.status === "pending" && notice.current_approver_id === currentUser.employee_id;

  return (
    <div className="max-w-2xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: 22 }}>
        <div className="flex items-center gap-2 mb-2">
          {notice.category && (
            <span style={{ fontSize: 11, fontWeight: 600, color: "#4338CA", background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 9999, padding: "2px 9px" }}>
              {notice.category}
            </span>
          )}
          <span style={{ fontSize: 12, color: "#A1A1AA" }}>{fmt(notice.created_at)}</span>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#18181B", margin: "0 0 6px" }}>{notice.title}</h1>
        <div style={{ fontSize: 12.5, color: "#71717A", marginBottom: 16 }}>Posted by {creatorName}</div>
        <p style={{ fontSize: 14, color: "#3F3F46", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{notice.content}</p>

        {canApprove && (
          <div className="flex gap-2 mt-5 pt-4" style={{ borderTop: "1px solid #F0F0F0" }}>
            <button onClick={handleApprove} disabled={busy} className="rounded-md text-white font-medium" style={{ padding: "7px 14px", fontSize: 13, background: "#4F46E5", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
              Approve
            </button>
            <button onClick={() => setRejectOpen(true)} className="rounded-md font-medium bg-white" style={{ padding: "7px 12px", fontSize: 13, color: "#B91C1C", border: "1px solid #FECACA", cursor: "pointer" }}>
              Reject
            </button>
          </div>
        )}
      </div>

      {notice.status === "published" && (
        <div className="rounded-xl bg-white mt-4" style={{ border: "1px solid #E4E4E7", padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B", marginBottom: 10 }}>Comments</div>
          <div className="flex flex-col gap-3 mb-4">
            {comments.length === 0 ? (
              <div style={{ fontSize: 13, color: "#A1A1AA" }}>No comments yet.</div>
            ) : (
              comments.map((c) => (
                <div key={c.id} style={{ padding: 10, background: "#FAFAFA", border: "1px solid #F4F4F5", borderRadius: 8 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: "#18181B" }}>{c.authorName ?? c.author_id}</div>
                  <div style={{ fontSize: 13, color: "#3F3F46", marginTop: 3 }}>{c.text}</div>
                  <div style={{ fontSize: 11, color: "#A1A1AA", marginTop: 4 }}>{fmt(c.created_at)}</div>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Ask a question or leave a comment…"
              style={{ flex: 1, padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7", borderRadius: 6 }}
              onKeyDown={(e) => { if (e.key === "Enter") handleComment(); }}
            />
            <button onClick={handleComment} disabled={busy} className="rounded-md text-white font-medium" style={{ padding: "8px 14px", fontSize: 13, background: "var(--color-brand-500)", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
              Post
            </button>
          </div>
        </div>
      )}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reason for rejection</DialogTitle></DialogHeader>
          <Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={4} placeholder="Explain why this notice is being rejected…" />
          <DialogFooter>
            <button onClick={() => setRejectOpen(false)} className="rounded-md font-medium bg-white" style={{ padding: "7px 12px", fontSize: 13, color: "#52525B", border: "1px solid #E4E4E7" }}>Cancel</button>
            <button onClick={handleReject} disabled={busy} className="rounded-md text-white font-medium" style={{ padding: "7px 14px", fontSize: 13, background: "#B91C1C", border: "none", opacity: busy ? 0.6 : 1 }}>Confirm</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
