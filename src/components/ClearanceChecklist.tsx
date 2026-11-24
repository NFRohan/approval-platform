// =====================================================================
// A request's clearance checklists, track by track.
//
// "Checklist of handover, property recovery, official portals": each
// department's items, ticked by whoever holds that department's step.
// The database decides who may tick and refuses an approval while the
// track has items open (db/009_sow_gaps.sql); this shows it and asks.
// =====================================================================

import { useCallback, useEffect, useState } from "react";
import { CheckSquare, ListChecks, Square } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/dates";

export type ChecklistTrack = {
  track: string;
  state: "open" | "waiting" | "cleared";
  can_tick: boolean;
  items: { id: string; item: string; done: boolean; done_by: string | null; done_by_name: string | null; done_at: string | null; note: string | null }[];
};

const STATE: Record<ChecklistTrack["state"], { word: string; color: string; bg: string }> = {
  open: { word: "With them now", color: "#92400E", bg: "#FEF3C7" },
  waiting: { word: "Not yet", color: "#52525B", bg: "#F4F4F5" },
  cleared: { word: "Cleared", color: "#166534", bg: "#DCFCE7" },
};

export function ClearanceChecklist({
  submissionId,
  onlyMine = false,
  onChange,
  style,
  title,
}: {
  submissionId: string;
  /** Only the tracks the person looking may tick now (the approvals queue). */
  onlyMine?: boolean;
  onChange?: () => void;
  /** Around the list, when there is one to show. */
  style?: React.CSSProperties;
  /** A heading over the list, shown only when there is a list. */
  title?: string;
}) {
  const [tracks, setTracks] = useState<ChecklistTrack[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await db.rpc("checklist_for", { p_submission: submissionId });
    setTracks(error ? [] : ((data as ChecklistTrack[] | null) ?? []));
  }, [submissionId]);

  useEffect(() => { void load(); }, [load]);

  const tick = async (itemId: string, done: boolean) => {
    setBusy(itemId);
    const { error } = await db.rpc("tick_checklist", { p_submission: submissionId, p_item: itemId, p_done: done, p_note: null });
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    await load();
    onChange?.();
  };

  const shown = (tracks ?? []).filter((t) => !onlyMine || t.can_tick);
  if (!shown.length) return null;

  return (
    <div className="flex flex-col gap-3" style={style}>
      {title && (
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#52525B" }}>
          <ListChecks size={13} /> {title}
        </div>
      )}
      {shown.map((t) => {
        const done = t.items.filter((i) => i.done).length;
        const s = STATE[t.state];
        return (
          <div key={t.track} className="rounded-lg bg-white" style={{ border: "1px solid #E4E4E7", padding: "10px 12px" }}>
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <ListChecks size={14} style={{ color: "#4F46E5" }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#18181B" }}>{t.track}</span>
              <span style={{ fontSize: 11.5, color: "#71717A" }}>{done} of {t.items.length} done</span>
              <span className="rounded-full" style={{ marginLeft: "auto", fontSize: 11, padding: "1px 8px", color: s.color, background: s.bg }}>
                {s.word}
              </span>
            </div>
            <div className="flex flex-col">
              {t.items.map((i) => {
                const enabled = t.can_tick && busy !== i.id;
                return (
                  <button
                    key={i.id}
                    type="button"
                    disabled={!enabled}
                    onClick={() => void tick(i.id, !i.done)}
                    className="flex items-start gap-2 text-left"
                    style={{ padding: "5px 2px", background: "none", border: "none", cursor: enabled ? "pointer" : "default" }}
                    title={t.can_tick ? (i.done ? "Untick" : "Tick it once it is done") : undefined}
                  >
                    {i.done
                      ? <CheckSquare size={16} style={{ color: "#16A34A", flexShrink: 0, marginTop: 1 }} />
                      : <Square size={16} style={{ color: t.can_tick ? "#4F46E5" : "#A1A1AA", flexShrink: 0, marginTop: 1 }} />}
                    <span style={{ fontSize: 13, color: i.done ? "#3F3F46" : "#18181B" }}>
                      {i.item}
                      {i.done && (
                        <span style={{ display: "block", fontSize: 11.5, color: "#71717A" }}>
                          {i.done_by_name ?? i.done_by}, {fmtDateTime(i.done_at)}{i.note ? ` — ${i.note}` : ""}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {t.can_tick && done < t.items.length && (
              <div style={{ fontSize: 11.5, color: "#92400E", marginTop: 4 }}>
                Tick each item before you approve this step.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
