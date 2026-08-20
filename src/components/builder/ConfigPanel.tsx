import { SlabTable } from "./SlabTable";
import { useEffect, useRef, useState } from "react";
import { Settings, Trash } from "lucide-react";
import type { PlacedField } from "./types";

type Tab = "field" | "validation" | "routing";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className="cursor-pointer relative shrink-0 rounded-full"
      style={{ width: 32, height: 18, background: on ? "var(--color-brand-500)" : "#D4D4D8", transition: "background 120ms", border: "none" }}
    >
      <span
        className="absolute rounded-full bg-white"
        style={{ top: 2, left: on ? 16 : 2, width: 14, height: 14, boxShadow: "0 1px 2px rgba(0,0,0,0.15)", transition: "left 120ms" }}
      />
    </button>
  );
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

const numInputStyle: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid #E4E4E7",
  borderRadius: 6,
  background: "#fff",
  color: "#18181B",
  width: 80,
  boxSizing: "border-box",
  fontFamily: "inherit",
};

function OptionsEditor({ options, onChange }: { options: string[]; onChange: (opts: string[]) => void }) {
  const [text, setText] = useState(() => options.join("\n"));

  // Sync if options change externally (field switch resets via key, but guard anyway)
  useEffect(() => {
    setText(options.join("\n"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.join("\x00")]);

  function flush(raw: string) {
    const filtered = raw.split("\n").filter((s) => s.trim().length > 0);
    onChange(filtered);
    setText(filtered.join("\n"));
  }

  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => flush(e.target.value)}
      rows={5}
      placeholder={"Option A\nOption B\nOption C"}
      style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
    />
  );
}

