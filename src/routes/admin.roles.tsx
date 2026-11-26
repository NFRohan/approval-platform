import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { assignRole, createRole, decideRole, proposeRoleChange, assignRoleGroup } from "@/lib/admin-fn";
import {
  Button, Card, Field, NoPermission, Notice, Page, Pill, PERMISSION_LABELS, inputStyle,
} from "@/components/admin/kit";

export const Route = createFileRoute("/admin/roles")({
  head: () => ({ meta: [{ title: "Roles · Admin Services Portal" }] }),
  component: RolesPage,
});

type Role = {
  id: string; name: string; description: string | null; permissions: string[]; status: string;
  pending_name: string | null; pending_permissions: string[] | null;
  scope_department: string | null; pending_scope: string | null;
  created_by: string | null; changed_by: string | null; approved_by: string | null;
};
type Employee = { employee_id: string; name: string; designation: string | null; active: boolean };
type Holding = { employee_id: string; role_id: string };

const ALL = Object.keys(PERMISSION_LABELS);

function RolesPage() {
  const { can, currentUser } = useCurrentUser();
  const manage = can("roles.manage");
  const approve = can("roles.approve");
  const assign = can("users.manage");

  const [roles, setRoles] = useState<Role[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  // Roles given to whole departments, and the departments there are.
  const [groups, setGroups] = useState<{ role_id: string; department: string }[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  // The forms each role sees every request of (db/009_visibility.sql, rule 6).
  const [overseen, setOverseen] = useState<{ role_id: string; form_template_id: string }[]>([]);
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    const [r, e, h, g, d, o, f] = await Promise.all([
      db.from("roles").select("id, name, description, permissions, status, pending_name, pending_permissions, scope_department, pending_scope, created_by, changed_by, approved_by").order("name"),
      db.from("employees").select("employee_id, name, designation, active").order("name"),
      db.from("employee_roles").select("employee_id, role_id"),
      db.from("role_groups").select("role_id, department"),
      db.from("departments").select("name").order("name"),
      db.from("form_overseers").select("role_id, form_template_id"),
      db.from("form_templates").select("id, name").eq("status", "published").order("name"),
    ]);
    setOverseen((o.data ?? []) as { role_id: string; form_template_id: string }[]);
    setForms((f.data ?? []) as { id: string; name: string }[]);
    setGroups((g.data ?? []) as { role_id: string; department: string }[]);
    setDepartments(((d.data ?? []) as { name: string }[]).map((x) => x.name));
    setRoles((r.data ?? []) as Role[]);
    setEmployees((e.data ?? []) as Employee[]);
    setHoldings((h.data ?? []) as Holding[]);
  }, []);

  useEffect(() => { void load(); }, [load, currentUser.employee_id]);

  const nameOf = useMemo(() => new Map(employees.map((e) => [e.employee_id, e.name])), [employees]);

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    const r = await fn();
    if (!r.ok) { toast.error(r.error ?? "That did not work."); return false; }
    toast.success(label);
    await load();
    return true;
  }

  if (!manage && !approve && !assign && !can("audit.view")) {
    return <Page title="Roles"><NoPermission need="roles.manage or roles.approve" /></Page>;
  }

  const waiting = roles.filter((r) => r.status === "pending" || r.pending_permissions);

  return (
    <Page
      wide
      title="Roles"
      intro="A role is a named set of permissions. A new role, or a change to one, takes effect only once somebody other than its author approves it; until then the role works as it was."
    >
      {waiting.length > 0 && (
        <Card title={`Waiting for approval (${waiting.length})`}>
          <div className="flex flex-col gap-2" data-testid="roles-waiting">
            {waiting.map((r) => (
              <div key={r.id} className="flex items-center gap-3 flex-wrap rounded-lg" style={{ padding: "10px 12px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
                <div style={{ flex: 1, minWidth: 240, fontSize: 13 }}>
                  {r.status === "pending" ? (
                    <>New role <strong>{r.name}</strong> — asked for by {nameOf.get(r.created_by ?? "") ?? r.created_by ?? "—"}</>
                  ) : (
                    <>Change to <strong>{r.name}</strong>{r.pending_name && r.pending_name !== r.name && <> (renamed <strong>{r.pending_name}</strong>)</>} — proposed by {nameOf.get(r.changed_by ?? "") ?? r.changed_by ?? "—"}</>
                  )}
                  <div className="flex gap-1 flex-wrap" style={{ marginTop: 6 }}>
                    {(r.status === "pending" ? r.permissions : r.pending_permissions ?? []).map((p) => {
                      const added = r.status !== "pending" && !r.permissions.includes(p);
                      return <Pill key={p} tone={added ? "green" : "zinc"}>{added ? "+ " : ""}{PERMISSION_LABELS[p] ?? p}</Pill>;
                    })}
                    {r.status !== "pending" && r.permissions.filter((p) => !(r.pending_permissions ?? []).includes(p)).map((p) => (
                      <Pill key={p} tone="red">− {PERMISSION_LABELS[p] ?? p}</Pill>
                    ))}
                  </div>
                </div>
                {approve ? (
                  <div className="flex gap-2">
                    <Button small tone="good" name={`approve-role-${r.name}`} onClick={() => void act("Approved", () => decideRole({ data: { roleId: r.id, approve: true } }))}>Approve</Button>
                    <Button small tone="danger" onClick={() => void act("Rejected", () => decideRole({ data: { roleId: r.id, approve: false } }))}>Reject</Button>
                  </div>
                ) : <Pill tone="amber">needs roles.approve</Pill>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {manage && (creating ? (
        <RoleEditor
          title="New role"
          departments={departments}
          onCancel={() => setCreating(false)}
          onSave={async (name, description, permissions, scope) => {
            if (await act("Role created — it waits for approval", () => createRole({ data: { name, description, permissions, scope } }))) setCreating(false);
          }}
        />
      ) : (
        <div className="mb-5"><Button tone="brand" onClick={() => setCreating(true)}><Plus size={14} /> New role</Button></div>
      ))}

      <div data-testid="roles">
        {roles.filter((r) => r.status !== "rejected").map((r) => (
          <RoleCard
            key={r.id}
            role={r}
            manage={manage}
            assign={assign}
            me={currentUser.employee_id}
            holders={holdings.filter((h) => h.role_id === r.id).map((h) => h.employee_id)}
            employees={employees}
            nameOf={nameOf}
            act={act}
            groups={groups.filter((x) => x.role_id === r.id).map((x) => x.department)}
            departments={departments}
            myDepartment={currentUser.department ?? null}
            oversees={overseen.filter((x) => x.role_id === r.id).map((x) => x.form_template_id)}
            forms={forms}
          />
        ))}
      </div>
    </Page>
  );
}

function RoleEditor({ title, initial, departments, onSave, onCancel }: {
  title: string;
  initial?: { name: string; description: string | null; permissions: string[]; scope_department?: string | null };
  departments: string[];
  onSave: (name: string, description: string, permissions: string[], scope: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  // Limited to one division, or the whole organisation (a central admin).
  const [scope, setScope] = useState(initial?.scope_department ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [permissions, setPermissions] = useState<string[]>(initial?.permissions ?? []);
  const [busy, setBusy] = useState(false);

  return (
    <Card title={title}>
      <div className="flex flex-col gap-3.5" style={{ maxWidth: 560 }}>
        <Field label="Name"><input name="role-name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {!initial && <Field label="What it is for"><input style={inputStyle} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>}
        <Field label="Limited to division">
          <select aria-label="Limited to division" style={inputStyle} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">The whole organisation (central)</option>
            {departments.map((d) => <option key={d} value={d}>{d} only</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-1.5">
          {ALL.map((p) => (
            <label key={p} className="flex items-center gap-2" style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                name={`perm-${p}`}
                checked={permissions.includes(p)}
                onChange={() => setPermissions((ps) => ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p])}
              />
              {PERMISSION_LABELS[p]} <span style={{ color: "#A1A1AA", fontSize: 11 }}>{p}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button tone="brand" busy={busy} disabled={!name.trim()} onClick={async () => {
            setBusy(true);
            await onSave(name, description, permissions, scope || null);
            setBusy(false);
          }}>{initial ? "Propose change" : "Create"}</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

function RoleCard({ role: r, manage, assign, me, holders, employees, nameOf, act, groups, departments, myDepartment, oversees, forms }: {
  role: Role; manage: boolean; assign: boolean; me: string; holders: string[]; employees: Employee[];
  groups: string[]; departments: string[]; myDepartment: string | null;
  oversees: string[]; forms: { id: string; name: string }[];
  nameOf: Map<string, string>;
  act: (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState("");
  const [addingGroup, setAddingGroup] = useState("");
  const [addingForm, setAddingForm] = useState("");
  const formName = (id: string) => forms.find((f) => f.id === id)?.name ?? "A form";
  const oversee = (formId: string, on: boolean) => async () => {
    const { error } = await db.rpc("set_form_oversight", { p_role: r.id, p_form: formId, p_on: on });
    return error ? { ok: false, error: error.message } : { ok: true };
  };

  if (editing) {
    return (
      <RoleEditor
        title={`Change ${r.name}`}
        initial={r}
        departments={departments}
        onCancel={() => setEditing(false)}
        onSave={async (name, _d, permissions, scope) => {
          if (await act("Change proposed — it waits for approval", () =>
            proposeRoleChange({ data: { roleId: r.id, name: name !== r.name ? name : null, permissions, scope } }))) setEditing(false);
        }}
      />
    );
  }

  return (
    <Card
      title={<span className="inline-flex items-center gap-2">{r.name} {r.status === "pending" && <Pill tone="amber">awaiting approval</Pill>}{r.pending_permissions && <Pill tone="amber">change waiting</Pill>}</span>}
      aside={manage && r.status === "active" && !r.pending_permissions ? <Button small onClick={() => setEditing(true)}>Change</Button> : undefined}
    >
      {r.description && <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 10px" }}>{r.description}</p>}
      <div className="flex gap-1 flex-wrap" style={{ marginBottom: 12 }}>
        <Pill tone={r.scope_department ? "amber" : "zinc"}>{r.scope_department ? `${r.scope_department} only` : "Whole organisation"}</Pill>
        {r.permissions.map((p) => <Pill key={p} tone="brand">{PERMISSION_LABELS[p] ?? p}</Pill>)}
        {r.permissions.length === 0 && <span style={{ fontSize: 12, color: "#A1A1AA" }}>No permissions</span>}
      </div>
      <div style={{ fontSize: 12, color: "#71717A", marginBottom: 6 }}>Held by</div>
      <div className="flex gap-1.5 flex-wrap items-center" data-role={r.name}>
        {holders.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full" style={{ padding: "2px 4px 2px 9px", fontSize: 12, background: "#F4F4F5", border: "1px solid #E4E4E7" }}>
            {nameOf.get(id) ?? id}
            {assign && id !== me && (
              <button
                title="Take this role away"
                onClick={() => void act(`${r.name} taken from ${nameOf.get(id) ?? id}`, () => assignRole({ data: { employeeId: id, roleId: r.id, assign: false } }))}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 2, display: "inline-flex" }}
              ><X size={12} /></button>
            )}
          </span>
        ))}
        {holders.length === 0 && <span style={{ fontSize: 12, color: "#A1A1AA" }}>Nobody</span>}
        {assign && r.status === "active" && (
          <span className="inline-flex items-center gap-1.5">
            <select
              name={`give-${r.name}`}
              style={{ ...inputStyle, width: 220, padding: "4px 8px", fontSize: 12 }}
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">Give to…</option>
              {employees.filter((e) => e.active && !holders.includes(e.employee_id) && e.employee_id !== me).map((e) => (
                <option key={e.employee_id} value={e.employee_id}>{e.name} ({e.employee_id})</option>
              ))}
            </select>
            <Button small disabled={!adding} onClick={async () => {
              if (await act(`${r.name} given to ${nameOf.get(adding) ?? adding}`, () => assignRole({ data: { employeeId: adding, roleId: r.id, assign: true } }))) setAdding("");
            }}>Give</Button>
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#71717A", margin: "12px 0 6px" }}>Held by everyone in</div>
      <div className="flex gap-1.5 flex-wrap items-center" data-role-groups={r.name}>
        {groups.map((d) => (
          <span key={d} className="inline-flex items-center gap-1 rounded-full" style={{ padding: "2px 4px 2px 9px", fontSize: 12, background: "#EEF2FF", border: "1px solid #C7D2FE", color: "#3730A3" }}>
            {d}
            {assign && d !== myDepartment && (
              <button
                title="Take this role from the department"
                onClick={() => void act(`${r.name} taken from everyone in ${d}`, () => assignRoleGroup({ data: { department: d, roleId: r.id, assign: false } }))}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 2, display: "inline-flex" }}
              ><X size={12} /></button>
            )}
          </span>
        ))}
        {groups.length === 0 && <span style={{ fontSize: 12, color: "#A1A1AA" }}>No department</span>}
        {assign && r.status === "active" && (
          <span className="inline-flex items-center gap-1.5">
            <select
              name={`give-group-${r.name}`}
              style={{ ...inputStyle, width: 220, padding: "4px 8px", fontSize: 12 }}
              value={addingGroup}
              onChange={(e) => setAddingGroup(e.target.value)}
            >
              <option value="">Give to a department…</option>
              {departments.filter((d) => !groups.includes(d) && d !== myDepartment).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <Button small disabled={!addingGroup} onClick={async () => {
              if (await act(`${r.name} given to everyone in ${addingGroup}`, () => assignRoleGroup({ data: { department: addingGroup, roleId: r.id, assign: true } }))) setAddingGroup("");
            }}>Give</Button>
          </span>
        )}
      </div>
      {(oversees.length > 0 || manage) && (
        <>
          <div style={{ fontSize: 12, color: "#71717A", margin: "12px 0 6px" }}
            title="Whoever holds this role sees every request of these forms, and no others they have no part in">
            Sees every request of
          </div>
          <div className="flex gap-1.5 flex-wrap items-center" data-role-oversees={r.name}>
            {oversees.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full" style={{ padding: "2px 4px 2px 9px", fontSize: 12, background: "#ECFDF5", border: "1px solid #A7F3D0", color: "#065F46" }}>
                {formName(id)}
                {manage && (
                  <button
                    title="Stop this role seeing every request of the form"
                    aria-label={`Stop overseeing ${formName(id)}`}
                    onClick={() => void act(`${r.name} no longer sees every ${formName(id)}`, oversee(id, false))}
                    style={{ border: "none", background: "transparent", cursor: "pointer", padding: 2, display: "inline-flex" }}
                  ><X size={12} /></button>
                )}
              </span>
            ))}
            {oversees.length === 0 && <span style={{ fontSize: 12, color: "#A1A1AA" }}>Only the requests they have a part in</span>}
            {manage && r.status === "active" && (
              <span className="inline-flex items-center gap-1.5">
                <select
                  name={`oversee-${r.name}`}
                  aria-label={`${r.name}: see every request of`}
                  style={{ ...inputStyle, width: 240, padding: "4px 8px", fontSize: 12 }}
                  value={addingForm}
                  onChange={(e) => setAddingForm(e.target.value)}
                >
                  <option value="">Add a form…</option>
                  {forms.filter((f) => !oversees.includes(f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <Button small disabled={!addingForm} onClick={async () => {
                  if (await act(`${r.name} now sees every ${formName(addingForm)}`, oversee(addingForm, true))) setAddingForm("");
                }}>Add</Button>
              </span>
            )}
          </div>
        </>
      )}
      {r.status === "active" && holders.length > 0 && (
        <Notice tone="zinc">
          <span style={{ fontSize: 12 }}>Approved by {nameOf.get(r.approved_by ?? "") ?? r.approved_by ?? "—"}; created by {nameOf.get(r.created_by ?? "") ?? r.created_by ?? "—"}.</span>
        </Notice>
      )}
    </Card>
  );
}
