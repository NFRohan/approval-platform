// =====================================================================
// Clearance checklists: /admin/checklists
//
// "Per-division checklists configured by authorised users." For each
// track of a form's chain — a department's lane, or a stage of its own —
// the items whoever holds that track ticks before it clears. Changing
// them needs forms.settings or org.manage, checked in the database.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { Button, Card, Field, NoPermission, Page, Pill, inputStyle } from "@/components/admin/kit";

export const Route = createFileRoute("/admin/checklists")({
  head: () => ({ meta: [{ title: "Clearance Checklists · Admin Services Portal" }] }),
  component: ChecklistsPage,
});

type Track = { track: string; items: string[] };

function ChecklistsPage() {
  const { can } = useCurrentUser();
  const canManage = can("org.manage") || can("forms.settings");
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState<string>("");
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await db.from("form_templates").select("id, name").eq("status", "published").order("name");
      const rows = (data ?? []) as { id: string; name: string }[];
      setForms(rows);
      setForm((f) => f || rows.find((r) => r.name === "Employee Exit Clearance")?.id || rows[0]?.id || "");
    })();
  }, []);

  const load = useCallback(async () => {
    if (!form) return;
    setTracks(null);
    const { data, error } = await db.rpc("checklist_config", { p_form: form });
    if (error) return void toast.error(error.message);
    const t = (data as Track[] | null) ?? [];
    setTracks(t);
    setSaved(Object.fromEntries(t.map((x) => [x.track, JSON.stringify(x.items)])));
  }, [form]);
  useEffect(() => { void load(); }, [load]);

  const setItems = (track: string, items: string[]) =>
    setTracks((ts) => (ts ?? []).map((t) => (t.track === track ? { ...t, items } : t)));

  const save = async (t: Track) => {
    setBusy(t.track);
    const items = t.items.map((i) => i.trim()).filter(Boolean);
    const { error } = await db.rpc("save_checklist", { p_form: form, p_track: t.track, p_items: items });
    setBusy(null);
    if (error) return void toast.error(error.message);
    toast.success(items.length ? `${t.track}: ${items.length} item${items.length === 1 ? "" : "s"} saved` : `${t.track}: no checklist now`);
    await load();
  };

  return (
    <Page
      title="Clearance Checklists"
      wide
      intro={<>What each department checks before its track of a request clears: handover, property recovery, official portals.
        Whoever holds the track ticks each item, and the step cannot be approved while one is open. Items taken off stay on the
        requests that ticked them.</>}
    >
      {!canManage && <div className="mb-4"><NoPermission need="forms.settings or org.manage" /></div>}
      <Card>
        <Field label="Form">
          <select aria-label="Form" style={{ ...inputStyle, maxWidth: 420 }} value={form} onChange={(e) => setForm(e.target.value)}>
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
      </Card>

      {tracks === null ? (
        <div style={{ fontSize: 13, color: "#71717A" }}>Loading…</div>
      ) : tracks.length === 0 ? (
        <Card><div style={{ fontSize: 13, color: "#71717A" }}>This form's chain has no named tracks or stages. Name a stage in the form builder to give it a checklist.</div></Card>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }} data-testid="checklist-tracks">
          {tracks.map((t) => {
            const dirty = saved[t.track] !== JSON.stringify(t.items);
            return (
              <Card
                key={t.track}
                title={<span className="flex items-center gap-2"><ListChecks size={14} style={{ color: "#4F46E5" }} /> {t.track}</span>}
                aside={<Pill tone={t.items.length ? "brand" : "zinc"}>{t.items.length ? `${t.items.length} item${t.items.length === 1 ? "" : "s"}` : "None"}</Pill>}
                style={{ marginBottom: 0 }}
              >
                <div className="flex flex-col gap-2">
                  {t.items.map((item, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      {/* Wraps instead of cutting a long item off mid-word. */}
                      <textarea
                        aria-label={`${t.track} item ${i + 1}`}
                        style={{ ...inputStyle, flex: 1, resize: "none", lineHeight: 1.4, fontFamily: "inherit" }}
                        rows={Math.max(1, Math.ceil(item.length / 40))}
                        value={item}
                        disabled={!canManage}
                        maxLength={200}
                        onChange={(e) => setItems(t.track, t.items.map((x, j) => (j === i ? e.target.value.replace(/\n/g, " ") : x)))}
                      />
                      {canManage && (
                        <>
                          <IconButton label="Move up" disabled={i === 0}
                            onClick={() => setItems(t.track, swap(t.items, i, i - 1))}><ArrowUp size={13} /></IconButton>
                          <IconButton label="Move down" disabled={i === t.items.length - 1}
                            onClick={() => setItems(t.track, swap(t.items, i, i + 1))}><ArrowDown size={13} /></IconButton>
                          <IconButton label="Remove" onClick={() => setItems(t.track, t.items.filter((_, j) => j !== i))}><Trash2 size={13} /></IconButton>
                        </>
                      )}
                    </div>
                  ))}
                  {!t.items.length && <div style={{ fontSize: 12.5, color: "#A1A1AA" }}>No checklist: this track clears on approval alone.</div>}
                  {canManage && (
                    <div className="flex items-center gap-2 mt-1">
                      <Button small onClick={() => setItems(t.track, [...t.items, ""])}><Plus size={12} /> Add an item</Button>
                      <span style={{ flex: 1 }} />
                      <Button small tone="brand" busy={busy === t.track} disabled={!dirty} onClick={() => void save(t)}>Save</Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
}

function swap<T>(xs: T[], a: number, b: number): T[] {
  const out = [...xs];
  [out[a], out[b]] = [out[b], out[a]];
  return out;
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{ border: 0, background: "none", padding: 4, color: disabled ? "#D4D4D8" : "#71717A", cursor: disabled ? "default" : "pointer" }}
    >
      {children}
    </button>
  );
}
