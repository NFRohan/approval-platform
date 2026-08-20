import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { Code2, Download, Eye, Upload } from "lucide-react";
import { z } from "zod";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { FieldPalette } from "@/components/builder/FieldPalette";
import { Canvas } from "@/components/builder/Canvas";
import { ConfigPanel } from "@/components/builder/ConfigPanel";
import { BuilderChrome, PrimaryButton, SecondaryButton } from "@/components/builder/BuilderChrome";
import { LivePreview } from "@/components/builder/LivePreview";
import { DEFAULT_LABELS, DEFAULT_OPTIONS } from "@/components/builder/palette";
import type { FieldKind, PlacedField } from "@/components/builder/types";
import { toast } from "sonner";

const DEFAULT_FORM_NAME = "Employee Departure Due Diligence Form";

const builderSearch = z.object({
  templateId: z.string().optional(),
});

export const Route = createFileRoute("/builder/")({
  validateSearch: builderSearch,
  head: () => ({
    meta: [
      { title: "Form Builder · Admin Services Portal" },
      { name: "description", content: "Design forms with smart fields, slab routing, and embedded sub-forms." },
    ],
  }),
  component: BuilderPage,
});

type FieldConfig = {
  helper?: string;
  options?: string[];
  placeholder?: string;
  validation?: PlacedField["validation"];
};

function InitOverlay({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col relative" style={{ minWidth: 0 }}>
      {children}
      {active && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.75)", backdropFilter: "blur(2px)", zIndex: 10 }}
        >
          <div className="flex items-center gap-2.5 rounded-xl" style={{ padding: "12px 20px", background: "#fff", border: "1px solid #E4E4E7", boxShadow: "0 2px 12px rgba(0,0,0,0.06)", fontSize: 13, color: "#52525B" }}>
            <span
              className="inline-block rounded-full"
              style={{ width: 14, height: 14, border: "2px solid #E4E4E7", borderTopColor: "var(--color-brand-500)", animation: "spin 0.7s linear infinite" }}
            />
            Setting up form…
          </div>
        </div>
      )}
    </div>
  );
}

