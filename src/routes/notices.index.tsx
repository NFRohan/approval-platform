import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Megaphone, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

export const Route = createFileRoute("/notices/")({
  head: () => ({ meta: [{ title: "Notice Board · Admin Services Portal" }] }),
  component: NoticeBoardPage,
});

const CREATOR_IDS = new Set(["EMP-0201", "EMP-0445"]);

type Notice = {
  id: string;
  title: string;
  content: string;
  category: string | null;
  status: string;
  created_by: string | null;
  current_approver_id: string | null;
  created_at: string;
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function NoticeBoardPage() {
  const { currentUser } = useCurrentUser();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("all");

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data } = await supabase.from("notices").select("*").order("created_at", { ascending: false });
      if (active) {
        setNotices((data ?? []) as Notice[]);
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const pendingForMe = notices.filter((n) => n.status === "pending" && n.current_approver_id === currentUser.employee_id);
  const published = notices.filter((n) => n.status === "published" && (category === "all" || n.category === category));
  const categories = Array.from(new Set(notices.filter((n) => n.status === "published").map((n) => n.category).filter(Boolean) as string[]));

  return (
    <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }}>Notice Board</h1>
          <p style={{ marginTop: 5, fontSize: 13.5, color: "#71717A" }}>Company-wide announcements and updates.</p>
        </div>
        {CREATOR_IDS.has(currentUser.employee_id) && (
          <Link
            to="/notices/new"
            className="inline-flex items-center gap-1.5 rounded-lg"
            style={{ padding: "9px 16px", fontSize: 13, fontWeight: 500, background: "var(--color-brand-500)", color: "#fff", textDecoration: "none" }}
          >
            <Plus size={14} /> New Notice
          </Link>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : (
        <>
          {pendingForMe.length > 0 && (
            <div className="mb-6">
              <div style={{ fontSize: 12, fontWeight: 600, color: "#B45309", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Pending Your Approval
              </div>
              <div className="flex flex-col gap-2">
                {pendingForMe.map((n) => (
                  <Link
                    key={n.id}
                    to="/notices/$noticeId"
                    params={{ noticeId: n.id }}
                    className="block rounded-xl"
                    style={{ padding: 14, background: "#FFFBEB", border: "1px solid #FDE68A", textDecoration: "none" }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>{n.title}</div>
                    <div style={{ fontSize: 12, color: "#92400E", marginTop: 3 }}>Submitted {fmt(n.created_at)}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-1 flex-wrap mb-5">
            <button
              onClick={() => setCategory("all")}
              style={{ padding: "5px 12px", fontSize: 12, borderRadius: 9999, border: `1px solid ${category === "all" ? "#18181B" : "#E4E4E7"}`, background: category === "all" ? "#F4F4F5" : "#fff", color: "#18181B", cursor: "pointer" }}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                style={{ padding: "5px 12px", fontSize: 12, borderRadius: 9999, border: `1px solid ${category === c ? "#18181B" : "#E4E4E7"}`, background: category === c ? "#F4F4F5" : "#fff", color: "#18181B", cursor: "pointer" }}
              >
                {c}
              </button>
            ))}
          </div>

          {published.length === 0 ? (
            <div className="rounded-xl text-center" style={{ padding: "64px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>
              No published notices yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {published.map((n) => (
                <Link
                  key={n.id}
                  to="/notices/$noticeId"
                  params={{ noticeId: n.id }}
                  className="block rounded-xl bg-white"
                  style={{ padding: 16, border: "1px solid #E4E4E7", textDecoration: "none" }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <Megaphone size={13} style={{ color: "#4F46E5" }} />
                    <span style={{ fontSize: 15, fontWeight: 600, color: "#18181B" }}>{n.title}</span>
                    {n.category && <span style={{ fontSize: 11, color: "#71717A", marginLeft: "auto" }}>{n.category}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: "#52525B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.content}</div>
                  <div style={{ fontSize: 11.5, color: "#A1A1AA", marginTop: 6 }}>{fmt(n.created_at)}</div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
