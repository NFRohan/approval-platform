// src/routes/notices.$noticeId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/notices/$noticeId")({
  head: () => ({ meta: [{ title: "Notice · Admin Services Portal" }] }),
  component: NoticeDetailPage,
});

// Sequential approval chain: Line Manager -> HOD (played by EMP-0445 for this feature)
const CHAIN = ["EMP-1134", "EMP-0445"];

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
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data: n } = await supabase.from("notices").select("*").eq("id", noticeId).maybeSingle();
    setNotice(n as Notice | null);
    if (n?.created_by) {
      const { data: emp } = await supabase.from("employees").select("name").eq("employee_id", n.created_by).maybeSingle();
      setCreatorName(emp?.name ?? n.created_by);
    }
    const { data: c } = await supabase.from("notice_comments").select("*").eq("notice_id", noticeId).order("created_at");
    const rows = (c ?? []) as Comment[];
    const authorIds = Array.from(new Set(rows.map((r) => r.author_id).filter(Boolean) as string[]));
    if (authorIds.length) {
      const { data: emps } = await supabase.from("employees").select("employee_id, name").in("employee_id", authorIds);
      const map: Record<string, string> = {};
      (emps ?? []).forEach((e) => { map[e.employee_id] = e.name; });
      rows.forEach((r) => { if (r.author_id) r.authorName = map[r.author_id]; });
    }
    setComments(rows);
    setLoading(false);
  }, [noticeId]);

  useEffect(() => { load(); }, [load]);

  async function handleApprove() {
    if (!notice) return;
    const currentIndex = CHAIN.indexOf(notice.current_approver_id ?? "");
    const isLastStep = currentIndex === CHAIN.length - 1;
    const update = isLastStep
      ? { status: "published", current_approver_id: null, updated_at: new Date().toISOString() }
      : { current_approver_id: CHAIN[currentIndex + 1], updated_at: new Date().toISOString() };
    const { error } = await supabase.from("notices").update(update).eq("id", notice.id);
    if (error) { toast.error("Failed to approve: " + error.message); return; }
    await supabase.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: isLastStep ? "published" : "approved",
      entity_type: "notice",
      entity_id: notice.id,
      detail: isLastStep ? `Published notice "${notice.title}"` : `Approved notice "${notice.title}" (forwarded to next approver)`,
    });
    toast.success(isLastStep ? "Notice published" : "Approved — forwarded to next approver");
    load();
  }

  async function handleReject() {
    if (!notice || !rejectReason.trim()) { toast.error("Please provide a reason"); return; }
    const { error } = await supabase.from("notices").update({ status: "rejected", current_approver_id: null, updated_at: new Date().toISOString() }).eq("id", notice.id);
    if (error) { toast.error("Failed to reject: " + error.message); return; }
    await supabase.from("activity_log").insert({
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
  }

  async function handleComment() {
    if (!commentText.trim()) return;
    const { error } = await supabase.from("notice_comments").insert({
      notice_id: noticeId,
      author_id: currentUser.employee_id,
      text: commentText.trim(),
    });
    if (error) { toast.error("Failed to comment: " + error.message); return; }
    setCommentText("");
    load();
  }

  if (loading) return <div style={{ padding: 32, fontSize: 13, color: "#A1A1AA" }}>Loading…</div>;
  if (!notice) return <div style={{ padding: 32, fontSize: 13, color: "#A1A1AA" }}>Notice not found.</div>;

  const canApprove = notice.status === "pending" && notice.current_approver_id === currentUser.employee_id;

  return (
    <div className="max-w-2xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: 22 }}>
        <div className="flex items-center gap-2 mb-2">
          {notice.category && (
            <span style={{ fontSize: 11, fontWeight: 600, color: "#C40F5E", background: "#FDE8F2", border: "1px solid #FBC5DF", borderRadius: 9999, padding: "2px 9px" }}>
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
            <button onClick={handleApprove} className="rounded-md text-white font-medium" style={{ padding: "7px 14px", fontSize: 13, background: "#4F46E5", border: "none", cursor: "pointer" }}>
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
            <button onClick={handleComment} className="rounded-md text-white font-medium" style={{ padding: "8px 14px", fontSize: 13, background: "var(--color-brand-500)", border: "none", cursor: "pointer" }}>
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
            <button onClick={handleReject} className="rounded-md text-white font-medium" style={{ padding: "7px 14px", fontSize: 13, background: "#B91C1C", border: "none" }}>Confirm</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
