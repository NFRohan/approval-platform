// src/routes/notices.new.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

export const Route = createFileRoute("/notices/new")({
  head: () => ({ meta: [{ title: "New Notice · Admin Services Portal" }] }),
  component: NewNoticePage,
});

const CATEGORIES = ["General", "Policy", "Event", "IT", "HR"];
const FIRST_APPROVER = "EMP-1134"; // Line Manager — first step of the notice approval chain

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7",
  borderRadius: 6, background: "#fff", color: "#18181B", boxSizing: "border-box", fontFamily: "inherit",
};

function NewNoticePage() {
  const { currentUser } = useCurrentUser();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!title.trim()) { toast.error("Title is required"); return; }
    if (!content.trim()) { toast.error("Content is required"); return; }
    setSaving(true);
    const { data, error } = await db
      .from("notices")
      .insert({
        title: title.trim(),
        content: content.trim(),
        category,
        status: "pending",
        created_by: currentUser.employee_id,
        current_approver_id: FIRST_APPROVER,
      })
      .select("id")
      .single();
    if (error || !data) {
      toast.error("Failed to create notice: " + (error?.message ?? "unknown"));
      setSaving(false);
      return;
    }
    await db.from("activity_log").insert({
      actor_id: currentUser.employee_id,
      action: "created",
      entity_type: "notice",
      entity_id: data.id,
      detail: `Created notice "${title.trim()}"`,
    });
    setSaving(false);
    toast.success("Notice submitted for approval");
    navigate({ to: "/notices/$noticeId", params: { noticeId: data.id } });
  }

  return (
    <div className="max-w-2xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#18181B", margin: "0 0 20px" }}>New Notice</h1>
      <div className="flex flex-col gap-4 rounded-xl bg-white" style={{ padding: 20, border: "1px solid #E4E4E7" }}>
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Title</span>
          <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Office closed for public holiday" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Category</span>
          <select style={inputStyle} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Content</span>
          <textarea style={{ ...inputStyle, resize: "vertical" }} rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
        </label>
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="inline-flex items-center justify-center rounded-md font-medium text-white"
          style={{ padding: "9px 16px", fontSize: 13.5, background: "var(--color-brand-500)", border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, alignSelf: "flex-start" }}
        >
          {saving ? "Submitting…" : "Submit for Approval"}
        </button>
      </div>
    </div>
  );
}
