// =====================================================================
// What waits on me as an administrator, in Pending Approvals.
//
// New accounts, profile changes, roles and report column changes each
// need somebody other than whoever asked. They used to wait on their own
// admin screens, where nobody looked unless they already knew (SOW §3.6
// 2.1, 2.5: "admins are not told one is waiting; a rejection carries no
// reason"). Here they sit beside the requests, decided in place, and a
// rejection needs a reason, which goes to whoever asked.
// =====================================================================

import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { adminQueue, decideAdminItem, type AdminItem } from "@/lib/admin-fn";
import { fmtDate } from "@/lib/dates";

export const ADMIN_QUEUE_CHANGED = "admin-queue-changed";

const KIND: Record<AdminItem["kind"], string> = {
  account: "Account",
  profile: "Profile",
  role: "Role",
  report: "Report",
};

function OpenLink({ item }: { item: AdminItem }) {
  const style = { fontSize: 12.5, color: "#4F46E5", textDecoration: "underline" } as const;
  if (item.kind === "report") return <Link to="/reports/$reportId" params={{ reportId: item.id }} style={style}>Open the report</Link>;
  if (item.kind === "role") return <Link to="/admin/roles" style={style}>Open Roles</Link>;
  return <Link to="/admin/users" style={style}>Open Users</Link>;
}

export function AdminQueue({ employeeId, onCount }: { employeeId: string; onCount?: (n: number) => void }) {
  const [items, setItems] = useState<AdminItem[]>([]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await adminQueue();
    if (r.ok) {
      setItems(r.items);
      onCount?.(r.items.length);
    }
  }, [onCount]);
  useEffect(() => { void load(); }, [load, employeeId]);

  const decide = async (item: AdminItem, approve: boolean) => {
    if (!approve && !reason.trim()) {
      toast.error("Give a reason; it goes to whoever asked.");
      return;
    }
    setBusy(item.id + item.kind);
    const r = await decideAdminItem({ data: { kind: item.kind, id: item.id, approve, reason: approve ? undefined : reason } });
    setBusy(null);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(approve ? `Approved; ${item.requested_by_name ?? "whoever asked"} has been told` : `Turned down; ${item.requested_by_name ?? "whoever asked"} has been told why`);
    setRejecting(null);
    setReason("");
    window.dispatchEvent(new Event(ADMIN_QUEUE_CHANGED));
    await load();
  };

  if (items.length === 0) return null;

  return (
    <section className="rounded-xl bg-white mb-5" style={{ border: "1px solid #E4E4E7" }} aria-label="Needs an administrator">
      <div className="flex items-center gap-2" style={{ padding: "14px 18px", borderBottom: "1px solid #F4F4F5" }}>
        <ShieldCheck size={16} style={{ color: "#4F46E5" }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>Needs an administrator</span>
        <span className="rounded-full" style={{ fontSize: 11.5, fontWeight: 600, padding: "1px 8px", background: "#EEF2FF", color: "#4338CA" }}>
          {items.length}
        </span>
        <span style={{ fontSize: 12.5, color: "#71717A", marginLeft: 4 }}>
          Changes that need a second person. You did not ask for these.
        </span>
      </div>
      <div>
        {items.map((item) => {
          const key = item.kind + item.id;
          const open = rejecting === key;
          return (
            <div key={key} style={{ padding: "14px 18px", borderTop: "1px solid #F4F4F5" }} data-admin-item={item.kind}>
              <div className="flex items-start gap-3">
                <span className="rounded-md shrink-0" style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", background: "#F4F4F5", color: "#52525B", marginTop: 2 }}>
                  {KIND[item.kind]}
                </span>
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>{item.title}</div>
                  {item.detail && <div style={{ fontSize: 13, color: "#3F3F46", marginTop: 3 }}>{item.detail}</div>}
                  {item.note && (
                    <div style={{ fontSize: 13, color: "#52525B", marginTop: 6, paddingLeft: 10, borderLeft: "2px solid #E4E4E7" }}>
                      “{item.note}”
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ fontSize: 12.5, color: "#71717A", marginTop: 6 }}>
                    <span>Asked by {item.requested_by_name ?? item.requested_by ?? "somebody"}{item.requested_at ? `, ${fmtDate(item.requested_at)}` : ""}</span>
                    <OpenLink item={item} />
                  </div>
                </div>
                {!open && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busy === item.id + item.kind}
                      onClick={() => decide(item, true)}
                      className="rounded-md text-white font-medium"
                      style={{ padding: "6px 12px", fontSize: 13, background: "#4F46E5" }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRejecting(key); setReason(""); }}
                      className="rounded-md font-medium"
                      style={{ padding: "6px 12px", fontSize: 13, border: "1px solid #FECACA", color: "#B91C1C", background: "#fff" }}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
              {open && (
                <div className="flex flex-col gap-2" style={{ marginTop: 10, marginLeft: 0 }}>
                  <textarea
                    autoFocus
                    aria-label="Reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={`Why not? ${item.requested_by_name ?? "Whoever asked"} will see this.`}
                    rows={2}
                    className="rounded-md"
                    style={{ padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7", resize: "vertical" }}
                  />
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setRejecting(null)} className="rounded-md"
                            style={{ padding: "6px 12px", fontSize: 13, border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46" }}>
                      Cancel
                    </button>
                    <button type="button" disabled={busy === item.id + item.kind} onClick={() => decide(item, false)}
                            className="rounded-md text-white font-medium" style={{ padding: "6px 12px", fontSize: 13, background: "#B91C1C" }}>
                      Turn it down
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