function FormulaEditor({
  field,
  allFields,
  onChange,
}: {
  field: PlacedField;
  allFields: PlacedField[];
  onChange: (p: Partial<PlacedField>) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [formula, setFormula] = useState(field.formula ?? "");

  useEffect(() => {
    setFormula(field.formula ?? "");
  }, [field.id]);

  const numericFields = allFields.filter(
    (f) => f.id !== field.id && ["number", "money", "rating"].includes(f.kind),
  );

  const FUNC_CHIPS = ["ROUND()", "FLOOR()", "CEILING()", "MAX(,)", "MIN(,)", "AVERAGE(,)", "ABS()"];
  const SYS_VARS = ["{DEPT_BUDGET}", "{ALLOWANCE}", "{PETTY_CASH}"];

  function insertRaw(text: string) {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? formula.length;
    const end = ta?.selectionEnd ?? formula.length;
    const next = formula.slice(0, start) + text + formula.slice(end);
    setFormula(next);
    onChange({ formula: next });
    setTimeout(() => {
      if (!ta) return;
      const cursor = start + text.length;
      ta.selectionStart = cursor;
      ta.selectionEnd = cursor;
      ta.focus();
    }, 0);
  }

  function insertToken(label: string) {
    insertRaw(`{${label}}`);
  }

  return (
    <div className="flex flex-col gap-2.5">
      <textarea
        ref={textareaRef}
        rows={3}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)", fontSize: 12.5 }}
        value={formula}
        placeholder="{Quantity} * {Unit Price}"
        onChange={(e) => {
          setFormula(e.target.value);
          onChange({ formula: e.target.value });
        }}
      />
      <p style={{ fontSize: 11, color: "#71717A", lineHeight: 1.5, margin: 0 }}>
        Reference fields with <code style={{ background: "#F4F4F5", padding: "1px 4px", borderRadius: 3 }}>{"{Field Label}"}</code>. Supports arithmetic and math functions.
      </p>

      <div>
        <p style={{ fontSize: 11, color: "#A1A1AA", marginBottom: 5 }}>Functions:</p>
        <div className="flex flex-wrap gap-1.5">
          {FUNC_CHIPS.map((fn) => (
            <button
              key={fn}
              onClick={() => insertRaw(fn)}
              style={{ padding: "3px 9px", fontSize: 11, borderRadius: 9999, border: "1px solid #DBEAFE", background: "#EFF6FF", color: "#1D4ED8", cursor: "pointer", fontFamily: "var(--font-mono, monospace)" }}
            >
              {fn}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p style={{ fontSize: 11, color: "#A1A1AA", marginBottom: 5 }}>System variables:</p>
        <div className="flex flex-wrap gap-1.5">
          {SYS_VARS.map((v) => (
            <button
              key={v}
              onClick={() => insertRaw(v)}
              style={{ padding: "3px 9px", fontSize: 11, borderRadius: 9999, border: "1px solid #D1FAE5", background: "#ECFDF5", color: "#065F46", cursor: "pointer", fontFamily: "var(--font-mono, monospace)" }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {numericFields.length > 0 && (
        <div>
          <p style={{ fontSize: 11, color: "#A1A1AA", marginBottom: 5 }}>Fields:</p>
          <div className="flex flex-wrap gap-1.5">
            {numericFields.map((f) => (
              <button
                key={f.id}
                onClick={() => insertToken(f.label)}
                style={{ padding: "3px 9px", fontSize: 11, borderRadius: 9999, border: "1px solid #E4E4E7", background: "#FAFAFA", color: "#3F3F46", cursor: "pointer", fontFamily: "var(--font-mono, monospace)" }}
              >
                {"{" + f.label + "}"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FieldTab({ field, allFields, onChange, onDelete }: { field: PlacedField; allFields: PlacedField[]; onChange: (p: Partial<PlacedField>) => void; onDelete: () => void }) {
  const showOptions = field.kind === "select" || field.kind === "dept" || field.kind === "multi_select";
  const showPlaceholder = ["text", "email", "phone", "textarea", "number", "money", "checkbox"].includes(field.kind);
  const showMaxStars = field.kind === "rating";

  return (
    <div className="flex flex-col gap-3.5" style={{ padding: 16 }}>
      <label className="flex flex-col gap-1.5">
        <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Field Label</span>
        <input value={field.label} onChange={(e) => onChange({ label: e.target.value })} style={inputStyle} />
      </label>

      {field.kind !== "calculation" && (
        <div className="flex items-center justify-between rounded-md" style={{ padding: "10px 12px", border: "1px solid #E4E4E7" }}>
          <div>
            <div className="font-medium" style={{ fontSize: 12.5, color: "#18181B" }}>Required</div>
            <div style={{ fontSize: 11, color: "#A1A1AA" }}>Cannot submit without value</div>
          </div>
          <Toggle on={field.required} onChange={(v) => onChange({ required: v })} />
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Helper text</span>
        <input
          value={field.helper}
          placeholder="Optional guidance shown below the field"
          onChange={(e) => onChange({ helper: e.target.value })}
          style={inputStyle}
        />
      </label>

      {showPlaceholder && (
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Placeholder</span>
          <input
            value={field.placeholder ?? ""}
            placeholder="Shown inside the empty input"
            onChange={(e) => onChange({ placeholder: e.target.value })}
            style={inputStyle}
          />
        </label>
      )}

      {showOptions && (
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Options (one per line)</span>
          <OptionsEditor options={field.options ?? []} onChange={(opts) => onChange({ options: opts })} />
        </label>
      )}

      {field.kind === "calculation" && (
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Formula</span>
          <FormulaEditor field={field} allFields={allFields} onChange={onChange} />
        </label>
      )}

      {showMaxStars && (
        <label className="flex flex-col gap-1.5">
          <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Max stars</span>
          <div className="flex items-center gap-3">
            {[3, 5, 7, 10].map((n) => {
              const active = (field.validation?.maxStars ?? 5) === n;
              return (
                <button
                  key={n}
                  onClick={() => onChange({ validation: { ...field.validation, maxStars: n } })}
                  style={{
                    padding: "4px 12px",
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                    borderRadius: 6,
                    border: `1px solid ${active ? "var(--color-brand-500)" : "#E4E4E7"}`,
                    background: active ? "#FDE8F2" : "#fff",
                    color: active ? "var(--color-brand-500)" : "#52525B",
                    cursor: "pointer",
                  }}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </label>
      )}

      <div style={{ borderTop: "1px solid #F4F4F5", paddingTop: 12, marginTop: 4 }}>
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 cursor-pointer"
          style={{ fontSize: 12, color: "#71717A", background: "transparent", border: "none" }}
        >
          <Trash size={12} /> Delete field
        </button>
      </div>
    </div>
  );
}

function ValidationTab({ field, onChange }: { field: PlacedField; onChange: (p: Partial<PlacedField>) => void }) {
  const isText = ["text", "textarea", "email", "phone"].includes(field.kind);
  const isNumeric = ["number", "money"].includes(field.kind);
  const isSelect = ["select", "multi_select"].includes(field.kind);

  const val = field.validation ?? {};

  if (!isText && !isNumeric && !isSelect) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center" }}>
        <p style={{ fontSize: 12.5, color: "#A1A1AA", lineHeight: 1.6 }}>
          No validation options available for <strong>{field.kind}</strong> fields.
        </p>
      </div>
    );
  }

  function patch(v: Partial<PlacedField["validation"]>) {
    onChange({ validation: { ...val, ...v } });
  }

  return (
    <div className="flex flex-col gap-4" style={{ padding: 16 }}>
      {isText && (
        <>
          <div className="flex flex-col gap-1.5">
            <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Character limits</span>
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1">
                <span style={{ fontSize: 10.5, color: "#71717A" }}>Min</span>
                <input
                  type="number"
                  min={0}
                  style={numInputStyle}
                  value={val.minLength ?? ""}
                  placeholder="—"
                  onChange={(e) => patch({ minLength: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
              <span style={{ marginTop: 18, color: "#D4D4D8" }}>—</span>
              <div className="flex flex-col gap-1">
                <span style={{ fontSize: 10.5, color: "#71717A" }}>Max</span>
                <input
                  type="number"
                  min={0}
                  style={numInputStyle}
                  value={val.maxLength ?? ""}
                  placeholder="—"
                  onChange={(e) => patch({ maxLength: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Pattern (regex)</span>
            <input
              style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
              value={val.pattern ?? ""}
              placeholder="e.g. ^[A-Z]{3}-\d{4}$"
              onChange={(e) => patch({ pattern: e.target.value || undefined })}
            />
            <span style={{ fontSize: 11, color: "#A1A1AA" }}>Leave blank for no pattern constraint</span>
          </label>
        </>
      )}

      {isNumeric && (
        <div className="flex flex-col gap-1.5">
          <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>
            Value range
          </span>
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-1">
              <span style={{ fontSize: 10.5, color: "#71717A" }}>Min</span>
              <input
                type="number"
                style={numInputStyle}
                value={val.min ?? ""}
                placeholder="—"
                onChange={(e) => patch({ min: e.target.value ? Number(e.target.value) : undefined })}
              />
            </div>
            <span style={{ marginTop: 18, color: "#D4D4D8" }}>—</span>
            <div className="flex flex-col gap-1">
              <span style={{ fontSize: 10.5, color: "#71717A" }}>Max</span>
              <input
                type="number"
                style={numInputStyle}
                value={val.max ?? ""}
                placeholder="—"
                onChange={(e) => patch({ max: e.target.value ? Number(e.target.value) : undefined })}
              />
            </div>
          </div>
          {field.kind === "money" && (
            <p style={{ fontSize: 11, color: "#A1A1AA", marginTop: 4 }}>
              The slab routing (Finance Routing tab) uses separate thresholds.
            </p>
          )}
        </div>
      )}

      {isSelect && (
        <div className="flex flex-col gap-1.5">
          <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3F3F46" }}>Selection limits</span>
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-1">
              <span style={{ fontSize: 10.5, color: "#71717A" }}>Min choices</span>
              <input
                type="number"
                min={0}
                style={numInputStyle}
                value={val.min ?? ""}
                placeholder="—"
                onChange={(e) => patch({ min: e.target.value ? Number(e.target.value) : undefined })}
              />
            </div>
            <span style={{ marginTop: 18, color: "#D4D4D8" }}>—</span>
            <div className="flex flex-col gap-1">
              <span style={{ fontSize: 10.5, color: "#71717A" }}>Max choices</span>
              <input
                type="number"
                min={0}
                style={numInputStyle}
                value={val.max ?? ""}
                placeholder="—"
                onChange={(e) => patch({ max: e.target.value ? Number(e.target.value) : undefined })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RoutingTab({ field, formTemplateId }: { field: PlacedField; formTemplateId?: string | null }) {
  if (field.kind === "money") {
    return (
      <div>
        <div style={{ padding: "12px 16px 8px" }}>
          <div className="rounded-md flex items-center gap-2" style={{ padding: "8px 10px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
            <span style={{ fontSize: 11.5, color: "#92400E", lineHeight: 1.45 }}>
              The finance approver is selected automatically based on the amount the submitter enters.
            </span>
          </div>
        </div>
        <SlabTable formTemplateId={formTemplateId} />
      </div>
    );
  }

  return (
    <div style={{ padding: "40px 20px", textAlign: "center" }}>
      <p style={{ fontSize: 12.5, color: "#A1A1AA", lineHeight: 1.6, margin: 0 }}>
        No routing rules apply to this field type.
      </p>
      <p style={{ fontSize: 11.5, color: "#C4C4C4", lineHeight: 1.5, margin: "8px 0 0" }}>
        Add a <strong>Money Amount</strong> field to enable slab-based finance approver routing.
      </p>
    </div>
  );
}

export function ConfigPanel({
  field,
  onChange,
  onDelete,
  allFields = [],
  formTemplateId,
}: {
  field: PlacedField | null;
  onChange: (patch: Partial<PlacedField>) => void;
  onDelete: () => void;
  allFields?: PlacedField[];
  formTemplateId?: string | null;
}) {
  const [tab, setTab] = useState<Tab>("field");

  const tabs: { id: Tab; label: string }[] = [
    { id: "field", label: "Field" },
    { id: "validation", label: "Validation" },
    { id: "routing", label: "Routing" },
  ];

  return (
    <aside
      key={field?.id ?? "none"}
      className="w-[360px] shrink-0 flex flex-col h-full bg-white"
      style={{ borderLeft: "1px solid #E4E4E7" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2" style={{ padding: "14px 16px", borderBottom: "1px solid #E4E4E7" }}>
        <Settings size={14} style={{ color: "#18181B" }} />
        <span className="font-semibold" style={{ fontSize: 13, color: "#18181B" }}>
          Configuration
        </span>
        <span className="ml-auto truncate max-w-[140px]" style={{ fontSize: 11, color: "#A1A1AA" }}>
          {field ? field.label : "No field selected"}
        </span>
      </div>

      {!field ? (
        <div className="text-center" style={{ padding: "48px 24px", fontSize: 12.5, color: "#A1A1AA" }}>
          Select a field on the canvas to configure it.
        </div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="flex" style={{ borderBottom: "1px solid #E4E4E7" }}>
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="flex-1 cursor-pointer"
                style={{
                  padding: "9px 4px",
                  fontSize: 12,
                  fontWeight: tab === t.id ? 600 : 400,
                  color: tab === t.id ? "var(--color-brand-500)" : "#71717A",
                  background: "transparent",
                  border: "none",
                  borderBottom: `2px solid ${tab === t.id ? "var(--color-brand-500)" : "transparent"}`,
                  transition: "color 100ms, border-color 100ms",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="scroll-thin flex-1 overflow-auto">
            {tab === "field" && <FieldTab field={field} allFields={allFields} onChange={onChange} onDelete={onDelete} />}
            {tab === "validation" && <ValidationTab field={field} onChange={onChange} />}
            {tab === "routing" && <RoutingTab field={field} formTemplateId={formTemplateId} />}
          </div>
        </>
      )}
    </aside>
  );
}
