// =====================================================================
// Trackers: /trackers
//
// ABC: "One main tracker and several multiple trackers for various
// filing and application follow-up", with "alerts/reminders for each
// item", real-time status and "export tracker in Excel". The main
// tracker is every request; the others are named, filtered views kept
// for their owner, their department or everyone. Each row says where
// the request is, with whom and since when, and lets the person looking
// set a reminder on it for a day they choose (db/009_sow_gaps.sql).
// =====================================================================

import { DateInput } from "@/components/DateInput";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlarmClock, Download, Plus, RefreshCw, Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { fmtDate } from "@/lib/dates";
import { todayInOrg } from "@/lib/workdays";
import { downloadSheet } from "@/lib/sheet-fn";
import { Button, Card, Field, Page, Pill, inputStyle } from "@/components/admin/kit";

export const Route = createFileRoute("/trackers")({
  head: () => ({ meta: [{ title: "Trackers · Admin Services Portal" }] }),
  component: TrackersPage,
});

type Filters = {
  forms?: string[]; statuses?: string[]; departments?: string[]; priority?: string;
  flagged?: boolean; overdue?: boolean; from?: string; to?: string; search?: string;
  /** ABC: decided between two dates; an answer exactly; a date answer in a range. */
  decided_from?: string; decided_to?: string; answer?: string;
  answer_field?: string; answer_from?: string; answer_to?: string;
};
type Tracker = {
  id: string; name: string; description: string | null; owner_id: string | null;
  shared_with: "me" | "department" | "everyone"; department: string | null; filters: Filters;
};
type Row = {
  id: string; reference: string | null; form: string; category: string | null; requester: string | null; requester_name: string | null;
  department: string | null; status: string; priority: string; flag: string | null; submitted_at: string | null;
  with_whom: string | null; stage: string | null; waiting_since: string | null; due_at: string | null; overdue: boolean;
  remind_on: string | null; reminder_note: string | null; decided_at: string | null;
};

