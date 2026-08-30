import { useState } from "react";
import { ChevronRight, GripVertical, Layers, Link2, Search, X } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { PALETTE } from "./palette";
import type { PaletteItem, PaletteSection } from "./types";

function SlabChip() {
  return (
    <span
      className="inline-flex items-center rounded-full font-medium"
      style={{ padding: "1px 7px", fontSize: 10, background: "var(--color-brand-50, #EEF2FF)", color: "#4338CA", border: "1px solid #C7D2FE", lineHeight: 1.3 }}
    >
      Slab
    </span>
  );
}

function DraggablePaletteItem({ item, accent }: { item: PaletteItem; accent?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${item.kind}`,
    data: { from: "palette", kind: item.kind, label: item.label },
  });
  const Icon = item.Icon;
  const isLinked = item.linked;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="field-card flex items-center gap-2.5 rounded-lg cursor-grab relative"
      style={{
        padding: "8px 10px",
        border: `1px solid ${isLinked ? "#C7D2FE" : "#E4E4E7"}`,
        background: isLinked ? "#F5F7FF" : "#fff",
        opacity: isDragging ? 0.4 : 1,
        touchAction: "none",
      }}
    >
      <span className="drag-handle inline-flex shrink-0" style={{ opacity: 0, transition: "opacity 120ms", color: "#A1A1AA" }}>
        <GripVertical size={14} />
      </span>
      <span
        className="inline-flex items-center justify-center rounded-md shrink-0"
        style={{
          width: 24,
          height: 24,
          background: isLinked ? "#EEF2FF" : accent ? "#EEF2FF" : "#F4F4F5",
          color: isLinked ? "#4338CA" : accent ? "#4338CA" : "#52525B",
        }}
      >
        {isLinked ? <Link2 size={13} /> : <Icon size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium" style={{ fontSize: 12.5, lineHeight: 1.25, color: "#18181B", display: "flex", alignItems: "center", gap: 6 }}>
          <span className="truncate">{item.label}</span>
          {item.slab && <SlabChip />}
        </div>
        {item.hint && (
          <div className="mt-0.5" style={{ fontSize: 10.5, color: "#A1A1AA", lineHeight: 1.3 }}>
            {item.hint}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ section, openByDefault }: { section: PaletteSection; openByDefault: boolean }) {
  const [open, setOpen] = useState(openByDefault);
  const Icon = section.Icon;
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 cursor-pointer"
        style={{ padding: "8px 10px", color: "#3F3F46", background: "transparent", border: "none" }}
      >
        <span className="inline-flex items-center justify-center" style={{ width: 18, height: 18, color: section.accent ? "var(--color-brand-500)" : "#52525B" }}>
          <Icon size={14} />
        </span>
        <span className="uppercase font-semibold" style={{ fontSize: 11, letterSpacing: "0.08em", color: section.accent ? "#4338CA" : "#52525B" }}>
          {section.title}
        </span>
        <span className="ml-auto inline-flex" style={{ color: "#A1A1AA", transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms" }}>
          <ChevronRight size={14} />
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5" style={{ padding: "4px 6px 8px" }}>
          {section.items.map((item) => (
            <DraggablePaletteItem key={item.kind} item={item} accent={section.accent} />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchResults({ query }: { query: string }) {
  const q = query.toLowerCase();
  const allItems: (PaletteItem & { sectionAccent?: boolean })[] = [];
  for (const sec of PALETTE) {
    for (const item of sec.items) {
      if (
        item.label.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q) ||
        (item.hint?.toLowerCase().includes(q) ?? false)
      ) {
        allItems.push({ ...item, sectionAccent: sec.accent });
      }
    }
  }

  if (allItems.length === 0) {
    return (
      <div style={{ padding: "24px 12px", textAlign: "center", fontSize: 12.5, color: "#A1A1AA" }}>
        No fields match "{query}"
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" style={{ padding: "8px 6px" }}>
      {allItems.map((item) => (
        <DraggablePaletteItem key={item.kind} item={item} accent={item.sectionAccent} />
      ))}
    </div>
  );
}

export function FieldPalette() {
  const [query, setQuery] = useState("");

  return (
    <aside className="w-[280px] shrink-0 flex flex-col h-full" style={{ background: "#FAFAFA", borderRight: "1px solid #E4E4E7" }}>
      <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #E4E4E7" }}>
        <div className="flex items-center gap-2 mb-2.5">
          <Layers size={14} style={{ color: "#18181B" }} />
          <span className="font-semibold" style={{ fontSize: 13, color: "#18181B" }}>Field Library</span>
        </div>
        <div className="flex items-center gap-2 bg-white rounded-md" style={{ padding: "7px 10px", border: "1px solid #E4E4E7" }}>
          <Search size={13} style={{ color: "#A1A1AA", flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields…"
            className="flex-1 bg-transparent outline-none font-sans"
            style={{ fontSize: 12, color: "#18181B" }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#A1A1AA", padding: 0, display: "flex" }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="scroll-thin flex-1 overflow-auto" style={{ padding: "8px 4px" }}>
        {query ? (
          <SearchResults query={query} />
        ) : (
          PALETTE.map((s, i) => (
            <Section key={s.id} section={s} openByDefault={i < 3} />
          ))
        )}
      </div>
    </aside>
  );
}
