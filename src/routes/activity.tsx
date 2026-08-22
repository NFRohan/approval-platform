import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Activity as ActivityIcon } from "lucide-react";
import { db } from "@/lib/db";

export const Route = createFileRoute("/activity")({
  // Global search sends a person here — it is the only page that can
  // answer "what has this person been doing".
  validateSearch: (search: Record<string, unknown>): { actor?: string } => ({
    actor: typeof search.actor === "string" ? search.actor : undefined,
  }),
  head: () => ({ meta: [{ title: "Activity Log · Admin Services Portal" }] }),
  component: ActivityPage,
});

type LogRow = { id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; detail: string | null; created_at: string; actorName?: string };

const ENTITY_TYPES = ["form_submission", "movement_order", "notice", "stationery_request", "maintenance_request", "approval_slab"];

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

const ACTION_COLORS: Record<string, string> = {
  approved: "#166534", rejected: "#B91C1C", clarification_requested: "#92400E",
  on_hold: "#92400E", published: "#1D4ED8", created: "#3F3F46", slab_updated: "#7C3AED", status_changed: "#3F3F46",
};

function ActivityPage() {
  const { actor } = Route.useSearch();
  const navigate = useNavigate();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [entityFilter, setEntityFilter] = useState("all");

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data } = await db.from("activity_log").select("*").order("created_at", { ascending: false }).limit(200);
      const list = (data ?? []) as LogRow[];
      const actorIds = Array.from(new Set(list.map((r) => r.actor_id).filter(Boolean) as string[]));
      if (actorIds.length) {
        const { data: emps } = await db.from("employees").select("employee_id, name").in("employee_id", actorIds);
        const map: Record<string, string> = {};
        (emps ?? []).forEach((e) => { map[e.employee_id] = e.name; });
        list.forEach((r) => { if (r.actor_id) r.actorName = map[r.actor_id]; });
      }
      if (active) { setRows(list); setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const byEntity = entityFilter === "all" ? rows : rows.filter((r) => r.entity_type === entityFilter);
  const visible = actor ? byEntity.filter((r) => r.actor_id === actor) : byEntity;
  const actorName = rows.find((r) => r.actor_id === actor)?.actorName ?? actor;

  return (
    <div className="max-w-3xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: "0 0 6px" }}>Activity Log</h1>
      <p style={{ fontSize: 13.5, color: "#71717A", marginBottom: 20 }}>Every approval, rejection, and status change across the portal.</p>

      {actor && (
        <div
          className="flex items-center gap-3 rounded-lg mb-4"
          style={{ padding: "9px 13px", background: "#EEF2FF", border: "1px solid #C7D2FE" }}
        >
          <span style={{ fontSize: 12.5, color: "#3730A3" }}>
            Showing only what <strong>{actorName}</strong> did.
          </span>
          <button
            onClick={() => navigate({ to: "/activity", search: (prev) => ({ ...prev, actor: undefined }) })}
            className="cursor-pointer bg-white rounded-md"
            style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5, color: "#3730A3", border: "1px solid #C7D2FE" }}
          >
            Show everyone
          </button>
        </div>
      )}

      <div className="flex gap-1 flex-wrap mb-5">
        <button onClick={() => setEntityFilter("all")} style={{ padding: "5px 12px", fontSize: 12, borderRadius: 9999, border: `1px solid ${entityFilter === "all" ? "#18181B" : "#E4E4E7"}`, background: entityFilter === "all" ? "#F4F4F5" : "#fff", cursor: "pointer" }}>All</button>
        {ENTITY_TYPES.map((t) => (
          <button key={t} onClick={() => setEntityFilter(t)} style={{ padding: "5px 12px", fontSize: 12, borderRadius: 9999, border: `1px solid ${entityFilter === t ? "#18181B" : "#E4E4E7"}`, background: entityFilter === t ? "#F4F4F5" : "#fff", cursor: "pointer", textTransform: "capitalize" }}>
            {t.replace("_", " ")}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl text-center" style={{ padding: "64px 24px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13 }}>No activity recorded yet.</div>
      ) : (
        <div className="rounded-xl bg-white overflow-hidden" style={{ border: "1px solid #E4E4E7" }}>
          {visible.map((r, i) => (
            <div key={r.id} className="flex items-start gap-3" style={{ padding: "12px 16px", borderBottom: i < visible.length - 1 ? "1px solid #F4F4F5" : "none" }}>
              <ActivityIcon size={14} style={{ color: "#A1A1AA", marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#18181B" }}>
                  <span style={{ fontWeight: 600 }}>{r.actorName ?? r.actor_id}</span>{" "}
                  <span style={{ color: ACTION_COLORS[r.action] ?? "#52525B", fontWeight: 500 }}>{r.action.replace(/_/g, " ")}</span>
                  {r.detail && <span style={{ color: "#52525B" }}> — {r.detail}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "#A1A1AA", marginTop: 2 }}>{fmt(r.created_at)} · {r.entity_type.replace("_", " ")}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
