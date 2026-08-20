import { useEffect, useState } from "react";
import { Calendar, CalendarRange, ChevronDown, FileUp, FunctionSquare, Link2, ListChecks, Mail, Pen, Phone, Sparkles, Star, User, Zap } from "lucide-react";
import { db } from "@/lib/db";
import type { FieldKind, PlacedField } from "./types";
import { PALETTE, isEmbedded, isSmart, isLayout } from "./palette";

function escapeForRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SYSTEM_VARS: Record<string, number> = {
  DEPT_BUDGET: 1_000_000,
  ALLOWANCE: 20_000,
  PETTY_CASH: 50_000,
};

function evaluateFormula(
  formula: string,
  allFields: PlacedField[],
  allValues: Record<string, unknown>,
): number | null {
  let expr = formula;

  // System variables
  for (const [name, val] of Object.entries(SYSTEM_VARS)) {
    expr = expr.replace(new RegExp(`\\{${name}\\}`, "g"), String(val));
  }

  // Field tokens
  for (const f of allFields) {
    const token = `{${f.label}}`;
    if (expr.includes(token)) {
      const raw = allValues[f.id];
      const num = parseFloat(String(raw ?? "0").replace(/[^0-9.]/g, "")) || 0;
      expr = expr.replace(new RegExp(escapeForRegex(token), "g"), String(num));
    }
  }

  // Named math functions → JS equivalents
  expr = expr
    .replace(/\bFLOOR\s*\(/gi, "Math.floor(")
    .replace(/\bCEILING\s*\(/gi, "Math.ceil(")
    .replace(/\bCEIL\s*\(/gi, "Math.ceil(")
    .replace(/\bROUND\s*\(/gi, "Math.round(")
    .replace(/\bMAX\s*\(/gi, "Math.max(")
    .replace(/\bMIN\s*\(/gi, "Math.min(")
    .replace(/\bABS\s*\(/gi, "Math.abs(")
    .replace(/\bAVERAGE\s*\(([^)]+)\)/gi, (_m, args) => {
      const parts = args.split(",").map((s: string) => s.trim()).filter(Boolean);
      return `((${parts.join("+")})/${parts.length})`;
    });

  if (!/^[\d\s+\-*/().,Matha-z]+$/.test(expr)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr})`)() as number;
    return typeof result === "number" && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function iconForKind(kind: FieldKind) {
  for (const sec of PALETTE) {
    const found = sec.items.find((i) => i.kind === kind);
    if (found) return found.Icon;
  }
  return null;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  border: "1px solid #E4E4E7",
  borderRadius: 6,
  background: "#fff",
  color: "#18181B",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

type EmployeeRow = {
  employee_id: string;
  name: string;
  designation: string | null;
  department: string | null;
};

export function FieldRenderer({
  field,
  value,
  onChange,
  allFields = [],
  allValues = {},
}: {
  field: PlacedField;
  value: unknown;
  onChange: (v: unknown) => void;
  allFields?: PlacedField[];
  allValues?: Record<string, unknown>;
}) {
  if (isLayout(field.kind)) {
    return (
      <div className="flex items-center gap-3 my-1">
        <div style={{ flex: 1, height: 1, background: "#E4E4E7" }} />
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.09em", color: "#71717A", textTransform: "uppercase", whiteSpace: "nowrap" }}>
          {field.label}
        </span>
        <div style={{ flex: 1, height: 1, background: "#E4E4E7" }} />
      </div>
    );
  }

  // Checkbox renders as a single row — no separate card header needed since the
  // label IS the checkbox text. Wrapping it in the standard card would duplicate it.
  if (field.kind === "checkbox") {
    return (
      <div style={{ padding: "14px 16px", border: "1px solid #E4E4E7", borderRadius: 10, background: "#fff" }}>
        <label className="flex items-start gap-3 cursor-pointer" style={{ fontSize: 13.5, color: "#18181B" }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            style={{ width: 16, height: 16, marginTop: 2, accentColor: "var(--color-brand-500)", flexShrink: 0, cursor: "pointer" }}
          />
          <span>
            {field.label}
            {field.required && <span style={{ color: "#DC2626", marginLeft: 3 }}>*</span>}
          </span>
        </label>
        {field.helper && (
          <div style={{ marginLeft: 28, marginTop: 6, fontSize: 11.5, color: "#71717A" }}>{field.helper}</div>
        )}
      </div>
    );
  }

  const Icon = iconForKind(field.kind);
  const accent = isSmart(field.kind) || isEmbedded(field.kind);
  const linked = isEmbedded(field.kind);
  const smart = isSmart(field.kind) && field.kind !== "calculation";

  return (
    <div
      className="placed-field"
      style={{
        background: "#fff",
        border: `1px solid ${accent ? "#FBC5DF" : "#E4E4E7"}`,
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <div className="flex items-center gap-2.5 mb-2.5 flex-wrap">
        {Icon && (
          <span
            className="inline-flex items-center justify-center rounded-md shrink-0"
            style={{
              width: 22,
              height: 22,
              background: accent ? "#FDE8F2" : "#F4F4F5",
              color: accent ? "#C40F5E" : "#52525B",
            }}
          >
            <Icon size={12} />
          </span>
        )}
        <span className="font-medium" style={{ fontSize: 13, color: "#18181B" }}>
          {field.label}
        </span>
        {field.required && <span style={{ color: "#DC2626", fontSize: 12 }}>*</span>}
        {smart && (
          <span
            className="inline-flex items-center gap-1 rounded-full font-medium"
            style={{ padding: "2px 8px", fontSize: 11, background: "#FDE8F2", color: "#C40F5E", border: "1px solid #F79BC4" }}
          >
            <Zap size={11} /> Smart field
          </span>
        )}
        {linked && (
          <span
            className="inline-flex items-center gap-1 rounded-full font-medium"
            style={{ padding: "2px 8px", fontSize: 11, background: "#FDE8F2", color: "#C40F5E", border: "1px solid #F79BC4" }}
          >
            <Link2 size={11} /> Embedded
          </span>
        )}
      </div>

      <FieldInput field={field} value={value} onChange={onChange} allFields={allFields} allValues={allValues} />

      {field.helper && (
        <div className="mt-2" style={{ fontSize: 11, color: "#71717A" }}>
          {field.helper}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  allFields = [],
  allValues = {},
}: {
  field: PlacedField;
  value: unknown;
  onChange: (v: unknown) => void;
  allFields?: PlacedField[];
  allValues?: Record<string, unknown>;
}) {
  const k = field.kind;

  if (k === "calculation") {
    const result = field.formula
      ? evaluateFormula(field.formula, allFields, allValues)
      : null;
    const display =
      result !== null
        ? result.toLocaleString("en-US", { maximumFractionDigits: 4 })
        : field.formula
          ? "Invalid formula"
          : "No formula set";
    void onChange; // read-only — value is driven by formula evaluation
    return (
      <div
        className="flex items-center gap-2.5 rounded-md"
        style={{ padding: "10px 12px", background: "#F8FAFF", border: "1px solid #BFDBFE" }}
      >
        <FunctionSquare size={14} style={{ color: "#1D4ED8", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="font-semibold tabular-nums"
            style={{ fontSize: 15, color: result !== null ? "#18181B" : "#A1A1AA" }}
          >
            {display}
          </div>
          {field.formula && (
            <div style={{ fontSize: 11, color: "#71717A", marginTop: 2, fontFamily: "var(--font-mono, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {field.formula}
            </div>
          )}
        </div>
        <span
          className="inline-flex items-center gap-1 rounded-full font-medium shrink-0"
          style={{ padding: "2px 8px", fontSize: 11, background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE" }}
        >
          Calculated
        </span>
      </div>
    );
  }

  if (k === "text") {
    return (
      <input
        style={inputStyle}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? "Enter value…"}
      />
    );
  }
  if (k === "email") {
    return (
      <div style={{ position: "relative" }}>
        <input
          type="email"
          style={{ ...inputStyle, paddingLeft: 36 }}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? "name@example.com"}
        />
        <Mail size={13} style={{ position: "absolute", left: 11, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
      </div>
    );
  }
  if (k === "phone") {
    return (
      <div style={{ position: "relative" }}>
        <input
          type="tel"
          style={{ ...inputStyle, paddingLeft: 36 }}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? "+880 1X-XXXXXXXX"}
        />
        <Phone size={13} style={{ position: "absolute", left: 11, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
      </div>
    );
  }
  if (k === "rating") {
    const maxStars = field.validation?.maxStars ?? 5;
    const current = (value as number) ?? 0;
    return (
      <div className="flex items-center gap-0.5">
        {Array.from({ length: maxStars }).map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i + 1 === current ? 0 : i + 1)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 3px" }}
          >
            <Star
              size={24}
              style={{ color: i < current ? "#F59E0B" : "#D4D4D8", transition: "color 80ms" }}
              fill={i < current ? "#F59E0B" : "none"}
            />
          </button>
        ))}
        {current > 0 && (
          <span style={{ fontSize: 12, color: "#A1A1AA", marginLeft: 8 }}>{current} / {maxStars}</span>
        )}
      </div>
    );
  }
  if (k === "multi_select") {
    const opts = field.options ?? [];
    const selected = (value as string[]) ?? [];
    return (
      <div className="flex flex-col gap-2.5">
        {opts.map((opt) => (
          <label key={opt} className="flex items-center gap-2.5 cursor-pointer" style={{ fontSize: 13, color: "#18181B" }}>
            <input
              type="checkbox"
              checked={selected.includes(opt)}
              onChange={(e) => {
                if (e.target.checked) onChange([...selected, opt]);
                else onChange(selected.filter((s) => s !== opt));
              }}
              style={{ width: 15, height: 15, accentColor: "var(--color-brand-500)" }}
            />
            {opt}
          </label>
        ))}
        {opts.length === 0 && (
          <span style={{ fontSize: 12, color: "#A1A1AA", fontStyle: "italic" }}>No options configured</span>
        )}
      </div>
    );
  }
  if (k === "textarea") {
    return (
      <textarea
        rows={4}
        style={{ ...inputStyle, resize: "vertical" }}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? "Brief description…"}
      />
    );
  }
  if (k === "number" || k === "money") {
    return (
      <input
        type="number"
        style={inputStyle}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? (k === "money" ? "0.00 BDT" : "0")}
      />
    );
  }
  if (k === "date") {
    return (
      <div style={{ position: "relative" }}>
        <input
          type="date"
          style={inputStyle}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
        <Calendar size={13} style={{ position: "absolute", right: 10, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
      </div>
    );
  }
  if (k === "daterange") {
    const v = (value as { from?: string; to?: string }) ?? {};
    return (
      <div className="flex gap-2 items-center">
        <input
          type="date"
          style={inputStyle}
          value={v.from ?? ""}
          onChange={(e) => onChange({ ...v, from: e.target.value })}
        />
        <CalendarRange size={14} style={{ color: "#A1A1AA" }} />
        <input
          type="date"
          style={inputStyle}
          value={v.to ?? ""}
          onChange={(e) => onChange({ ...v, to: e.target.value })}
        />
      </div>
    );
  }
  if (k === "select" || k === "dept") {
    const opts = field.options ?? [];
    return (
      <div style={{ position: "relative" }}>
        <select
          style={{ ...inputStyle, appearance: "none" }}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select…</option>
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <ChevronDown size={13} style={{ position: "absolute", right: 10, top: 11, color: "#A1A1AA", pointerEvents: "none" }} />
      </div>
    );
  }
  if (k === "checkbox") {
    return (
      <label className="flex items-center gap-2" style={{ fontSize: 13, color: "#18181B" }}>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.placeholder ?? "I confirm the above"}</span>
      </label>
    );
  }
  if (k === "file") {
    const fileName = (value as string) ?? "";
    return (
      <label
        className="flex items-center gap-3 rounded-lg cursor-pointer"
        style={{ padding: "14px", border: "1px dashed #D4D4D8", background: "#FAFAFA" }}
      >
        <span
          className="inline-flex items-center justify-center rounded-md"
          style={{ width: 32, height: 32, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B" }}
        >
          <FileUp size={15} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, color: "#18181B", fontWeight: 500 }}>
            {fileName || "Click to choose a file"}
          </div>
          <div style={{ fontSize: 11.5, color: "#71717A", marginTop: 2 }}>
            PDF, DOCX, JPG · max 10 MB
          </div>
        </div>
        <input
          type="file"
          style={{ display: "none" }}
          onChange={(e) => onChange(e.target.files?.[0]?.name ?? "")}
        />
      </label>
    );
  }
  if (k === "employee") {
    return <EmployeeInput value={value as EmployeeRow | null} onChange={onChange} />;
  }
  if (k === "signature") {
    return (
      <div>
        <input
          style={inputStyle}
          placeholder="Type your full name to sign"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="mt-1 flex items-center gap-1" style={{ fontSize: 11, color: "#71717A" }}>
          <Pen size={11} /> Typed signature accepted
        </div>
      </div>
    );
  }
  if (k.startsWith("gen_")) {
    return (
      <div
        className="rounded-md"
        style={{
          padding: "10px 12px",
          background: "#FAFAFA",
          border: "1px solid #E4E4E7",
          fontSize: 12.5,
          color: "#71717A",
          fontStyle: "italic",
        }}
      >
        Auto-populated from Employee ID
      </div>
    );
  }
  if (isEmbedded(k)) {
    const labels: Record<string, string> = {
      linked_gate_pass_revocation: "Gate Pass Revocation",
      linked_office_access: "Office Access Request",
      linked_asset_return: "Asset Return Form",
    };
    return (
      <div
        className="rounded-lg"
        style={{ padding: "12px 14px", border: "1px dashed #FBC5DF", background: "#FFF6FA" }}
      >
        <label className="flex items-start gap-2" style={{ fontSize: 12.5, color: "#3F3F46" }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <strong>{labels[k]}</strong> will be auto-submitted on form approval.
          </span>
        </label>
      </div>
    );
  }
  // permissions — non-employee facing
  return (
    <div style={{ fontSize: 11, color: "#A1A1AA", fontStyle: "italic" }}>
      (Permission rule — not shown to submitter)
    </div>
  );
}

function EmployeeInput({
  value,
  onChange,
}: {
  value: EmployeeRow | null;
  onChange: (v: EmployeeRow | null) => void;
}) {
  const [id, setId] = useState((value as EmployeeRow | null)?.employee_id ?? "");
  const [loading, setLoading] = useState(false);
  const [emp, setEmp] = useState<EmployeeRow | null>(value ?? null);

  useEffect(() => {
    if (value && value.employee_id !== id) setId(value.employee_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  async function lookup() {
    if (!id.trim()) return;
    setLoading(true);
    const { data } = await db
      .from("employees")
      .select("employee_id, name, designation, department")
      .eq("employee_id", id.trim())
      .maybeSingle();
    setLoading(false);
    if (data) {
      setEmp(data as EmployeeRow);
      onChange(data as EmployeeRow);
    } else {
      setEmp(null);
      onChange(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        style={inputStyle}
        placeholder="Enter Employee ID (e.g. EMP-2847)"
        value={id}
        onChange={(e) => setId(e.target.value)}
        onBlur={lookup}
      />
      {loading && (
        <div style={{ fontSize: 11, color: "#71717A" }}>Looking up…</div>
      )}
      {emp && (
        <div
          className="rounded-md flex items-center gap-2.5"
          style={{ padding: "10px 12px", border: "1px solid #E4E4E7", background: "#FAFAFA" }}
        >
          <span
            className="inline-flex items-center justify-center rounded-full font-semibold"
            style={{ width: 28, height: 28, background: "#FDE8F2", color: "#C40F5E", fontSize: 11 }}
          >
            <User size={13} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, color: "#18181B", fontWeight: 500 }}>{emp.name}</div>
            <div style={{ fontSize: 11.5, color: "#71717A" }}>
              {emp.designation ?? "—"} · {emp.department ?? "—"} · {emp.employee_id}
            </div>
          </div>
          <span
            className="inline-flex items-center gap-1 rounded-full font-medium"
            style={{ padding: "2px 8px", fontSize: 11, background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE" }}
          >
            <Sparkles size={11} /> Auto-filled
          </span>
        </div>
      )}
    </div>
  );
}
