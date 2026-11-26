import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Lock, UserPlus } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  assignRole, decideAccount, decideProfile, directoryStatus, listAccounts, proposeProfile,
  registerAccount, resetAccountPassword, setAccountStatus, unlockAccount, type Account,
} from "@/lib/admin-fn";
import {
  Button, Card, Field, NoPermission, Notice, OneTimeSecret, Page, Pill, fmtWhen, inputStyle,
} from "@/components/admin/kit";

export const Route = createFileRoute("/admin/users")({
  head: () => ({ meta: [{ title: "Users · Admin Services Portal" }] }),
  component: UsersPage,
});

type Employee = { employee_id: string; name: string; designation: string | null; department: string | null; active: boolean };
type Role = { id: string; name: string; status: string };
type Holding = { employee_id: string; role_id: string };

function suggestUsername(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/).join(".").slice(0, 40);
}

function UsersPage() {
  const { can, currentUser } = useCurrentUser();
  const manage = can("users.manage");
  const approve = can("users.approve");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [directory, setDirectory] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const [a, e, r, h] = await Promise.all([
      listAccounts(),
      db.from("employees").select("employee_id, name, designation, department, active").order("name"),
      db.from("roles").select("id, name, status").order("name"),
      db.from("employee_roles").select("employee_id, role_id"),
    ]);
    if (a.ok) { setAccounts(a.accounts); setError(null); } else setError(a.error);
    setEmployees((e.data ?? []) as Employee[]);
    setRoles((r.data ?? []) as Role[]);
    setHoldings((h.data ?? []) as Holding[]);
  }, []);

  useEffect(() => {
    if (manage || approve) void load();
    void directoryStatus().then((d) => setDirectory(d.configured)).catch(() => {});
  }, [load, manage, approve, currentUser.employee_id]);

  const nameOf = useMemo(() => new Map(employees.map((e) => [e.employee_id, e.name])), [employees]);
  const waiting = accounts.filter((a) => a.approval_state === "pending" || a.pending_profile);
  const shown = accounts.filter((a) => {
    const q = filter.trim().toLowerCase();
    return !q || [a.username, a.employee_name, a.department, a.employee_id].some((v) => v?.toLowerCase().includes(q));
  });

  if (!manage && !approve) {
    return <Page title="Users"><NoPermission need="users.manage or users.approve" /></Page>;
  }

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    const r = await fn();
    if (!r.ok) { toast.error(r.error ?? "That did not work."); return false; }
    toast.success(label);
    await load();
    return true;
  }

  return (
    <Page
      wide
      title="Users"
      intro="Accounts for the people in the org chart. Somebody registers an account or proposes a change to it; somebody else approves it. Nobody approves their own."
    >
      {error && <Notice tone="red">{error}</Notice>}
      {secret && <OneTimeSecret label={secret.label} value={secret.value} onDone={() => setSecret(null)} />}

      {waiting.length > 0 && (
        <Card title={`Waiting for approval (${waiting.length})`}>
          <div className="flex flex-col gap-2" data-testid="waiting">
            {waiting.map((a) => (
              <div key={a.id} className="flex items-center gap-3 flex-wrap rounded-lg" style={{ padding: "10px 12px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
                <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
                  {a.approval_state === "pending" ? (
                    <>New account <strong>{a.username}</strong> for {a.employee_name ?? a.employee_id}
                      {a.auth_source === "ldap" && " (directory sign-in)"}
                      <span style={{ color: "#92400E" }}> — asked for by {nameOf.get(a.created_by_employee ?? "") ?? a.created_by_employee ?? "—"}</span></>
                  ) : (
                    <>Profile change for <strong>{a.username}</strong>:{" "}
                      {a.pending_profile?.full_name && <>name → <strong>{a.pending_profile.full_name}</strong> </>}
                      {a.pending_profile?.email && <>email → <strong>{a.pending_profile.email}</strong> </>}
                      <span style={{ color: "#92400E" }}>— proposed by {nameOf.get(a.pending_profile?.by ?? "") ?? a.pending_profile?.by ?? "—"}</span></>
                  )}
                </div>
                {approve ? (
                  <div className="flex gap-2">
                    <Button small tone="good" name={`approve-${a.username}`} onClick={() => void act("Approved", () =>
                      a.approval_state === "pending"
                        ? decideAccount({ data: { userId: a.id, approve: true } })
                        : decideProfile({ data: { userId: a.id, approve: true } }))}>Approve</Button>
                    <Button small tone="danger" onClick={() => void act("Rejected", () =>
                      a.approval_state === "pending"
                        ? decideAccount({ data: { userId: a.id, approve: false } })
                        : decideProfile({ data: { userId: a.id, approve: false } }))}>Reject</Button>
                  </div>
                ) : <Pill tone="amber">needs users.approve</Pill>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {manage && (
        <Register
          employees={employees.filter((e) => e.active && !accounts.some((a) => a.employee_id === e.employee_id))}
          directory={directory}
          onDone={async (username, password) => {
            if (password) setSecret({ label: `Temporary password for ${username}. Give it to them in person or through a channel only they read.`, value: password });
            await load();
          }}
        />
      )}

      <Card
        title={`Accounts (${accounts.length})`}
        aside={<input placeholder="Filter by name, username, department" style={{ ...inputStyle, width: 260 }} value={filter} onChange={(e) => setFilter(e.target.value)} />}
      >
        <div className="flex flex-col" data-testid="accounts">
          {shown.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              self={a.employee_id === currentUser.employee_id}
              manage={manage}
              roles={roles}
              held={holdings.filter((h) => h.employee_id === a.employee_id).map((h) => h.role_id)}
              act={act}
              // A reset changes the account (it must change the password), so
              // the list reloads to say so straight away.
              showSecret={(label, value) => { setSecret({ label, value }); void load(); }}
            />
          ))}
          {shown.length === 0 && <div style={{ fontSize: 13, color: "#A1A1AA", padding: 12 }}>No accounts match.</div>}
        </div>
      </Card>
    </Page>
  );
}

function Register({ employees, directory, onDone }: {
  employees: Employee[]; directory: boolean; onDone: (username: string, password: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [username, setUsername] = useState("");
  const [useDirectory, setUseDirectory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="mb-5">
        <Button tone="brand" onClick={() => setOpen(true)}><UserPlus size={14} /> Register an account</Button>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await registerAccount({ data: { employeeId, username, directory: useDirectory } });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast.success("Account registered — it waits for approval");
    setOpen(false); setEmployeeId(""); setUsername("");
    await onDone(username, r.password);
  }

  return (
    <Card title="Register an account">
      <form onSubmit={submit} className="flex flex-col gap-3.5" style={{ maxWidth: 520 }}>
        <Field label="Person" hint="People come from the HR file or the directory. Each has at most one account.">
          <select
            name="employee"
            style={inputStyle}
            value={employeeId}
            onChange={(e) => {
              setEmployeeId(e.target.value);
              const emp = employees.find((x) => x.employee_id === e.target.value);
              if (emp) setUsername(suggestUsername(emp.name));
            }}
          >
            <option value="">Choose somebody…</option>
            {employees.map((e) => (
              <option key={e.employee_id} value={e.employee_id}>
                {e.name} — {e.designation ?? "—"}, {e.department ?? "—"} ({e.employee_id})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Username" hint="3 to 40 lower-case letters, digits, dots, dashes or underscores.">
          <input name="username" style={inputStyle} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span style={{ fontSize: 12, fontWeight: 500, color: "#3F3F46" }}>Signs in with</span>
          <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
            <input type="radio" checked={!useDirectory} onChange={() => setUseDirectory(false)} /> A password from here — generated now, changed at first sign-in
          </label>
          <label className="flex items-center gap-2" style={{ fontSize: 13, color: directory ? undefined : "#A1A1AA" }}>
            <input type="radio" disabled={!directory} checked={useDirectory} onChange={() => setUseDirectory(true)} /> Their directory (LDAP) password
            {!directory && " — no directory is connected here"}
          </label>
        </div>
        {error && <Notice tone="red">{error}</Notice>}
        <div className="flex gap-2">
          <Button type="submit" tone="brand" busy={busy} disabled={!employeeId || !username}>Register</Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function AccountRow({ account: a, self, manage, roles, held, act, showSecret }: {
  account: Account; self: boolean; manage: boolean; roles: Role[]; held: string[];
  act: (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => Promise<boolean>;
  showSecret: (label: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.full_name ?? "");
  const [email, setEmail] = useState(a.email ?? "");
  const active = roles.filter((r) => r.status === "active");

  return (
    <div className="flex flex-col gap-2" style={{ padding: "12px 4px", borderTop: "1px solid #F4F4F5" }} data-username={a.username}>
      <div className="flex items-center gap-3 flex-wrap">
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "#18181B" }}>
            {a.username} {self && <span style={{ fontWeight: 400, color: "#71717A" }}>(you)</span>}
          </div>
          <div style={{ fontSize: 12, color: "#71717A" }}>
            {a.employee_name ?? "Evaluation login — acts as any persona"}{a.department ? ` · ${a.department}` : ""}
            {" · "}last sign-in {fmtWhen(a.last_login_at)}
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {a.approval_state === "pending" && <Pill tone="amber">awaiting approval</Pill>}
          {a.approval_state === "rejected" && <Pill tone="red">rejected</Pill>}
          {a.approval_state === "approved" && a.status === "active" && <Pill tone="green">active</Pill>}
          {a.status === "disabled" && <Pill tone="amber">disabled</Pill>}
          {a.status === "deactivated" && <Pill tone="red">deactivated</Pill>}
          {a.locked && <Pill tone="red" title={`${a.failed_attempts} failed attempts`}>locked</Pill>}
          {a.mfa_enabled && <Pill tone="brand">two-step</Pill>}
          {a.auth_source === "ldap" && <Pill>directory</Pill>}
          {a.must_change_pw && a.auth_source === "local" && <Pill>must change password</Pill>}
        </div>
      </div>

      {manage && a.status !== "deactivated" && (
        <div className="flex gap-1.5 flex-wrap">
          {a.locked && <Button small tone="good" onClick={() => void act("Unlocked", () => unlockAccount({ data: { userId: a.id } }))}><Lock size={12} /> Unlock</Button>}
          {a.auth_source === "local" && a.approval_state === "approved" && (
            <Button small onClick={async () => {
              const r = await resetAccountPassword({ data: { userId: a.id } });
              if (!r.ok) return void toast.error(r.error);
              showSecret(`New temporary password for ${a.username}.`, r.password);
            }}>Reset password</Button>
          )}
          {a.employee_id && <Button small onClick={() => setEditing((v) => !v)}>Change profile</Button>}
          {!self && a.status === "active" && a.approval_state === "approved" && (
            <Button small onClick={() => void act("Disabled", () => setAccountStatus({ data: { userId: a.id, status: "disabled" } }))}>Disable</Button>
          )}
          {!self && a.status === "disabled" && (
            <Button small tone="good" onClick={() => void act("Enabled", () => setAccountStatus({ data: { userId: a.id, status: "active" } }))}>Enable</Button>
          )}
          {!self && (
            <Button small tone="danger" onClick={() => {
              if (window.confirm(`Deactivate ${a.username} permanently? This cannot be undone.`)) {
                void act("Deactivated", () => setAccountStatus({ data: { userId: a.id, status: "deactivated" } }));
              }
            }}>Deactivate</Button>
          )}
        </div>
      )}

      {editing && (
        <div className="flex gap-2 items-end flex-wrap" style={{ maxWidth: 640 }}>
          <div style={{ flex: 1, minWidth: 180 }}><Field label="Name"><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
          <div style={{ flex: 1, minWidth: 180 }}><Field label="Work email"><input style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} /></Field></div>
          <Button small tone="brand" onClick={async () => {
            if (await act("Change proposed — it waits for approval", () => proposeProfile({ data: { userId: a.id, fullName: name, email } }))) setEditing(false);
          }}>Propose</Button>
        </div>
      )}

      {a.employee_id && (
        <div className="flex gap-1.5 flex-wrap items-center" style={{ fontSize: 12, color: "#71717A" }}>
          Roles:
          {active.map((r) => {
            const has = held.includes(r.id);
            if (!has && (!manage || self)) return null;
            return (
              <button
                key={r.id}
                disabled={!manage || self}
                title={self ? "Nobody changes their own roles" : has ? "Take this role away" : "Give this role"}
                onClick={() => void act(has ? `${r.name} taken away` : `${r.name} given`,
                  () => assignRole({ data: { employeeId: a.employee_id!, roleId: r.id, assign: !has } }))}
                className="rounded-full"
                style={{
                  padding: "1px 8px", fontSize: 11, cursor: manage && !self ? "pointer" : "default",
                  background: has ? "#EEF2FF" : "#fff", color: has ? "#4338CA" : "#A1A1AA",
                  border: `1px ${has ? "solid" : "dashed"} ${has ? "#C7D2FE" : "#E4E4E7"}`,
                }}
              >
                {has ? r.name : `+ ${r.name}`}
              </button>
            );
          })}
          {held.length === 0 && (!manage || self) && <span>none</span>}
        </div>
      )}
    </div>
  );
}