function BuilderPage() {
  const { currentUser } = useCurrentUser();
  const navigate = useNavigate();
  const search = Route.useSearch();

  const [templateId, setTemplateId] = useState<string | null>(search.templateId ?? null);
  const [formName, setFormName] = useState(DEFAULT_FORM_NAME);
  const [fields, setFields] = useState<PlacedField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedAgo, setSavedAgo] = useState<string>("just now");
  const [isPreview, setIsPreview] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  // True only on the very first load when we haven't yet created/loaded the template
  const [isInitializing, setIsInitializing] = useState(!search.templateId);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (search.templateId) {
        const { data } = await db
          .from("form_templates")
          .select("id, name")
          .eq("id", search.templateId)
          .maybeSingle();
        if (cancelled || !data) return;
        setTemplateId(data.id);
        setFormName(data.name);
        const { data: existing } = await db
          .from("form_fields")
          .select("*")
          .eq("form_template_id", data.id)
          .order("order_index");
        if (cancelled) return;
        setFields(
          (existing ?? []).map((row) => {
            const cfg = (row.field_config as FieldConfig | null) ?? {};
            const kind = (row.field_type ?? "text") as FieldKind;
            return {
              id: row.id,
              kind,
              label: row.field_name ?? DEFAULT_LABELS[kind] ?? "Field",
              required: row.is_required ?? false,
              helper: cfg.helper ?? "",
              options: cfg.options,
              placeholder: cfg.placeholder,
              validation: cfg.validation,
              formula: (cfg as { formula?: string }).formula,
              order_index: row.order_index ?? 0,
            };
          }),
        );
        setIsInitializing(false);
        return;
      }

      const { data, error } = await db
        .from("form_templates")
        .insert({
          name: DEFAULT_FORM_NAME,
          status: "draft",
          category: "HR",
          created_by: currentUser.employee_id,
        })
        .select("id")
        .single();
      if (cancelled) return;
      if (error) {
        toast.error("Could not create draft form: " + error.message);
        setIsInitializing(false);
        return;
      }
      setTemplateId(data.id);
      setIsInitializing(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedField = fields.find((f) => f.id === selectedId) ?? null;

  async function persistInsert(field: PlacedField) {
    if (!templateId) return;
    const { error } = await db.from("form_fields").insert({
      id: field.id,
      form_template_id: templateId,
      field_name: field.label,
      field_type: field.kind,
      is_required: field.required,
      order_index: field.order_index,
      field_config: { helper: field.helper, options: field.options, placeholder: field.placeholder, validation: field.validation, formula: field.formula },
    });
    if (error) toast.error("Failed to save field: " + error.message);
    else setSavedAgo("just now");
  }

  async function persistUpdate(field: PlacedField) {
    if (!templateId) return;
    const { error } = await db
      .from("form_fields")
      .update({
        field_name: field.label,
        is_required: field.required,
        order_index: field.order_index,
        field_config: { helper: field.helper, options: field.options, placeholder: field.placeholder, validation: field.validation, formula: field.formula },
      })
      .eq("id", field.id);
    if (!error) setSavedAgo("just now");
  }

  async function persistDelete(id: string) {
    await db.from("form_fields").delete().eq("id", id);
  }

  async function persistReorder(next: PlacedField[]) {
    if (!templateId) return;
    await Promise.all(
      next.map((f, i) => db.from("form_fields").update({ order_index: i }).eq("id", f.id)),
    );
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over) return;

    const fromPalette = active.data.current?.from === "palette";
    if (fromPalette) {
      const kind = active.data.current?.kind as FieldKind;
      const newField: PlacedField = {
        id: crypto.randomUUID(),
        kind,
        label: DEFAULT_LABELS[kind],
        required: false,
        helper: "",
        options: DEFAULT_OPTIONS[kind] ? [...DEFAULT_OPTIONS[kind]!] : undefined,
        placeholder: undefined,
        order_index: fields.length,
      };
      const next = [...fields, newField];
      setFields(next);
      setSelectedId(newField.id);
      void persistInsert(newField);
      return;
    }

    if (active.id !== over.id) {
      const oldIndex = fields.findIndex((f) => f.id === active.id);
      const newIndex = fields.findIndex((f) => f.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(fields, oldIndex, newIndex).map((f, i) => ({ ...f, order_index: i }));
      setFields(next);
      void persistReorder(next);
    }
  }

  function updateSelected(patch: Partial<PlacedField>) {
    if (!selectedField) return;
    const updated: PlacedField = { ...selectedField, ...patch };
    setFields((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
    void persistUpdate(updated);
  }

  function deleteField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
    void persistDelete(id);
  }

  function duplicateField(id: string) {
    const idx = fields.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const original = fields[idx];
    const newField: PlacedField = {
      ...original,
      id: crypto.randomUUID(),
      label: original.label + " (Copy)",
      order_index: idx + 1,
    };
    const before = fields.slice(0, idx + 1);
    const after = fields.slice(idx + 1);
    const next = [...before, newField, ...after].map((f, i) => ({ ...f, order_index: i }));
    setFields(next);
    setSelectedId(newField.id);
    void persistInsert(newField);
    void persistReorder(next);
  }

  function handleNext() {
    if (fields.length === 0) {
      toast.warning("Add at least one field before continuing.");
      return;
    }
    if (!templateId) return;
    navigate({ to: "/builder/approvers", search: { templateId } });
  }

  function handleExport() {
    if (fields.length === 0) {
      toast.warning("Add some fields first before exporting.");
      return;
    }
    const payload = {
      version: 1,
      formName,
      exportedAt: new Date().toISOString(),
      fields: fields.map(({ id: _id, order_index: _order, ...rest }) => rest),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${formName.replace(/\s+/g, "-").toLowerCase()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported "${formName}"`);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !templateId) return;

    let parsed: { version: number; formName?: string; fields: Omit<PlacedField, "id" | "order_index">[] };
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast.error("Could not parse file — make sure it's a valid JSON export.");
      return;
    }

    if (parsed.version !== 1 || !Array.isArray(parsed.fields)) {
      toast.error("Unrecognised format. Export a form first, then import that file.");
      return;
    }

    // Delete existing fields
    await db.from("form_fields").delete().eq("form_template_id", templateId);

    // Assign fresh IDs and order
    const newFields: PlacedField[] = parsed.fields.map((f, i) => ({
      ...f,
      id: crypto.randomUUID(),
      order_index: i,
    }));

    if (newFields.length > 0) {
      const rows = newFields.map((field) => ({
        id: field.id,
        form_template_id: templateId,
        field_name: field.label,
        field_type: field.kind,
        is_required: field.required,
        order_index: field.order_index,
        field_config: {
          helper: field.helper,
          options: field.options,
          placeholder: field.placeholder,
          validation: field.validation,
        },
      }));
      const { error } = await db.from("form_fields").insert(rows);
      if (error) {
        toast.error("Failed to import: " + error.message);
        return;
      }
    }

    // Update form name from file if provided
    if (parsed.formName && parsed.formName !== formName) {
      setFormName(parsed.formName);
      await db.from("form_templates").update({ name: parsed.formName }).eq("id", templateId);
    }

    setFields(newFields);
    setSelectedId(null);
    setSavedAgo("just now");
    toast.success(`Imported ${newFields.length} field${newFields.length !== 1 ? "s" : ""} from "${file.name}"`);
  }

  return (
    <BuilderChrome
      step={1}
      formName={formName}
      onFormNameChange={setFormName}
      onFormNameBlur={async () => {
        if (!templateId) return;
        await db.from("form_templates").update({ name: formName }).eq("id", templateId);
        setSavedAgo("just now");
      }}
      savedAgo={savedAgo}
      leftActions={
        <>
          <input
            ref={importFileRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={handleImport}
          />
          <SecondaryButton onClick={() => importFileRef.current?.click()}>
            <Upload size={13} /> Import
          </SecondaryButton>
          <SecondaryButton onClick={handleExport}>
            <Download size={13} /> Export
          </SecondaryButton>
        </>
      }
      rightActions={
        <>
          <SecondaryButton onClick={() => setIsPreview((v) => !v)}>
            {isPreview ? (
              <><Code2 size={13} /> Build</>
            ) : (
              <><Eye size={13} /> Preview</>
            )}
          </SecondaryButton>
          <PrimaryButton onClick={handleNext} disabled={isInitializing}>
            {isInitializing ? "Setting up…" : "Next →"}
          </PrimaryButton>
        </>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {isPreview ? (
          <LivePreview fields={fields} formName={formName} />
        ) : (
          <>
            <FieldPalette />
            <InitOverlay active={isInitializing}>
              <Canvas
                fields={fields}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onDelete={deleteField}
                onDuplicate={duplicateField}
              />
            </InitOverlay>
            <ConfigPanel
              field={selectedField}
              onChange={updateSelected}
              onDelete={() => selectedField && deleteField(selectedField.id)}
              allFields={fields}
              formTemplateId={templateId}
            />
          </>
        )}
      </DndContext>
    </BuilderChrome>
  );
}
