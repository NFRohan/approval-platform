import { SlabBreakdown } from "./SlabTable";
import { useEffect, useState } from "react";
import { DollarSign, Lock, Plus, X } from "lucide-react";
import { db } from "@/lib/db";

export type AutoEntry = {
  id: string;
  name: string;
  designation: string;
  reason: string;
  displayReason?: string;
  deadlineDays?: number;
  user_id: string;
  slab?: boolean;
};

export type ManualEntry = {
  id: string;
  user_id: string;
  name: string;
  designation: string;
  deadlineDays: number;
};

type EmployeeOption = {
  employee_id: string;
  name: string;
  designation: string | null;
};

type Props = {
  title: string;
  subtitle: string;
  autoEntries: AutoEntry[];
  showDeadline: boolean;
  manual: ManualEntry[];
  onManualChange: (next: ManualEntry[]) => void;
  formTemplateId?: string | null;
};


export function PeopleStep({
  title,
  subtitle,
  autoEntries,
  showDeadline,
  manual,
  onManualChange,
  formTemplateId,
}: Props) {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await db
        .from("employees")
        .select("employee_id, name, designation")
        .order("name");
      setEmployees(data ?? []);
    })();
  }, []);

  function addRow() {
    const first = employees[0];
    onManualChange([
      ...manual,
      {
        id: crypto.randomUUID(),
        user_id: first?.employee_id ?? "",
        name: first?.name ?? "",
        designation: first?.designation ?? "",
        deadlineDays: 7,
      },
    ]);
  }

  function updateRow(id: string, patch: Partial<ManualEntry>) {
    onManualChange(manual.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function removeRow(id: string) {
    onManualChange(manual.filter((m) => m.id !== id));
  }

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "#FAFAFA", padding: "32px 0" }}>
      <div className="mx-auto" style={{ maxWidth: 880, padding: "0 24px" }}>
        <div className="mb-6">
          <h1 className="font-semibold" style={{ fontSize: 20, color: "#18181B", letterSpacing: "-0.01em" }}>
            {title}
          </h1>
          <p style={{ fontSize: 13, color: "#71717A", marginTop: 4 }}>{subtitle}</p>
        </div>

        {/* Auto-added section */}
        <section className="mb-6 rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", overflow: "hidden" }}>
          <div
            className="flex items-center gap-2"
            style={{ padding: "12px 16px", background: "#FAFAFA", borderBottom: "1px solid #E4E4E7" }}
          >
            <Lock size={13} style={{ color: "#A1A1AA" }} />
            <span className="font-semibold" style={{ fontSize: 12.5, color: "#3F3F46" }}>Auto-added</span>
            <span style={{ fontSize: 11, color: "#A1A1AA" }}>
              · derived from form fields & defaults · cannot be removed
            </span>
          </div>

          <div>
            {autoEntries.map((e, i) => (
              <div
                key={e.id}
                style={{ borderTop: i === 0 ? "none" : "1px solid #F4F4F5", padding: "14px 16px" }}
              >
                <div className="flex items-center gap-3">
                  <Avatar name={e.name} slab={e.slab} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate" style={{ fontSize: 13.5, color: "#18181B" }}>
                        {e.name}
                      </span>
                      <span style={{ fontSize: 12, color: "#71717A" }}>· {e.designation}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span
                        className="inline-flex items-center rounded-full font-semibold"
                        style={{ padding: "2px 8px", fontSize: 10.5, background: "#FDE8F2", color: "#C40F5E", letterSpacing: "0.02em" }}
                      >
                        AUTO
                      </span>
                      {e.slab ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full font-semibold"
                          style={{ padding: "2px 8px", fontSize: 10.5, background: "#FFFBEB", color: "#B45309", border: "1px solid #FDE68A" }}
                        >
                          <DollarSign size={10} /> Slab routing
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center rounded-full"
                          style={{ padding: "2px 8px", fontSize: 11, background: "#F4F4F5", color: "#52525B", border: "1px solid #E4E4E7" }}
                        >
                          {e.displayReason ?? e.reason}
                        </span>
                      )}
                    </div>
                  </div>
                  {showDeadline && (
                    <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: "#52525B" }}>
                      <span style={{ color: "#A1A1AA" }}>Target:</span>
                      <span className="font-medium">{e.deadlineDays ?? 7} days</span>
                    </div>
                  )}
                  <Lock size={13} style={{ color: "#D4D4D8" }} />
                </div>

                {e.slab && <SlabBreakdown formTemplateId={formTemplateId} />}
              </div>
            ))}
          </div>
          {showDeadline && (
            <div
              style={{ padding: "8px 16px 12px", fontSize: 11, color: "#A1A1AA", lineHeight: 1.5 }}
            >
              A target is a date, not a rule. Requests past theirs are marked overdue and
              sorted to the top of the approver's queue; nothing is escalated, reassigned
              or approved automatically.
            </div>
          )}
        </section>

        {/* Manual section */}
        <section className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", overflow: "hidden" }}>
          <div
            className="flex items-center justify-between"
            style={{ padding: "12px 16px", background: "#FAFAFA", borderBottom: "1px solid #E4E4E7" }}
          >
            <span className="font-semibold" style={{ fontSize: 12.5, color: "#3F3F46" }}>
              Additional {showDeadline ? "approvers" : "people to notify"}
            </span>
            <button
              onClick={addRow}
              className="inline-flex items-center gap-1.5 rounded-md cursor-pointer bg-white"
              style={{ padding: "5px 10px", fontSize: 12, fontWeight: 500, color: "#3F3F46", border: "1px solid #E4E4E7" }}
            >
              <Plus size={12} /> {showDeadline ? "Add Approver" : "Add Person"}
            </button>
          </div>

          {manual.length === 0 ? (
            <div className="text-center" style={{ padding: "28px 16px", fontSize: 12.5, color: "#A1A1AA" }}>
              No additional {showDeadline ? "approvers" : "people"} added yet.
            </div>
          ) : (
            <div>
              {manual.map((m, i) => (
                <div
                  key={m.id}
                  className="flex items-center gap-3"
                  style={{ padding: "12px 16px", borderTop: i === 0 ? "none" : "1px solid #F4F4F5" }}
                >
                  <select
                    value={m.user_id}
                    onChange={(e) => {
                      const emp = employees.find((x) => x.employee_id === e.target.value);
                      updateRow(m.id, { user_id: e.target.value, name: emp?.name ?? "", designation: emp?.designation ?? "" });
                    }}
                    className="flex-1 rounded-md bg-white"
                    style={{ padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", color: "#18181B", outline: "none" }}
                  >
                    {employees.map((emp) => (
                      <option key={emp.employee_id} value={emp.employee_id}>
                        {emp.name} — {emp.designation}
                      </option>
                    ))}
                  </select>
                  {showDeadline && (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        value={m.deadlineDays}
                        onChange={(e) => updateRow(m.id, { deadlineDays: Math.max(1, Number(e.target.value) || 1) })}
                        className="rounded-md bg-white"
                        style={{ width: 64, padding: "7px 10px", fontSize: 13, border: "1px solid #E4E4E7", textAlign: "center", outline: "none" }}
                      />
                      <span style={{ fontSize: 12, color: "#71717A" }}>days</span>
                    </div>
                  )}
                  <button
                    onClick={() => removeRow(m.id)}
                    className="rounded-md cursor-pointer"
                    style={{ padding: 6, color: "#71717A", border: "1px solid #E4E4E7", background: "#fff" }}
                    aria-label="Remove"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Avatar({ name, slab }: { name: string; slab?: boolean }) {
  const initials = slab
    ? "₺"
    : name.split(" ").map((s) => s[0]).slice(0, 2).join("");
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold shrink-0"
      style={{
        width: 32,
        height: 32,
        fontSize: slab ? 14 : 11.5,
        background: slab ? "#FFFBEB" : "#F4F4F5",
        color: slab ? "#B45309" : "#52525B",
        border: `1px solid ${slab ? "#FDE68A" : "#E4E4E7"}`,
      }}
    >
      {initials}
    </span>
  );
}
