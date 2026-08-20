import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  Calendar,
  CalendarRange,
  ChevronDown,
  Copy,
  FileUp,
  GripVertical,
  Link2,
  Mail,
  Pen,
  Phone,
  Plus,
  Star,
  User,
  X,
  Zap,
} from "lucide-react";
import { PALETTE, isEmbedded, isSmart, isLayout, isPermission } from "./palette";
import type { FieldKind, PlacedField } from "./types";

function iconForKind(kind: FieldKind) {
  for (const sec of PALETTE) {
    const found = sec.items.find((i) => i.kind === kind);
    if (found) return found.Icon;
  }
  return null;
}

function isAccent(kind: FieldKind) {
  return isSmart(kind) || isEmbedded(kind);
}

function Chip({
  children,
  color = "pink",
  icon: Icon,
}: {
  children: React.ReactNode;
  color?: "pink" | "blue" | "amber" | "zinc";
  icon?: React.ComponentType<{ size?: number }>;
}) {
  const palettes: Record<string, { bg: string; fg: string; bd: string }> = {
    pink: { bg: "#FDE8F2", fg: "#C40F5E", bd: "#F79BC4" },
    blue: { bg: "#EFF6FF", fg: "#1D4ED8", bd: "#BFDBFE" },
    amber: { bg: "#FFFBEB", fg: "#B45309", bd: "#FDE68A" },
    zinc: { bg: "#F4F4F5", fg: "#52525B", bd: "#E4E4E7" },
  };
  const p = palettes[color];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full font-medium"
      style={{
        padding: "2px 8px",
        fontSize: 11,
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.bd}`,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
    >
      {Icon && <Icon size={11} />}
      {children}
    </span>
  );
}

function SectionHeaderCard({
  field,
  selected,
  onSelect,
  onDelete,
  onDuplicate,
}: {
  field: PlacedField;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        cursor: "pointer",
        position: "relative",
        paddingLeft: 20,
      }}
      onClick={onSelect}
    >
      <div
        {...attributes}
        {...listeners}
        className="absolute cursor-grab"
        style={{ left: -2, top: "50%", transform: "translateY(-50%)", color: "#D4D4D8", touchAction: "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={14} />
      </div>
      <div
        className="flex items-center gap-3 rounded-lg"
        style={{
          padding: "10px 14px",
          border: `1px solid ${selected ? "var(--color-brand-500)" : "#E4E4E7"}`,
          background: selected ? "#FFF6FA" : "#FAFAFA",
          boxShadow: selected ? "0 0 0 3px rgba(226,19,110,0.08)" : undefined,
        }}
      >
        <div style={{ flex: 1, height: 1, background: "#D4D4D8" }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "#52525B", letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
          {field.label}
        </span>
        <div style={{ flex: 1, height: 1, background: "#D4D4D8" }} />
        <button
          onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
          title="Duplicate"
          className="inline-flex items-center justify-center rounded cursor-pointer"
          style={{ width: 24, height: 24, color: "#A1A1AA", background: "transparent", border: "none" }}
        >
          <Copy size={13} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete"
          className="inline-flex items-center justify-center rounded cursor-pointer"
          style={{ width: 24, height: 24, color: "#A1A1AA", background: "transparent", border: "none" }}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function PlacedCard({
  field,
  selected,
  onSelect,
  onDelete,
  onDuplicate,
}: {
  field: PlacedField;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  if (isLayout(field.kind)) {
    return (
      <SectionHeaderCard
        field={field}
        selected={selected}
        onSelect={onSelect}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
      />
    );
  }

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });

  const Icon = iconForKind(field.kind);
  const accent = isAccent(field.kind);
  const linked = isEmbedded(field.kind);
  const smart = isSmart(field.kind);
  const isMoney = field.kind === "money";

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    background: "#fff",
    border: `1px solid ${selected ? "var(--color-brand-500)" : accent ? "#FBC5DF" : "#E4E4E7"}`,
    borderRadius: 10,
    padding: "14px 16px",
    boxShadow: selected ? "0 0 0 3px rgba(226,19,110,0.10)" : undefined,
    cursor: "pointer",
    position: "relative",
  };

  return (
    <div ref={setNodeRef} style={style} onClick={onSelect} className="placed-field">
      <div
        {...attributes}
        {...listeners}
        className="absolute cursor-grab"
        style={{ left: -22, top: 18, color: "#D4D4D8", touchAction: "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={14} />
      </div>

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
        {smart && <Chip color="pink" icon={Zap}>Smart</Chip>}
        {linked && <Chip color="pink" icon={Link2}>Embedded</Chip>}

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
            title="Duplicate field"
            className="inline-flex items-center justify-center rounded-md cursor-pointer"
            style={{ width: 24, height: 24, color: "#A1A1AA", background: "transparent", border: "none" }}
          >
            <Copy size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete field"
            className="inline-flex items-center justify-center rounded-md cursor-pointer"
            style={{ width: 24, height: 24, color: "#A1A1AA", background: "transparent", border: "none" }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {isMoney && (
        <div
          className="mb-3 flex items-start gap-2 rounded-md"
          style={{ padding: "8px 10px", background: "#FFFBEB", border: "1px solid #FDE68A" }}
        >
          <AlertTriangle size={13} style={{ color: "#B45309", marginTop: 1 }} />
          <div style={{ fontSize: 11.5, color: "#92400E", lineHeight: 1.45 }}>
            <strong>Slab routing active</strong> — Finance approver auto-added based on amount.
          </div>
        </div>
      )}

      {renderPreview(field)}

      {field.helper && (
        <div className="mt-2" style={{ fontSize: 11, color: "#71717A" }}>
          {field.helper}
        </div>
      )}
    </div>
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
};

function renderPreview(field: PlacedField) {
  const k = field.kind;

  if (k === "text") {
    return <input style={inputStyle} placeholder={field.placeholder || "Enter value…"} readOnly />;
  }
  if (k === "email") {
    return (
      <div style={{ position: "relative" }}>
        <input style={{ ...inputStyle, paddingLeft: 34 }} placeholder={field.placeholder || "name@example.com"} readOnly />
        <Mail size={13} style={{ position: "absolute", left: 10, top: 11, color: "#A1A1AA" }} />
      </div>
    );
  }
  if (k === "phone") {
    return (
      <div style={{ position: "relative" }}>
        <input style={{ ...inputStyle, paddingLeft: 34 }} placeholder={field.placeholder || "+880 1X-XXXXXXXX"} readOnly />
        <Phone size={13} style={{ position: "absolute", left: 10, top: 11, color: "#A1A1AA" }} />
      </div>
    );
  }
  if (k === "number" || k === "money") {
    return (
      <input
        style={inputStyle}
        placeholder={field.placeholder || (k === "money" ? "0.00" : "0")}
        readOnly
      />
    );
  }
  if (k === "textarea") {
    return (
      <div style={{ ...inputStyle, minHeight: 72, color: "#A1A1AA", fontStyle: "italic" }}>
        {field.placeholder || "Brief description…"}
      </div>
    );
  }
  if (k === "date") {
    return (
      <div style={{ ...inputStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "#A1A1AA" }}>YYYY-MM-DD</span>
        <Calendar size={13} style={{ color: "#A1A1AA" }} />
      </div>
    );
  }
  if (k === "daterange") {
    return (
      <div style={{ ...inputStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "#A1A1AA" }}>From → To</span>
        <CalendarRange size={13} style={{ color: "#A1A1AA" }} />
      </div>
    );
  }
  if (k === "select" || k === "dept") {
    const opts = field.options || [];
    return (
      <>
        <div style={{ ...inputStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: opts[0] ? "#18181B" : "#A1A1AA" }}>{opts[0] || "Select…"}</span>
          <ChevronDown size={13} style={{ color: "#A1A1AA" }} />
        </div>
        {opts.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {opts.slice(0, 5).map((o, i) => (
              <span
                key={o + i}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 9999,
                  background: i === 0 ? "#FDE8F2" : "#F4F4F5",
                  color: i === 0 ? "#C40F5E" : "#71717A",
                  border: `1px solid ${i === 0 ? "#FBC5DF" : "#E4E4E7"}`,
                }}
              >
                {o}
              </span>
            ))}
            {opts.length > 5 && (
              <span style={{ fontSize: 11, color: "#A1A1AA" }}>+{opts.length - 5} more</span>
            )}
          </div>
        )}
      </>
    );
  }
  if (k === "multi_select") {
    const opts = field.options || ["Option A", "Option B", "Option C"];
    return (
      <div className="flex flex-col gap-2">
        {opts.slice(0, 4).map((o, i) => (
          <label key={o + i} className="flex items-center gap-2" style={{ fontSize: 12.5, color: "#3F3F46", cursor: "default" }}>
            <input type="checkbox" disabled defaultChecked={i === 0} readOnly style={{ accentColor: "var(--color-brand-500)" }} />
            {o}
          </label>
        ))}
        {opts.length > 4 && <span style={{ fontSize: 11, color: "#A1A1AA" }}>+{opts.length - 4} more options</span>}
      </div>
    );
  }
  if (k === "rating") {
    const maxStars = field.validation?.maxStars ?? 5;
    return (
      <div className="flex items-center gap-1">
        {Array.from({ length: maxStars }).map((_, i) => (
          <Star
            key={i}
            size={20}
            style={{ color: i < 3 ? "#F59E0B" : "#D4D4D8" }}
            fill={i < 3 ? "#F59E0B" : "none"}
          />
        ))}
        <span style={{ fontSize: 11, color: "#A1A1AA", marginLeft: 6 }}>3 / {maxStars}</span>
      </div>
    );
  }
  if (k === "checkbox") {
    return (
      <label className="flex items-center gap-2" style={{ fontSize: 13, color: "#3F3F46", cursor: "default" }}>
        <input type="checkbox" disabled readOnly style={{ accentColor: "var(--color-brand-500)" }} />
        <span>{field.placeholder || "I confirm the above"}</span>
      </label>
    );
  }
  if (k === "file") {
    return (
      <div
        className="flex items-center gap-3 rounded-lg"
        style={{ padding: "14px", border: "1px dashed #D4D4D8", background: "#FAFAFA" }}
      >
        <span
          className="inline-flex items-center justify-center rounded-md"
          style={{ width: 32, height: 32, background: "#fff", border: "1px solid #E4E4E7", color: "#52525B" }}
        >
          <FileUp size={15} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "#18181B", fontWeight: 500 }}>Drag &amp; drop or click to upload</div>
          <div style={{ fontSize: 11.5, color: "#71717A", marginTop: 2 }}>
            {field.helper || "Accepts PDF, DOCX · max 10MB"}
          </div>
        </div>
      </div>
    );
  }
  if (k === "employee") {
    return (
      <div
        className="rounded-md flex items-center gap-2.5"
        style={{ padding: "10px 12px", border: "1px solid #E4E4E7", background: "#FAFAFA" }}
      >
        <span
          className="inline-flex items-center justify-center rounded-full"
          style={{ width: 28, height: 28, background: "#FDE8F2", color: "#C40F5E" }}
        >
          <User size={13} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, color: "#18181B", fontWeight: 500 }}>Employee lookup</div>
          <div style={{ fontSize: 11.5, color: "#71717A" }}>Type Employee ID to auto-fill</div>
        </div>
        <Chip color="blue" icon={Zap}>LDAP</Chip>
      </div>
    );
  }
  if (k === "signature") {
    return (
      <div
        className="rounded-md flex items-center justify-center gap-2"
        style={{ padding: "20px", border: "1px dashed #D4D4D8", background: "#FAFAFA", color: "#A1A1AA", fontSize: 12 }}
      >
        <Pen size={13} />
        <span>Type to sign</span>
      </div>
    );
  }
  if (k.startsWith("gen_")) {
    return (
      <div
        className="rounded-md"
        style={{ padding: "10px 12px", background: "#FAFAFA", border: "1px solid #E4E4E7", fontSize: 12.5, color: "#71717A", fontStyle: "italic" }}
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
      <div className="rounded-lg" style={{ padding: "12px 14px", border: "1px dashed #FBC5DF", background: "#FFF6FA" }}>
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex items-center justify-center rounded-md"
            style={{ width: 28, height: 28, background: "#fff", border: "1px solid #FBC5DF", color: "#C40F5E" }}
          >
            <Link2 size={13} />
          </span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>{labels[k]}</div>
            <div style={{ fontSize: 11.5, color: "#71717A" }}>Auto-creates a linked submission on save</div>
          </div>
        </div>
      </div>
    );
  }
  // permissions
  return (
    <div className="rounded-md font-mono" style={{ padding: "10px 12px", background: "#FAFAFA", border: "1px solid #E4E4E7", fontSize: 12, color: "#52525B" }}>
      {k === "perm_visibility" ? "show_if: <condition>" : k === "perm_edit" ? "editable_by: <role>" : "required_if: <condition>"}
    </div>
  );
}

export function Canvas({
  fields,
  selectedId,
  onSelect,
  onDelete,
  onDuplicate,
}: {
  fields: PlacedField[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "canvas-dropzone" });

  const dataFields = fields.filter((f) => !isPermission(f.kind) && !isLayout(f.kind));
  const smartCount = dataFields.filter((f) => isSmart(f.kind)).length;
  const embeddedCount = dataFields.filter((f) => isEmbedded(f.kind)).length;
  const basicCount = dataFields.length - smartCount - embeddedCount;
  const layoutCount = fields.filter((f) => isLayout(f.kind)).length;

  return (
    <div className="canvas-bg scroll-thin flex-1 overflow-auto" style={{ padding: "32px 56px 80px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        {/* Stats bar */}
        <div className="mb-5 flex items-center gap-2.5 flex-wrap">
          <span className="uppercase font-semibold" style={{ fontSize: 10.5, letterSpacing: "0.10em", color: "#71717A" }}>
            Form canvas
          </span>
          <span style={{ color: "#E4E4E7" }}>·</span>
          <span style={{ fontSize: 11, color: "#A1A1AA" }}>
            {dataFields.length} data field{dataFields.length !== 1 ? "s" : ""}
          </span>
          {dataFields.length > 0 && (
            <>
              <span style={{ color: "#E4E4E7" }}>·</span>
              {basicCount > 0 && (
                <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 9999, background: "#F4F4F5", color: "#52525B", border: "1px solid #E4E4E7" }}>
                  Basic: {basicCount}
                </span>
              )}
              {smartCount > 0 && (
                <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 9999, background: "#FDE8F2", color: "#C40F5E", border: "1px solid #F79BC4" }}>
                  Smart: {smartCount}
                </span>
              )}
              {embeddedCount > 0 && (
                <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 9999, background: "#FFF6FA", color: "#BE185D", border: "1px solid #FBC5DF" }}>
                  Embedded: {embeddedCount}
                </span>
              )}
              {layoutCount > 0 && (
                <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 9999, background: "#F4F4F5", color: "#71717A", border: "1px solid #E4E4E7" }}>
                  Sections: {layoutCount}
                </span>
              )}
            </>
          )}
        </div>

        <div ref={setNodeRef} className="flex flex-col gap-3.5">
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {fields.map((f) => (
              <PlacedCard
                key={f.id}
                field={f}
                selected={selectedId === f.id}
                onSelect={() => onSelect(f.id)}
                onDelete={() => onDelete(f.id)}
                onDuplicate={() => onDuplicate(f.id)}
              />
            ))}
          </SortableContext>

          <div
            className="flex items-center justify-center gap-2 rounded-[10px]"
            style={{
              marginTop: 6,
              padding: "20px 14px",
              border: `1.5px dashed ${isOver ? "var(--color-brand-500)" : "#D4D4D8"}`,
              background: isOver ? "#FFF6FA" : "rgba(255,255,255,0.6)",
              color: isOver ? "#C40F5E" : "#A1A1AA",
              fontSize: 13,
              transition: "all 120ms",
            }}
          >
            <Plus size={14} />
            {fields.length === 0 ? "Drag a field here to begin" : "Drop field here"}
          </div>
        </div>
      </div>
    </div>
  );
}
