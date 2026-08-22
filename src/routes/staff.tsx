import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  listEvaluations, mintEvaluation, extendEvaluation,
  revokeEvaluation, resetEvaluationPassword, type Evaluation,
} from "@/lib/staff-fn";
import { currentSession } from "@/lib/auth-fn";
import { LoadingRows } from "@/components/Loading";

export const Route = createFileRoute("/staff")({
  head: () => ({ meta: [{ title: "Evaluations · Admin Services Portal" }] }),
  component: StaffPage,
});

const STATE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  active:  { label: "Active",    color: "#166534", bg: "#DCFCE7", border: "#BBF7D0" },
  expired: { label: "Expired",   color: "#92400E", bg: "#FEF3C7", border: "#FDE68A" },
  revoked: { label: "Withdrawn", color: "#B91C1C", bg: "#FEF2F2", border: "#FECACA" },
};

const input: React.CSSProperties = {
  padding: "8px 10px", fontSize: 13, border: "1px solid #E4E4E7",
  borderRadius: 7, background: "#fff", color: "#18181B", fontFamily: "inherit",
};

function StaffPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Evaluation[] | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  // Shown once, then gone — it is stored hashed and cannot be recovered.
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    const list = await listEvaluations().catch(() => null);
    setRows(list ?? []);
  }, []);

  useEffect(() => {
    void currentSession().then((s) => {
      setAllowed(s?.isStaff === true);
      if (s?.isStaff) void load();
    });
  }, [load]);

  if (allowed === null) {
    return <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px" }}><LoadingRows rows={3} /></div>;
  }

  if (!allowed) {
    return (
      <div className="max-w-4xl mx-auto" style={{ padding: "48px 28px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 650, margin: "0 0 8px" }}>Not your console</h1>
        <p style={{ fontSize: 13.5, color: "#71717A", margin: 0 }}>
          This page issues and withdraws evaluations. It is for the people who run them,
          not for the people using one.
        </p>
      </div>
    );
  }

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await mintEvaluation({
      data: { name: name.trim(), username: username.trim(), days: Number(days) || 30 },
    });
    setBusy(false);
    if (!result.ok) { toast.error(result.error ?? "Could not issue it"); return; }
    setIssued({ username: username.trim(), password: result.password! });
    setName(""); setUsername("");
    await load();
  }

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string; password?: string }>) {
    const result = await fn();
    if (!result.ok) { toast.error(result.error ?? `Could not ${label}`); return; }
    if (result.password) setIssued({ username: "(password reset)", password: result.password });
    else toast.success(label);
    await load();
  }

  return (
    <div className="max-w-4xl mx-auto" style={{ padding: "32px 28px 56px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 6px" }}>
        Evaluations
      </h1>
      <p style={{ fontSize: 13.5, color: "#71717A", marginBottom: 22 }}>
        Each one is a full clone of the template with its own data and its own login.
        They expire on their own; extending keeps everything already entered.
      </p>

      {issued && (
        <div
          className="rounded-lg mb-5"
          style={{ padding: "14px 16px", background: "#EEF2FF", border: "1px solid #C7D2FE" }}
        >
          <div style={{ fontSize: 12.5, color: "#3730A3", fontWeight: 600, marginBottom: 6 }}>
            Send these now — the password is not stored and cannot be shown again.
          </div>
          <div className="font-mono" style={{ fontSize: 13, color: "#18181B" }}>
            {issued.username}<br />{issued.password}
          </div>
          <button
            onClick={() => setIssued(null)}
            className="cursor-pointer bg-white rounded-md"
            style={{ marginTop: 10, padding: "4px 10px", fontSize: 11.5, color: "#3730A3", border: "1px solid #C7D2FE" }}
          >
            I have copied it
          </button>
        </div>
      )}

      <form
        onSubmit={mint}
        className="rounded-xl bg-white flex flex-wrap items-end gap-3 mb-6"
        style={{ border: "1px solid #E4E4E7", padding: 16 }}
      >
        <label className="flex flex-col gap-1.5" style={{ flex: "2 1 180px" }}>
          <span style={{ fontSize: 11.5, color: "#71717A" }}>Who it is for</span>
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind Group" />
        </label>
        <label className="flex flex-col gap-1.5" style={{ flex: "2 1 160px" }}>
          <span style={{ fontSize: 11.5, color: "#71717A" }}>Username</span>
          <input style={input} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="northwind.eval" spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1.5" style={{ width: 96 }}>
          <span style={{ fontSize: 11.5, color: "#71717A" }}>Days</span>
          <input style={input} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button
          type="submit" disabled={busy}
          className="rounded-md text-white font-medium"
          style={{ padding: "9px 15px", fontSize: 13.5, background: "#4F46E5", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Issuing…" : "Issue evaluation"}
        </button>
      </form>

      {rows === null ? (
        <LoadingRows rows={3} height={72} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl bg-white text-center" style={{ border: "1px solid #E4E4E7", padding: 36, fontSize: 13, color: "#A1A1AA" }}>
          No evaluations have been issued yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => {
            const state = STATE[r.state] ?? STATE.active;
            const soon = r.state === "active" && r.daysLeft !== null && r.daysLeft <= 7;
            return (
              <div
                key={r.id}
                className="rounded-xl bg-white flex items-center gap-3 flex-wrap"
                style={{ border: "1px solid #E4E4E7", padding: "13px 16px" }}
              >
                <div className="min-w-0" style={{ flex: "1 1 220px" }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>{r.name}</div>
                  <div className="font-mono" style={{ fontSize: 11.5, color: "#A1A1AA", marginTop: 2 }}>
                    {r.username ?? "no account"} · {r.slug}
                  </div>
                </div>

                <span
                  className="rounded-full font-medium"
                  style={{ padding: "2px 9px", fontSize: 11, color: state.color, background: state.bg, border: `1px solid ${state.border}` }}
                >
                  {state.label}
                </span>

                <div style={{ fontSize: 11.5, color: soon ? "#B45309" : "#71717A", width: 92, textAlign: "right" }}>
                  {r.state !== "active"
                    ? "—"
                    : r.daysLeft === 0 ? "expires today" : `${r.daysLeft} days left`}
                </div>

                <div style={{ fontSize: 11.5, color: "#A1A1AA", width: 108 }}>
                  {r.lastLoginAt ? `used ${new Date(r.lastLoginAt).toLocaleDateString()}` : "never signed in"}
                </div>

                <div className="flex gap-1.5 shrink-0">
                  <Action onClick={() => act("Extended by 14 days", () => extendEvaluation({ data: { tenantId: r.id, days: 14 } }))}>
                    +14d
                  </Action>
                  <Action onClick={() => act("Password reset", () => resetEvaluationPassword({ data: { tenantId: r.id } }))}>
                    Reset password
                  </Action>
                  {r.state !== "revoked" && (
                    <Action
                      danger
                      onClick={() => {
                        if (!confirm(`Withdraw ${r.name}? They will not be able to sign in again.`)) return;
                        void act("Withdrawn", () => revokeEvaluation({ data: { tenantId: r.id } }));
                      }}
                    >
                      Withdraw
                    </Action>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Action({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="cursor-pointer rounded-md font-medium bg-white"
      style={{
        padding: "5px 10px", fontSize: 11.5,
        color: danger ? "#B91C1C" : "#52525B",
        border: `1px solid ${danger ? "#FECACA" : "#E4E4E7"}`,
      }}
    >
      {children}
    </button>
  );
}