const MAIN = "main";
const STATUS_SETS: { key: string; label: string; statuses: string[] }[] = [
  { key: "", label: "Any status", statuses: [] },
  { key: "open", label: "Open", statuses: ["submitted", "in_progress", "on_hold"] },
  { key: "completed", label: "Approved", statuses: ["completed"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];
const statusKey = (s?: string[]) => STATUS_SETS.find((x) => x.statuses.length && JSON.stringify([...x.statuses].sort()) === JSON.stringify([...(s ?? [])].sort()))?.key ?? "";
const SHARE: Record<Tracker["shared_with"], string> = { me: "Only me", department: "My department", everyone: "Everyone" };
const STATUS_WORD: Record<string, string> = {
  submitted: "Submitted", in_progress: "In progress", on_hold: "On hold", completed: "Approved", rejected: "Rejected", cancelled: "Cancelled",
};

function TrackersPage() {
  const { currentUser, can } = useCurrentUser();
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [current, setCurrent] = useState<string>(MAIN);
  const [filters, setFilters] = useState<Filters>({});
  const [rows, setRows] = useState<Row[] | null>(null);
  const [forms, setForms] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [dateFields, setDateFields] = useState<string[]>([]);
  const [saving, setSaving] = useState<null | { name: string; description: string; shared: Tracker["shared_with"] }>(null);
  const [reminding, setReminding] = useState<null | { id: string; on: string; note: string }>(null);

  const tracker = trackers.find((t) => t.id === current) ?? null;
  const mine = !!tracker && (tracker.owner_id === currentUser.employee_id || can("reports.manage"));

  const loadTrackers = useCallback(async () => {
    const { data } = await db.from("trackers").select("id, name, description, owner_id, shared_with, department, filters").order("name");
    setTrackers((data ?? []) as Tracker[]);
  }, []);
  useEffect(() => {
    void loadTrackers();
    void db.from("form_templates").select("name").eq("status", "published").order("name").then(({ data }) =>
      setForms(((data ?? []) as { name: string }[]).map((f) => f.name)));
    void db.from("departments").select("name").order("name").then(({ data }) =>
      setDepartments(((data ?? []) as { name: string }[]).map((d) => d.name)));
    void db.from("form_fields").select("field_name").eq("field_type", "date").then(({ data }) =>
      setDateFields(Array.from(new Set(((data ?? []) as { field_name: string }[]).map((f) => f.field_name))).sort()));
  }, [loadTrackers, currentUser.employee_id]);

  const loadRows = useCallback(async (f: Filters) => {
    setRows(null);
    const { data, error } = await db.rpc("tracker_list", { p_filters: f });
    if (error) { toast.error(error.message); setRows([]); return; }
    setRows((data ?? []) as Row[]);
  }, []);
  useEffect(() => { void loadRows(filters); }, [filters, loadRows]);

  const open = (id: string) => {
    setCurrent(id);
    setFilters(id === MAIN ? {} : { ...(trackers.find((t) => t.id === id)?.filters ?? {}) });
  };

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const dirty = !!tracker && JSON.stringify(tracker.filters) !== JSON.stringify(filters);

  const save = async (asNew: boolean) => {
    const name = asNew ? saving?.name ?? "" : tracker?.name ?? "";
    const { data, error } = await db.rpc("save_tracker", {
      p_id: asNew ? null : tracker!.id, p_name: name,
      p_description: asNew ? saving?.description ?? null : tracker?.description ?? null,
      p_shared_with: asNew ? saving?.shared ?? "me" : tracker!.shared_with, p_filters: filters,
    });
    if (error) return void toast.error(error.message);
    toast.success(asNew ? `Tracker "${name}" saved` : "Tracker updated");
    setSaving(null);
    await loadTrackers();
    if (asNew) setCurrent(data as string);
  };
  const remove = async () => {
    if (!tracker || !window.confirm(`Remove the tracker "${tracker.name}"? The requests stay as they are.`)) return;
    const { error } = await db.rpc("delete_tracker", { p_id: tracker.id });
    if (error) return void toast.error(error.message);
    toast.success("Tracker removed");
    await loadTrackers();
    open(MAIN);
  };
  const remind = async (id: string, on: string | null, note: string) => {
    const { error } = await db.rpc("set_tracker_reminder", { p_submission: id, p_on: on, p_note: note || null });
    if (error) return void toast.error(error.message);
    toast.success(on ? `You will be reminded on ${fmtDate(on)}` : "Reminder cleared");
    setReminding(null);
    await loadRows(filters);
  };
  const exportExcel = async () => {
    try {
      const list = rows ?? [];
      // One form's requests carry its answers as columns (ABC: "Excel for
      // analysis" — counterparty, declaration type, event date).
      const formsIn = Array.from(new Set(list.map((r) => r.form)));
      let answerCols: { key: string; label: string }[] = [];
      const answers: Record<string, Record<string, string>> = {};
      if (formsIn.length === 1 && list.length) {
        const { data: tpl } = await db.from("form_templates").select("id").eq("name", formsIn[0]).limit(1).maybeSingle();
        if (tpl) {
          const { data: fields } = await db.from("form_fields").select("field_name, field_type, order_index")
            .eq("form_template_id", (tpl as { id: string }).id).order("order_index");
          answerCols = ((fields ?? []) as { field_name: string; field_type: string }[])
            .filter((f) => !["section_header", "file", "gen_employee_name", "signature"].includes(f.field_type))
            .map((f) => ({ key: `a:${f.field_name}`, label: f.field_name }));
          const ids = list.map((r) => r.id);
          for (let i = 0; i < ids.length; i += 200) {
            const { data: vals } = await db.from("submission_values").select("submission_id, field_name, value").in("submission_id", ids.slice(i, i + 200));
            for (const v of (vals ?? []) as { submission_id: string; field_name: string; value: string | null }[]) {
              (answers[v.submission_id] ??= {})[`a:${v.field_name}`] = v.value ?? "";
            }
          }
        }
      }
      await downloadSheet(`${(tracker?.name ?? "main-tracker").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${todayInOrg()}.xlsx`,
        tracker?.name ?? "Main tracker",
        [
          { key: "reference", label: "Reference" }, { key: "form", label: "Form" }, { key: "requester_name", label: "Raised by" },
          { key: "department", label: "Department" }, { key: "status", label: "Status" }, { key: "submitted_at", label: "Raised" },
          { key: "decided_at", label: "Decided" }, { key: "with_whom", label: "With" },
          { key: "stage", label: "Stage" }, { key: "waiting_since", label: "Waiting since" }, { key: "due_at", label: "Due" },
          { key: "priority", label: "Priority" }, { key: "flag", label: "Flag" },
          ...answerCols,
        ],
        list.map((r) => ({
          reference: r.reference, form: r.form, requester_name: r.requester_name, department: r.department,
          status: STATUS_WORD[r.status] ?? r.status, submitted_at: fmtDate(r.submitted_at), decided_at: fmtDate(r.decided_at),
          with_whom: r.with_whom, stage: r.stage,
          waiting_since: fmtDate(r.waiting_since), due_at: fmtDate(r.due_at), priority: r.priority, flag: r.flag,
          ...(answers[r.id] ?? {}),
        })));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The workbook could not be made");
    }
  };

  const counts = useMemo(() => ({
    open: (rows ?? []).filter((r) => ["submitted", "in_progress", "on_hold"].includes(r.status)).length,
    overdue: (rows ?? []).filter((r) => r.overdue).length,
    reminders: (rows ?? []).filter((r) => r.remind_on).length,
  }), [rows]);

  return (
    <Page
      full
      title="Trackers"
      intro="The main tracker follows every request; your trackers are filtered views kept for you, your department or everyone. Set a reminder on any request and you are told on the day."
    >
      <div className="grid gap-4 grid-cols-1 md:grid-cols-[minmax(180px,200px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5" data-testid="tracker-list">
          {[{ id: MAIN, name: "Main tracker", shared_with: "everyone" as const }, ...trackers].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => open(t.id)}
              className="text-left rounded-lg"
              style={{
                padding: "9px 11px", fontSize: 13, cursor: "pointer",
                border: `1px solid ${current === t.id ? "#C7D2FE" : "#E4E4E7"}`, background: current === t.id ? "#EEF2FF" : "#fff",
                color: "#18181B", fontWeight: current === t.id ? 600 : 500,
              }}
            >
              {t.name}
              <span style={{ display: "block", fontSize: 11.5, color: "#71717A", fontWeight: 400 }}>
                {t.id === MAIN ? "Every request" : SHARE[(t as Tracker).shared_with]}
              </span>
            </button>
          ))}
          <Button small onClick={() => setSaving({ name: "", description: "", shared: "me" })}><Plus size={12} /> New tracker from this view</Button>
        </div>

        <div className="min-w-0">
          <Card
            title={tracker?.name ?? "Main tracker"}
            aside={
              <span className="flex gap-2 flex-wrap justify-end">
                <Button small onClick={() => void loadRows(filters)}><RefreshCw size={12} /> Refresh</Button>
                <Button small onClick={() => void exportExcel()} disabled={!rows?.length}><Download size={12} /> Excel</Button>
                {tracker && mine && dirty && <Button small tone="brand" onClick={() => void save(false)}>Save changes</Button>}
                {tracker && mine && <Button small onClick={() => void remove()}><Trash2 size={12} /></Button>}
              </span>
            }
            style={{ marginBottom: 12 }}
          >
            {tracker?.description && <p style={{ fontSize: 13, color: "#52525B", margin: "-6px 0 10px" }}>{tracker.description}</p>}
            <div className="flex gap-2 flex-wrap" data-testid="tracker-filters">
              <select aria-label="Form" style={{ ...inputStyle, width: 220 }} value={filters.forms?.length === 1 ? filters.forms[0] : ""}
                onChange={(e) => set({ forms: e.target.value ? [e.target.value] : [] })}>
                <option value="">{filters.forms && filters.forms.length > 1 ? `${filters.forms.length} forms` : "Every form"}</option>
                {forms.map((f) => <option key={f}>{f}</option>)}
              </select>
              <select aria-label="Status" style={{ ...inputStyle, width: 140 }} value={statusKey(filters.statuses)}
                onChange={(e) => set({ statuses: STATUS_SETS.find((x) => x.key === e.target.value)?.statuses ?? [] })}>
                {STATUS_SETS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <select aria-label="Department" style={{ ...inputStyle, width: 170 }} value={filters.departments?.[0] ?? ""}
                onChange={(e) => set({ departments: e.target.value ? [e.target.value] : [] })}>
                <option value="">Every department</option>
                {departments.map((d) => <option key={d}>{d}</option>)}
              </select>
              <select aria-label="Priority" style={{ ...inputStyle, width: 130 }} value={filters.priority ?? ""} onChange={(e) => set({ priority: e.target.value || undefined })}>
                <option value="">Any priority</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option>
              </select>
              <span className="inline-flex items-center gap-1.5" style={{ fontSize: 12.5, color: "#52525B" }}>Raised
                <DateInput aria-label="From" style={{ ...inputStyle, width: 130 }} value={filters.from ?? ""} onChange={(iso) => set({ from: iso || undefined })} />
                to <DateInput aria-label="To" style={{ ...inputStyle, width: 130 }} value={filters.to ?? ""} onChange={(iso) => set({ to: iso || undefined })} />
              </span>
              <input aria-label="Search the tracker" placeholder="Reference, form, person or any answer" style={{ ...inputStyle, width: 240 }} value={filters.search ?? ""}
                onChange={(e) => set({ search: e.target.value || undefined })} />
              <label className="inline-flex items-center gap-1.5" style={{ fontSize: 12.5, color: "#3F3F46" }}>
                <input type="checkbox" checked={!!filters.overdue} onChange={(e) => set({ overdue: e.target.checked || undefined })} /> Overdue only
              </label>
              <label className="inline-flex items-center gap-1.5" style={{ fontSize: 12.5, color: "#3F3F46" }}>
                <input type="checkbox" checked={!!filters.flagged} onChange={(e) => set({ flagged: e.target.checked || undefined })} /> Flagged only
              </label>
            </div>
            <div className="flex gap-2 flex-wrap items-center mt-2" style={{ fontSize: 12.5, color: "#52525B" }} data-testid="tracker-more-filters">
              <span className="inline-flex items-center gap-1.5">Decided
                <DateInput aria-label="Decided from" style={{ ...inputStyle, width: 130 }} value={filters.decided_from ?? ""} onChange={(iso) => set({ decided_from: iso || undefined })} />
                to <DateInput aria-label="Decided to" style={{ ...inputStyle, width: 130 }} value={filters.decided_to ?? ""} onChange={(iso) => set({ decided_to: iso || undefined })} />
              </span>
              <input aria-label="An answer exactly" placeholder="An answer exactly, e.g. a reference number" style={{ ...inputStyle, width: 250 }}
                value={filters.answer ?? ""} onChange={(e) => set({ answer: e.target.value || undefined })} />
              <select aria-label="Date answer" style={{ ...inputStyle, width: 170 }} value={filters.answer_field ?? ""}
                onChange={(e) => set({ answer_field: e.target.value || undefined, ...(e.target.value ? {} : { answer_from: undefined, answer_to: undefined }) })}>
                <option value="">A date answer…</option>
                {dateFields.map((f) => <option key={f}>{f}</option>)}
              </select>
              {filters.answer_field && (
                <span className="inline-flex items-center gap-1.5">between
                  <DateInput aria-label="Date answer from" style={{ ...inputStyle, width: 130 }} value={filters.answer_from ?? ""} onChange={(iso) => set({ answer_from: iso || undefined })} />
                  and <DateInput aria-label="Date answer to" style={{ ...inputStyle, width: 130 }} value={filters.answer_to ?? ""} onChange={(iso) => set({ answer_to: iso || undefined })} />
                </span>
              )}
            </div>
            <div className="flex gap-2 mt-3 flex-wrap" style={{ fontSize: 12.5, color: "#52525B" }}>
              <Pill>{rows ? `${rows.length} request${rows.length === 1 ? "" : "s"}` : "Loading…"}</Pill>
              <Pill tone="brand">{counts.open} open</Pill>
              <Pill tone={counts.overdue ? "red" : "zinc"}>{counts.overdue} overdue</Pill>
              <Pill tone={counts.reminders ? "amber" : "zinc"}>{counts.reminders} with your reminder</Pill>
            </div>
          </Card>

          {saving && (
            <Card title="Keep this view as a tracker" style={{ marginBottom: 12 }}>
              <div className="grid gap-3 grid-cols-1 md:grid-cols-[1fr_1.4fr_180px_auto] items-end">
                <Field label="Name"><input aria-label="Tracker name" style={inputStyle} value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} placeholder="e.g. Vendor gifts this quarter" /></Field>
                <Field label="What it is for"><input aria-label="Tracker description" style={inputStyle} value={saving.description} onChange={(e) => setSaving({ ...saving, description: e.target.value })} /></Field>
                <Field label="Shared with">
                  <select aria-label="Shared with" style={inputStyle} value={saving.shared} onChange={(e) => setSaving({ ...saving, shared: e.target.value as Tracker["shared_with"] })}>
                    <option value="me">Only me</option><option value="department">My department</option><option value="everyone">Everyone</option>
                  </select>
                </Field>
                <span className="flex gap-2 flex-wrap">
                  <Button tone="brand" disabled={!saving.name.trim()} onClick={() => void save(true)}>Save</Button>
                  <Button onClick={() => setSaving(null)}>Cancel</Button>
                </span>
              </div>
            </Card>
          )}

          <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", overflowX: "auto" }}>
            <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse", minWidth: 860 }} data-testid="tracker-rows">
              <thead>
                <tr style={{ color: "#71717A", fontSize: 11.5, textAlign: "left", background: "#FAFAFA" }}>
                  {["Reference", "Form", "Raised by", "Status", "With", "Waiting since", "Due", "", "Remind"].map((h, i) => (
                    <th key={i} style={{ padding: "8px 10px", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid #F4F4F5" }}>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                      <Link to="/status/$submissionId" params={{ submissionId: r.id }} style={{ color: "#4338CA", fontWeight: 500 }}>{r.reference ?? "Open"}</Link>
                    </td>
                    <td style={{ padding: "8px 10px", color: "#18181B" }}>{r.form}</td>
                    <td style={{ padding: "8px 10px" }}>{r.requester_name ?? r.requester}<span style={{ display: "block", color: "#A1A1AA", fontSize: 11.5 }}>{r.department}</span></td>
                    <td style={{ padding: "8px 10px" }}>{STATUS_WORD[r.status] ?? r.status}</td>
                    <td style={{ padding: "8px 10px" }}>{r.with_whom ?? "—"}{r.stage && <span style={{ display: "block", color: "#A1A1AA", fontSize: 11.5 }}>{r.stage}</span>}</td>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{fmtDate(r.waiting_since)}</td>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap", color: r.overdue ? "#B91C1C" : undefined, fontWeight: r.overdue ? 600 : 400 }}>
                      {fmtDate(r.due_at)}{r.overdue ? " · overdue" : ""}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span className="flex gap-1">
                        {r.priority !== "normal" && <Pill tone={r.priority === "urgent" ? "red" : "amber"}>{r.priority === "urgent" ? "Urgent" : "High"}</Pill>}
                        {r.flag && <Pill tone="amber">{r.flag}</Pill>}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                      {reminding?.id === r.id ? (
                        <span className="flex items-center gap-1.5">
                          <DateInput aria-label="Remind me on" min={todayInOrg()} style={{ ...inputStyle, width: 140, padding: "4px 6px" }}
                            value={reminding.on} onChange={(iso) => setReminding({ ...reminding, on: iso })} />
                          <input aria-label="Reminder note" placeholder="Note" style={{ ...inputStyle, width: 140, padding: "4px 6px" }}
                            value={reminding.note} onChange={(e) => setReminding({ ...reminding, note: e.target.value })} />
                          <Button small tone="brand" disabled={!reminding.on} onClick={() => void remind(r.id, reminding.on, reminding.note)}>Set</Button>
                          {r.remind_on && <Button small onClick={() => void remind(r.id, null, "")}>Clear</Button>}
                          <Button small onClick={() => setReminding(null)}>Cancel</Button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setReminding({ id: r.id, on: r.remind_on ?? todayInOrg(), note: r.reminder_note ?? "" })}
                          title={r.reminder_note ?? "Remind me about this on a day I choose"}
                          aria-label={r.remind_on ? `Remind me — set for ${fmtDate(r.remind_on)}` : "Remind me"}
                          className="inline-flex items-center gap-1"
                          style={{ border: "none", background: "none", cursor: "pointer", color: r.remind_on ? "#B45309" : "#71717A", fontSize: 12.5 }}
                        >
                          <AlarmClock size={14} />{r.remind_on ? ` ${fmtDate(r.remind_on)}` : null}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows && rows.length === 0 && (
                  <tr><td colSpan={9} style={{ padding: "18px 10px", color: "#A1A1AA", textAlign: "center" }}>Nothing matches.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Page>
  );
}
