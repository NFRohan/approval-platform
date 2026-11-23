// Divisions: who heads each, its HR business partner and its CXO — the
// people approval routes resolve to — and renaming or merging one, which
// carries its people, the forms offered to it and the reports about it.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { GitMerge, Pencil, Plus } from "lucide-react";
import { db } from "@/lib/db";
import { Button, Card, Pill, inputStyle } from "@/components/admin/kit";

type Dept = { id: string; name: string; head_employee_id: string | null; hrbp_employee_id: string | null; cxo_employee_id: string | null };
type Person = { employee_id: string; name: string; department: string | null; active: boolean };

export function Divisions({ canManage }: { canManage: boolean }) {
  const [depts, setDepts] = useState<Dept[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [{ data: d }, { data: p }] = await Promise.all([
      db.from("departments").select("id, name, head_employee_id, hrbp_employee_id, cxo_employee_id").order("name"),
      db.from("employees").select("employee_id, name, department, active").order("name"),
    ]);
    setDepts((d ?? []) as Dept[]);
    setPeople((p ?? []) as Person[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const name = (id: string | null) => people.find((p) => p.employee_id === id)?.name ?? "—";
  const count = (d: string) => people.filter((p) => p.active && p.department === d).length;

  return (
    <Card title="Divisions" aside={canManage && !adding ? <Button small onClick={() => setAdding(true)}><Plus size={12} /> New division</Button> : undefined}>
      <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 12px" }}>
        Approval routes find a requester's head of department, HR business partner and CXO here. Renaming or merging a division
        carries its people, the forms offered to it and the reports filtered by it. A division the HR file names for the first time
        is added on its own.
      </p>
      {adding && <NewDivision people={people} onDone={async () => { setAdding(false); await load(); }} />}
      <div data-testid="divisions">
        {depts.map((d) => (
          <div key={d.id} style={{ padding: "10px 2px", borderTop: "1px solid #F4F4F5" }} data-division={d.name}>
            <div className="flex items-center gap-3 flex-wrap">
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#18181B" }}>{d.name} <Pill>{count(d.name)} people</Pill></div>
                <div style={{ fontSize: 12, color: "#71717A", marginTop: 2 }}>
                  Head {name(d.head_employee_id)} · HRBP {name(d.hrbp_employee_id)} · CXO {name(d.cxo_employee_id)}
                </div>
              </div>
              {canManage && (
                <div className="flex gap-1.5">
                  <Button small onClick={() => { setEditing(editing === d.id ? null : d.id); setMerging(null); }}><Pencil size={12} /> Change</Button>
                  <Button small onClick={() => { setMerging(merging === d.id ? null : d.id); setEditing(null); }}><GitMerge size={12} /> Merge</Button>
                </div>
              )}
            </div>
            {editing === d.id && <EditDivision dept={d} people={people} onDone={async () => { setEditing(null); await load(); }} />}
            {merging === d.id && <MergeDivision dept={d} others={depts.filter((x) => x.id !== d.id)} count={count(d.name)} onDone={async () => { setMerging(null); await load(); }} />}
          </div>
        ))}
      </div>
    </Card>
  );
}

function PersonSelect({ label, value, onChange, people }: { label: string; value: string; onChange: (v: string) => void; people: Person[] }) {
  return (
    <label className="flex flex-col gap-1" style={{ fontSize: 11.5, color: "#71717A", flex: 1, minWidth: 160 }}>
      {label}
      <select style={{ ...inputStyle, padding: "6px 8px", fontSize: 12.5 }} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Nobody</option>
        {people.filter((p) => p.active).map((p) => <option key={p.employee_id} value={p.employee_id}>{p.name}</option>)}
      </select>
    </label>
  );
}

function EditDivision({ dept, people, onDone }: { dept: Dept; people: Person[]; onDone: () => Promise<void> }) {
  const [name, setName] = useState(dept.name);
  const [head, setHead] = useState(dept.head_employee_id ?? "");
  const [hrbp, setHrbp] = useState(dept.hrbp_employee_id ?? "");
  const [cxo, setCxo] = useState(dept.cxo_employee_id ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex gap-2 items-end flex-wrap rounded-lg" style={{ marginTop: 10, padding: 10, background: "#FAFAFA", border: "1px solid #E4E4E7" }}>
      <label className="flex flex-col gap-1" style={{ fontSize: 11.5, color: "#71717A", flex: 1, minWidth: 160 }}>
        Name<input name="division-name" style={{ ...inputStyle, padding: "6px 8px", fontSize: 12.5 }} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <PersonSelect label="Head" value={head} onChange={setHead} people={people} />
      <PersonSelect label="HR business partner" value={hrbp} onChange={setHrbp} people={people} />
      <PersonSelect label="CXO" value={cxo} onChange={setCxo} people={people} />
      <Button small tone="brand" busy={busy} onClick={async () => {
        setBusy(true);
        if (name.trim() !== dept.name) {
          const { data, error } = await db.rpc("rename_department", { p_from: dept.name, p_into: name.trim() });
          if (error) { setBusy(false); return void toast.error(error.message); }
          const r = data as { people: number; forms: number; reports: number };
          toast.success(`Renamed — ${r.people} people, ${r.forms} forms and ${r.reports} reports follow it`);
        }
        const { error } = await db.from("departments").update({ head_employee_id: head || null, hrbp_employee_id: hrbp || null, cxo_employee_id: cxo || null }).eq("id", dept.id);
        setBusy(false);
        if (error) return void toast.error(error.message);
        await onDone();
      }}>Save</Button>
    </div>
  );
}

function MergeDivision({ dept, others, count, onDone }: { dept: Dept; others: Dept[]; count: number; onDone: () => Promise<void> }) {
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex gap-2 items-center flex-wrap rounded-lg" style={{ marginTop: 10, padding: 10, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 13 }}>
      <span>Merge <strong>{dept.name}</strong> ({count} people) into</span>
      <select name="merge-into" style={{ ...inputStyle, width: 220, padding: "6px 8px", fontSize: 12.5 }} value={into} onChange={(e) => setInto(e.target.value)}>
        <option value="">Choose a division…</option>
        {others.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
      </select>
      <Button small tone="danger" busy={busy} disabled={!into} name="confirm-merge" onClick={async () => {
        setBusy(true);
        const { data, error } = await db.rpc("merge_departments", { p_from: dept.name, p_into: into });
        setBusy(false);
        if (error) return void toast.error(error.message);
        const r = data as { people: number; forms: number; reports: number };
        toast.success(`${dept.name} merged into ${into}: ${r.people} people, ${r.forms} forms, ${r.reports} reports moved`);
        await onDone();
      }}>Merge</Button>
      <span style={{ fontSize: 12, color: "#92400E" }}>{into ? `${into} keeps its own head, HRBP and CXO.` : ""}</span>
    </div>
  );
}

function NewDivision({ people, onDone }: { people: Person[]; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [head, setHead] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex gap-2 items-end flex-wrap rounded-lg" style={{ marginBottom: 10, padding: 10, background: "#FAFAFA", border: "1px solid #E4E4E7" }}>
      <label className="flex flex-col gap-1" style={{ fontSize: 11.5, color: "#71717A", flex: 1, minWidth: 200 }}>
        Name<input style={{ ...inputStyle, padding: "6px 8px", fontSize: 12.5 }} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <PersonSelect label="Head" value={head} onChange={setHead} people={people} />
      <Button small tone="brand" busy={busy} disabled={!name.trim()} onClick={async () => {
        setBusy(true);
        const { error } = await db.from("departments").insert({ name: name.trim(), head_employee_id: head || null });
        setBusy(false);
        if (error) return void toast.error(error.message);
        toast.success("Division added");
        await onDone();
      }}>Add</Button>
    </div>
  );
}
