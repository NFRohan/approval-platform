import { createFileRoute } from "@tanstack/react-router";
import { DateInput } from "@/components/DateInput";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, Download, Moon, Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { addWorkingDays, setOrgHolidays, todayInOrg } from "@/lib/workdays";
import { fmtDate } from "@/lib/dates";
import { Button, Card, Field, NoPermission, Page, Pill, inputStyle } from "@/components/admin/kit";
import { control } from "@/components/reports/ReportParts";
import { SERIES_1, SERIES_2, SERIES_3, INK, MUTED } from "@/components/viz";

export const Route = createFileRoute("/admin/calendar")({
  head: () => ({ meta: [{ title: "Working Calendar · Admin Services Portal" }] }),
  component: CalendarPage,
});

type Holiday = { id: string; on_date: string; name: string; kind: "general" | "executive" | "office"; provisional: boolean; moved_from: string | null };

// Each kind keeps its categorical slot wherever it appears. Day numbers
// stay in ink on a light tint; the colour is a bar beneath, with the
// legend and the list beside it, so no day is told apart by colour alone.
const KINDS: Record<Holiday["kind"], { label: string; color: string }> = {
  general: { label: "General holiday", color: SERIES_1 },
  executive: { label: "Executive order", color: SERIES_2 },
  office: { label: "Office closure", color: SERIES_3 },
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GOV_YEARS = [2026, 2027];

const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// Noon in Dhaka on that day, so arithmetic never slips across midnight.
const dhakaNoon = (day: string) => new Date(`${day}T12:00:00+06:00`);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const isWeekend = (day: string) => weekday(day) === 5 || weekday(day) === 6;

function CalendarPage() {
  const { can } = useCurrentUser();
  const canManage = can("org.manage");
  const [year, setYear] = useState(() => Number(todayInOrg().slice(0, 4)));
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await db.from("holidays").select("id, on_date, name, kind, provisional, moved_from").order("on_date").limit(2000);
    if (error) return void toast.error(error.message);
    const rows = (data ?? []) as Holiday[];
    setHolidays(rows);
    setOrgHolidays(rows.map((h) => h.on_date));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const byDay = useMemo(() => new Map(holidays.map((h) => [h.on_date, h])), [holidays]);
  const inYear = holidays.filter((h) => h.on_date.startsWith(String(year)));
  const today = todayInOrg();

  const stats = useMemo(() => {
    let working = 0, offWeekday = 0;
    for (let m = 0; m < 12; m++) {
      const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
      for (let d = 1; d <= days; d++) {
        const day = iso(year, m, d);
        if (isWeekend(day)) continue;
        if (byDay.has(day)) offWeekday++; else working++;
      }
    }
    return { working, offWeekday, provisional: inYear.filter((h) => h.provisional).length };
  }, [year, byDay, inYear]);

  const loadGov = async () => {
    setBusy(true);
    const { data, error } = await db.rpc("load_public_holidays", { p_year: year });
    setBusy(false);
    if (error) return void toast.error(error.message);
    toast.success(data ? `${data} holidays added for ${year}` : `${year}'s list is already in the calendar`);
    await load();
  };

  return (
    <div className="mx-auto" style={{ maxWidth: 1280, padding: "28px 28px 56px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: INK, margin: 0 }}>Working Calendar</h1>
      <p style={{ marginTop: 6, fontSize: 14, color: MUTED, marginBottom: 18, maxWidth: 820 }}>
        The days no deadline counts. Fridays and Saturdays, and the government's holidays — the Eid and Puja breaks among them — so a three-day
        approval asked for before Eid is due after it. Days that depend on the moon are provisional until it is sighted; move them here when it is.
      </p>
      {!canManage && !can("audit.view") && <NoPermission need="org.manage" />}

      <div className="flex items-center gap-2 flex-wrap mb-4">
        <select aria-label="Year" style={control} value={year} onChange={(e) => { setYear(Number(e.target.value)); setSelected(null); }}>
          {Array.from(new Set([...GOV_YEARS, Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1])).sort().map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {canManage && GOV_YEARS.includes(year) && (
          <Button small busy={busy} onClick={() => void loadGov()} name="load-gov"><Download size={12} /> Load the government's {year} list</Button>
        )}
        <div className="flex items-center gap-3 flex-wrap" style={{ marginLeft: "auto", fontSize: 12, color: "#3F3F46" }}>
          {Object.values(KINDS).map((k) => (
            <span key={k.label} className="inline-flex items-center gap-1.5"><span style={{ width: 14, height: 4, borderRadius: 2, background: k.color }} />{k.label}</span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span style={{ width: 12, height: 12, borderRadius: 3, border: "1px dashed #71717A" }} />Provisional (the moon)</span>
          <span className="inline-flex items-center gap-1.5"><span style={{ width: 12, height: 12, borderRadius: 3, background: "#F4F4F5" }} />Weekend</span>
        </div>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px" }}>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))", alignContent: "start" }} data-testid="calendar-year">
          {MONTHS.map((name, m) => {
            const first = new Date(Date.UTC(year, m, 1)).getUTCDay();
            const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
            return (
              <section key={name} className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "10px 12px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>{name}</div>
                <div className="grid" style={{ gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                  {DOW.map((d) => <div key={d} style={{ fontSize: 10, color: (d === "Fri" || d === "Sat") ? "#A1A1AA" : MUTED, textAlign: "center" }}>{d.slice(0, 2)}</div>)}
                  {Array.from({ length: first }, (_, i) => <div key={`b${i}`} />)}
                  {Array.from({ length: days }, (_, i) => {
                    const day = iso(year, m, i + 1);
                    const h = byDay.get(day);
                    const we = isWeekend(day);
                    const k = h ? KINDS[h.kind] : null;
                    const on = selected === day;
                    return (
                      <button key={day} type="button" data-day={day} onClick={() => setSelected(day)}
                        title={h ? `${h.name}${h.provisional ? " (provisional)" : ""}` : we ? "Weekend" : "Working day"}
                        aria-label={`${fmtDate(day)}${h ? `, ${h.name}` : we ? ", weekend" : ""}`}
                        style={{
                          position: "relative", height: 28, borderRadius: 5, fontSize: 11.5, cursor: "pointer", fontVariantNumeric: "tabular-nums",
                          color: we && !h ? "#A1A1AA" : INK, fontWeight: h ? 600 : 400,
                          background: k ? `color-mix(in oklab, ${k.color} 16%, white)` : we ? "#F4F4F5" : "#fff",
                          border: on ? "2px solid #18181B" : h?.provisional ? `1px dashed ${MUTED}` : day === today ? "1px solid #18181B" : "1px solid transparent",
                        }}>
                        {i + 1}
                        {k && <span style={{ position: "absolute", left: 4, right: 4, bottom: 2, height: 3, borderRadius: 2, background: k.color }} />}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <div className="flex flex-col gap-4">
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            {[["Working days", stats.working], ["Holidays on weekdays", stats.offWeekday], ["Provisional", stats.provisional]].map(([l, v]) => (
              <div key={l as string} className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "10px 12px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>{l}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>{v}</div>
              </div>
            ))}
          </div>
          {selected && <DayEditor key={selected} day={selected} holiday={byDay.get(selected) ?? null} canManage={canManage} onDone={async (next) => { await load(); setSelected(next); }} />}
          <DeadlineCheck byDay={byDay} />
          <Card title={`${year} holidays`} style={{ marginBottom: 0 }}>
            <div style={{ maxHeight: 420, overflowY: "auto" }} data-testid="holiday-list">
              {inYear.length === 0 && <div style={{ color: MUTED, fontSize: 13 }}>None in the calendar for {year}.</div>}
              {inYear.map((h) => (
                <button key={h.id} type="button" onClick={() => setSelected(h.on_date)} className="w-full text-left flex items-start gap-2"
                  style={{ padding: "6px 4px", borderTop: "1px solid #F4F4F5", background: "none", cursor: "pointer", opacity: h.on_date < today ? 0.55 : 1 }}>
                  <span style={{ width: 4, alignSelf: "stretch", borderRadius: 2, background: KINDS[h.kind].color, flex: "none" }} />
                  <span style={{ fontSize: 12, color: MUTED, width: 78, flex: "none", fontVariantNumeric: "tabular-nums" }}>{fmtDate(h.on_date)}<br />{DOW[weekday(h.on_date)]}</span>
                  <span style={{ fontSize: 12.5, color: INK }}>
                    {h.name}
                    {h.provisional && <span className="inline-flex items-center gap-0.5" style={{ marginLeft: 6, fontSize: 11, color: MUTED }}><Moon size={10} /> provisional</span>}
                    {h.moved_from && <span style={{ marginLeft: 6, fontSize: 11, color: MUTED }}>moved from {fmtDate(h.moved_from)}</span>}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DayEditor({ day, holiday, canManage, onDone }: { day: string; holiday: Holiday | null; canManage: boolean; onDone: (selected: string | null) => Promise<void> }) {
  const [name, setName] = useState(holiday?.name ?? "");
  const [kind, setKind] = useState<Holiday["kind"]>(holiday?.kind ?? "office");
  const [provisional, setProvisional] = useState(holiday?.provisional ?? false);
  const [to, setTo] = useState(day);
  const [busy, setBusy] = useState(false);
  const weekend = isWeekend(day);

  const save = async () => {
    setBusy(true);
    const { error } = await db.rpc("save_holiday", {
      p_on: to, p_name: name, p_kind: kind, p_provisional: provisional, p_moved_from: holiday && to !== day ? day : null,
    });
    setBusy(false);
    if (error) return void toast.error(error.message);
    toast.success(holiday && to !== day ? `${name} moved to ${fmtDate(to)}` : `${name} saved`);
    await onDone(to);
  };
  const remove = async () => {
    setBusy(true);
    const { error } = await db.rpc("delete_holiday", { p_on: day });
    setBusy(false);
    if (error) return void toast.error(error.message);
    toast.success(`${holiday?.name} removed — ${fmtDate(day)} is a working day`);
    await onDone(day);
  };

  return (
    <Card title={<span className="inline-flex items-center gap-2"><CalendarDays size={15} /> {fmtDate(day)}, {DOW[weekday(day)]}</span>} style={{ marginBottom: 0 }}>
      {weekend && !holiday ? (
        <div style={{ fontSize: 13, color: MUTED }}>The weekend — never counted.</div>
      ) : !canManage ? (
        <div style={{ fontSize: 13, color: "#3F3F46" }}>
          {holiday ? <>{holiday.name} <Pill>{KINDS[holiday.kind].label}</Pill></> : "A working day."}
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="day-editor">
          <Field label="Holiday"><input aria-label="Holiday name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Bank holiday" /></Field>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Kind">
              <select aria-label="Kind" style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value as Holiday["kind"])}>
                {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            <Field label={holiday ? "On (move it)" : "On"}><DateInput aria-label="Holiday date" style={inputStyle} value={to} onChange={(iso) => setTo(iso)} /></Field>
          </div>
          <label className="flex items-center gap-2" style={{ fontSize: 12.5, color: "#3F3F46" }}>
            <input type="checkbox" aria-label="Provisional" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} /> Provisional — depends on the moon
          </label>
          <div className="flex gap-2">
            <Button tone="brand" small busy={busy} disabled={!name.trim() || !to} onClick={() => void save()} name="save-holiday">
              {holiday ? (to !== day ? "Move" : "Save") : "Make it a holiday"}
            </Button>
            {holiday && <Button small tone="danger" busy={busy} onClick={() => void remove()} name="remove-holiday"><Trash2 size={12} /> It is a working day</Button>}
          </div>
        </div>
      )}
    </Card>
  );
}

/** When a deadline set on a day falls, and the holidays it steps over. */
function DeadlineCheck({ byDay }: { byDay: Map<string, Holiday> }) {
  const [from, setFrom] = useState(() => todayInOrg());
  const [days, setDays] = useState(3);
  const days_off = useMemo(() => new Set(byDay.keys()), [byDay]);
  const due = todayInOrg(addWorkingDays(dhakaNoon(from), Math.max(0, days), days_off));
  const skipped = useMemo(() => [...byDay.values()].filter((h) => h.on_date > from && h.on_date <= due && !isWeekend(h.on_date)), [byDay, from, due]);
  return (
    <Card title="When is it due?" style={{ marginBottom: 0 }}>
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 90px" }}>
        <Field label="Asked on"><DateInput aria-label="Asked on" style={inputStyle} value={from} onChange={(iso) => setFrom(iso || todayInOrg())} /></Field>
        <Field label="Working days"><input type="number" min={0} max={60} aria-label="Working days" style={inputStyle} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: "#3F3F46" }} data-testid="deadline-result">
        Due <strong style={{ color: INK }}>{fmtDate(due)}</strong>, a {DOW[weekday(due)]}
        {skipped.length > 0 && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Stepping over {skipped.map((h) => h.name).filter((v, i, a) => a.indexOf(v) === i).join(", ")}.</div>}
      </div>
    </Card>
  );
}
