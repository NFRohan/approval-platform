import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertOctagon, AlertTriangle, Archive, Database, Download, Info, Moon, RefreshCw, Search, Server, ShieldAlert, User, Workflow } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  auditSummary, listAudit, retentionPreview, runRetentionNow, saveRetention,
  type AuditCategory, type AuditRow, type AuditSummary, type Retention,
} from "@/lib/audit-fn";
import { Button, Card, Field, NoPermission, Notice, Page, Pill, fmtWhen, inputStyle } from "@/components/admin/kit";
import { control } from "@/components/reports/ReportParts";
import { ChartCard, Panel, RankedBars, SimpleTable, Tip, SERIES_1, SERIES_2, SERIES_3, SERIES_4, GRID, AXIS, INK, MUTED } from "@/components/viz";

export const Route = createFileRoute("/admin/audit")({
  head: () => ({ meta: [{ title: "Audit centre · Admin Services Portal" }] }),
  component: AuditPage,
});

// The four categories keep the same colour wherever they appear, in the
// fixed categorical order.
const CATEGORIES: { key: AuditCategory; label: string; color: string; Icon: typeof User; detail: string }[] = [
  { key: "user", label: "User", color: SERIES_1, Icon: User, detail: "Sign-ins, accounts, roles, settings, decisions, documents read" },
  { key: "application", label: "Application", color: SERIES_2, Icon: Workflow, detail: "Email, mail received, API calls, webhooks, errors" },
  { key: "system", label: "System", color: SERIES_3, Icon: Server, detail: "The daily round, directory sync, retention runs" },
  { key: "database", label: "Database", color: SERIES_4, Icon: Database, detail: "Schema applied, imports, migration, archiving and purging" },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c])) as Record<AuditCategory, (typeof CATEGORIES)[number]>;

const RANGES = [
  { key: "1", label: "Today", days: 1 }, { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 }, { key: "90", label: "90 days", days: 90 },
];

const ACTION_TEXT: Record<string, string> = {
  signed_in: "Signed in", sign_in_failed: "Sign-in failed", account_locked: "Account locked", account_unlocked: "Account unlocked",
  persona_switched: "Switched persona", password_changed: "Password changed", password_reset: "Password reset",
  mfa_enabled: "Two-step turned on", mfa_disabled: "Two-step turned off",
  submitted: "Submitted", approved: "Approved", rejected: "Rejected", completed: "Completed", cancelled: "Cancelled",
  recalled: "Recalled", clarification: "Asked for clarification", note: "Added a note", returned: "Returned",
  forwarded: "Forwarded", document_viewed: "Opened a document", api_call: "API call", error: "Application error",
  daily_round: "Daily round", directory_sync: "Directory sync", retention_run: "Retention run", schema_applied: "Schema applied",
  records_archived: "Records archived", logs_purged: "Logs purged", legacy_import: "Migrated from ManageEngine",
  migrated: "Migrated", raised_in_legacy: "Raised in ManageEngine", closed_in_legacy: "Closed in ManageEngine",
  hr_import: "HR import", api_key_created: "API key made", api_key_revoked: "API key revoked",
  webhook_created: "Webhook added", webhook_changed: "Webhook changed", webhook_deleted: "Webhook deleted",
  webhook_secret_rotated: "Webhook secret rotated", webhook_secret_viewed: "Webhook secret viewed",
  webhook_delivered: "Webhook delivered", webhook_failed: "Webhook failed", webhook_queued: "Webhook retrying",
  email_sent: "Email sent", email_captured: "Email written", email_failed: "Email failed", email_queued: "Email queued",
  mail_ticket: "Mail became a ticket", mail_note: "Mail added to a ticket", mail_rejected: "Mail refused",
  retention_changed: "Retention changed", audit_exported: "Audit trail exported", raised_through_api: "Raised through the API",
  report_exported: "Report exported",
};
const actionText = (a: string) => ACTION_TEXT[a] ?? a.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const SEV: Record<string, { tone: "zinc" | "amber" | "red"; Icon: typeof Info; word: string }> = {
  info: { tone: "zinc", Icon: Info, word: "Info" },
  warning: { tone: "amber", Icon: AlertTriangle, word: "Warning" },
  critical: { tone: "red", Icon: AlertOctagon, word: "Critical" },
};

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function AuditPage() {
  const { can } = useCurrentUser();
  if (!can("audit.view") && !can("records.manage")) return <Page title="Audit centre"><NoPermission need="audit.view" /></Page>;
  return (
    <div className="mx-auto" style={{ maxWidth: 1280, padding: "28px 28px 56px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: INK, margin: 0 }}>Audit centre</h1>
      <p style={{ marginTop: 6, fontSize: 14, color: MUTED, marginBottom: 18, maxWidth: 820 }}>
        One trail over everything: what people did, what the application did and sent to other systems, what the scheduler ran and what changed
        in the database — searchable, exportable, and watched for what looks wrong. And how long all of it is kept.
      </p>
      <Tabs defaultValue={can("audit.view") ? "trail" : "retention"}>
        <TabsList>
          {can("audit.view") && <TabsTrigger value="trail">Trail</TabsTrigger>}
          {can("audit.view") && <TabsTrigger value="monitoring">Monitoring</TabsTrigger>}
          <TabsTrigger value="retention">Retention</TabsTrigger>
        </TabsList>
        {can("audit.view") && <TabsContent value="trail"><Trail /></TabsContent>}
        {can("audit.view") && <TabsContent value="monitoring"><Monitoring /></TabsContent>}
        <TabsContent value="retention"><RetentionTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------
function Trail() {
  const [range, setRange] = useState("7");
  const [cats, setCats] = useState<AuditCategory[]>([]);
  const [severity, setSeverity] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [limited, setLimited] = useState(false);
  const [loading, setLoading] = useState(false);

  const from = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)!.days;
    const d = new Date(Date.now() + 6 * 3600_000);
    d.setUTCHours(0, 0, 0, 0);
    return new Date(d.getTime() - 6 * 3600_000 - (days - 1) * 86_400_000).toISOString();
  }, [range]);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await listAudit({ data: { from, categories: cats, severity: severity || null, search: applied || null, limit: 500 } });
    setLoading(false);
    if (!r.ok) return void toast.error(r.error);
    setRows(r.rows); setLimited(r.limited);
  }, [from, cats, severity, applied]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => setApplied(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    rows.forEach((r) => { c[r.category] = (c[r.category] ?? 0) + 1; });
    return c;
  }, [rows]);

  const href = (format: "xlsx" | "csv") => {
    const p = new URLSearchParams({ format, from });
    if (cats.length) p.set("categories", cats.join(","));
    if (severity) p.set("severity", severity);
    if (applied) p.set("q", applied);
    return `/exports/audit?${p.toString()}`;
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {CATEGORIES.map((c) => {
          const on = cats.includes(c.key);
          return (
            <button key={c.key} type="button" data-testid={`cat-${c.key}`} title={c.detail}
              onClick={() => setCats(on ? cats.filter((x) => x !== c.key) : [...cats, c.key])}
              className="rounded-xl text-left" style={{ padding: "10px 14px", border: `1px solid ${on ? "#C7D2FE" : "#E4E4E7"}`, background: on ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
              <div className="flex items-center gap-2" style={{ fontSize: 12.5, color: "#3F3F46", fontWeight: 600 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: c.color }} /> <c.Icon size={13} /> {c.label}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{(counts[c.key] ?? 0).toLocaleString("en-US")}{limited ? "+" : ""}</div>
              <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.35 }}>{c.detail}</div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="inline-flex rounded-md" style={{ border: "1px solid #E4E4E7", overflow: "hidden" }}>
          {RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => setRange(r.key)} aria-pressed={range === r.key}
              style={{ padding: "6px 10px", fontSize: 12.5, background: range === r.key ? "#18181B" : "#fff", color: range === r.key ? "#fff" : "#3F3F46", border: 0, cursor: "pointer" }}>{r.label}</button>
          ))}
        </div>
        <select aria-label="Severity" style={control} value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">Every severity</option>
          <option value="warning">Warnings and critical</option>
          <option value="critical">Critical only</option>
        </select>
        <label className="inline-flex items-center gap-1.5" style={{ ...control, minWidth: 260 }}>
          <Search size={13} style={{ color: "#A1A1AA" }} />
          <input aria-label="Search the trail" placeholder="Person, reference, action, address…" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ border: 0, outline: "none", flex: 1, fontSize: 13 }} />
        </label>
        <div className="flex items-center gap-2" style={{ marginLeft: "auto" }}>
          <Button small onClick={() => void load()}><RefreshCw size={12} /> Refresh</Button>
          <a href={href("xlsx")} className="inline-flex items-center gap-1.5 rounded-md" data-testid="export-xlsx" style={{ padding: "4px 9px", fontSize: 12, border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46" }}><Download size={12} /> Excel</a>
          <a href={href("csv")} className="inline-flex items-center gap-1.5 rounded-md" style={{ padding: "4px 9px", fontSize: 12, border: "1px solid #E4E4E7", background: "#fff", color: "#3F3F46" }}><Download size={12} /> CSV</a>
        </div>
      </div>

      <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", overflow: "hidden" }}>
        <div style={{ maxHeight: 640, overflowY: "auto" }}>
          <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }} data-testid="audit-trail">
            <thead style={{ position: "sticky", top: 0, background: "#FAFAFA", zIndex: 1 }}>
              <tr style={{ color: MUTED, fontSize: 11.5, textAlign: "left" }}>
                {["When", "Category", "", "What", "Who", "About", "Detail"].map((h, i) => <th key={i} style={{ padding: "8px 10px", fontWeight: 500 }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const c = CAT[r.category];
                const s = SEV[r.severity] ?? SEV.info;
                return (
                  <tr key={i} style={{ borderTop: "1px solid #F4F4F5", background: r.severity === "critical" ? "#FEF7F7" : r.severity === "warning" ? "#FFFCF2" : undefined }}>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap", color: "#3F3F46", fontVariantNumeric: "tabular-nums" }}>{fmtWhen(r.at)}</td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                      <span className="inline-flex items-center gap-1.5" style={{ color: "#3F3F46" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: c?.color }} />{c?.label ?? r.category}</span>
                    </td>
                    <td style={{ padding: "7px 4px" }}>{r.severity !== "info" && <span title={s.word} aria-label={s.word} style={{ color: r.severity === "critical" ? "#B91C1C" : "#B45309", display: "inline-flex" }}><s.Icon size={13} /></span>}</td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap", color: INK, fontWeight: 500 }}>{actionText(r.action)}<div style={{ fontSize: 11, color: "#A1A1AA", fontWeight: 400 }}>{r.source}</div></td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{r.actor ?? r.actor_id ?? <span style={{ color: "#A1A1AA" }}>—</span>}{r.actor && r.actor_id && <div style={{ fontSize: 11, color: "#A1A1AA" }}>{r.actor_id}</div>}</td>
                    <td style={{ padding: "7px 10px", maxWidth: 220 }}>
                      {r.subject && /^(AMS|ME)-/.test(r.subject) && r.subject_id
                        ? <Link to="/status/$submissionId" params={{ submissionId: r.subject_id }} className="font-mono" style={{ fontSize: 11.5, color: "#4338CA" }}>{r.subject}</Link>
                        : <span style={{ color: "#3F3F46" }}>{r.subject}</span>}
                    </td>
                    <td style={{ padding: "7px 10px", color: MUTED, maxWidth: 420 }}>{r.detail}</td>
                  </tr>
                );
              })}
              {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ padding: 28, textAlign: "center", color: MUTED }}>Nothing in this period matches.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "8px 12px", fontSize: 11.5, color: MUTED, borderTop: "1px solid #F4F4F5" }}>
          {loading ? "Loading…" : limited ? `The latest 500 shown — narrow the filters, or export up to 20,000.` : `${rows.length.toLocaleString("en-US")} entries.`}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------
function Monitoring() {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<AuditSummary | null>(null);
  useEffect(() => {
    let alive = true;
    void auditSummary({ data: { days } }).then((r) => { if (alive) { if (r.ok) setS(r.summary); else toast.error(r.error); } });
    return () => { alive = false; };
  }, [days]);

  const security = useMemo(() => {
    if (!s) return { failed: 0, refused: 0, locked: 0 };
    return s.security.reduce((a, d) => ({ failed: a.failed + d.failed_sign_ins, refused: a.refused + d.refused_api, locked: a.locked + d.locked }), { failed: 0, refused: 0, locked: 0 });
  }, [s]);
  // The partial day is left off the daily charts: a half-day reads as a drop.
  const full = <T extends { day: string }>(xs: T[]) => xs.slice(0, -1);
  const afterPct = s && s.after_hours.total ? Math.round((s.after_hours.after / s.after_hours.total) * 1000) / 10 : 0;

  return (
    <div style={{ marginTop: 14 }} className="grid gap-4">
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 13, color: MUTED }}>The last</span>
        <select aria-label="Period" style={control} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
        <span style={{ fontSize: 12, color: "#A1A1AA" }}>Dhaka time; working hours 09:00–18:00, Sunday to Thursday.</span>
      </div>
      {!s ? <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div> : (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
            <Tile label="Entries" value={s.total.toLocaleString("en-US")} sub={`${(s.by_severity.warning ?? 0) + (s.by_severity.critical ?? 0)} warnings or worse`} />
            <Tile label="Failed sign-ins" value={String(security.failed)} sub={`${security.locked} account${security.locked === 1 ? "" : "s"} locked`} warn={security.locked > 0} Icon={ShieldAlert} />
            <Tile label="Refused API calls" value={String(security.refused)} sub="revoked or wrong keys" warn={security.refused > 0} Icon={ShieldAlert} />
            <Tile label="Out of hours" value={`${afterPct}%`} sub={`${s.after_hours.after.toLocaleString("en-US")} of ${s.after_hours.total.toLocaleString("en-US")} things people did`} Icon={Moon} />
          </div>

          <ChartCard title="Activity per day, by category" note="Complete days. Every entry in the trail, stacked by what kind it is."
            legend={CATEGORIES.map((c) => ({ color: c.color, label: c.label }))}
            table={<SimpleTable head={["Day", ...CATEGORIES.map((c) => c.label)]} rows={full(s.daily).map((d) => [d.day, d.user, d.application, d.system, d.database])} />}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={full(s.daily)} margin={{ top: 4, right: 8, bottom: 0, left: -12 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="day" tickFormatter={dm} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip cursor={{ fill: "#F4F4F5" }} content={<Tip title={(p) => p.day} rows={(p) => CATEGORIES.map((c) => [c.label, p[c.key], c.color] as [string, number, string])} />} />
                {CATEGORIES.map((c, i) => (
                  <Bar key={c.key} dataKey={c.key} stackId="a" fill={c.color} stroke="#fff" strokeWidth={1}
                    radius={i === CATEGORIES.length - 1 ? [4, 4, 0, 0] : undefined} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <ChartCard title="Failed sign-ins per day" note="A spike is somebody guessing. Five in a row locks the account."
              table={<SimpleTable head={["Day", "Failed sign-ins", "Refused API calls", "Locked"]} rows={full(s.security).map((d) => [d.day, d.failed_sign_ins, d.refused_api, d.locked])} />}>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={full(s.security)} margin={{ top: 4, right: 8, bottom: 0, left: -18 }} barCategoryGap={2}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="day" tickFormatter={dm} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: "#F4F4F5" }} content={<Tip title={(p) => p.day} rows={(p) => [["Failed sign-ins", p.failed_sign_ins, SERIES_1], ["Refused API calls", p.refused_api], ["Accounts locked", p.locked]]} />} />
                  <Bar dataKey="failed_sign_ins" fill={SERIES_1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="When people work" note="What people did, by hour of the day. Shaded: working hours."
              table={<SimpleTable head={["Hour", "Entries"]} rows={s.by_hour.map((h) => [`${String(h.hour).padStart(2, "0")}:00`, h.n])} />}>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={s.by_hour} margin={{ top: 4, right: 8, bottom: 0, left: -18 }} barCategoryGap={2}>
                  <ReferenceArea x1={9} x2={17} fill="#F4F4F5" fillOpacity={1} ifOverflow="extendDomain" />
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="hour" tickFormatter={(h: number) => String(h).padStart(2, "0")} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} interval={2} />
                  <YAxis tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: "#F4F4F5" }} content={<Tip title={(p) => `${String(p.hour).padStart(2, "0")}:00–${String(p.hour).padStart(2, "0")}:59`} rows={(p) => [["Entries", p.n, SERIES_1]]} />} />
                  <Bar dataKey="n" fill={SERIES_1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <Panel title="Most active people" note="Everything each did in the period.">
              {s.top_actors.length ? <RankedBars unit="Entries" height={Math.max(120, s.top_actors.length * 26)} rows={s.top_actors.map((a) => ({ name: a.actor ?? a.actor_id, value: a.n }))} /> : <Empty />}
            </Panel>
            <Panel title="Out of hours, by person" note="Evenings, nights and the Friday–Saturday weekend — worth a look when it is not expected.">
              {s.after_hours_people.length ? <RankedBars unit="Out of hours" height={Math.max(120, s.after_hours_people.length * 26)} rows={s.after_hours_people.map((a) => ({ name: a.actor ?? a.actor_id, value: a.n }))} /> : <Empty />}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function Empty() { return <div style={{ color: MUTED, fontSize: 13, padding: "18px 0" }}>Nothing in this period.</div>; }

function Tile({ label, value, sub, warn, Icon }: { label: string; value: string; sub: string; warn?: boolean; Icon?: typeof Info }) {
  return (
    <div className="rounded-xl bg-white" style={{ border: "1px solid #E4E4E7", padding: "14px 16px" }}>
      <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED }}>
        {warn ? <AlertTriangle size={13} style={{ color: "#B45309" }} aria-label="Needs attention" /> : Icon ? <Icon size={13} /> : null}{label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: INK, letterSpacing: "-0.02em", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------
const LOGS: [keyof Retention["logs"], string][] = [
  ["email", "Emails"], ["api", "API calls"], ["webhooks", "Webhook deliveries"], ["inbound", "Mail received"],
  ["errors", "Application errors"], ["scheduler", "Scheduler runs"],
];

function RetentionTab() {
  const [r, setR] = useState<Retention | null>(null);
  const [years, setYears] = useState(12);
  const [archive, setArchive] = useState(12);
  const [purge, setPurge] = useState(120);
  const [busy, setBusy] = useState<"" | "save" | "run">("");

  const load = useCallback(async () => {
    const x = await retentionPreview();
    if (!x.ok) return void toast.error(x.error);
    setR(x.retention);
    setYears(x.retention.settings.retention_years);
    setArchive(x.retention.settings.archive_after_months);
    setPurge(x.retention.settings.purge_logs_after_months);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!r) return <div style={{ marginTop: 14, color: MUTED, fontSize: 13 }}>Loading…</div>;
  const dirty = years !== r.settings.retention_years || archive !== r.settings.archive_after_months || purge !== r.settings.purge_logs_after_months;
  const logsDue = LOGS.reduce((n, [k]) => n + (r.logs[k] ?? 0), 0);

  const save = async () => {
    setBusy("save");
    const x = await saveRetention({ data: { years, archiveMonths: archive, purgeMonths: purge } });
    setBusy("");
    if (!x.ok) return void toast.error(x.error);
    toast.success("Retention saved — the next run uses it");
    await load();
  };
  const runNow = async () => {
    setBusy("run");
    const x = await runRetentionNow();
    setBusy("");
    if (!x.ok) return void toast.error(x.error);
    toast.success(`${x.archived} archived, ${x.purged} log entries purged`);
    await load();
  };

  const maxYear = Math.max(1, ...r.by_year.map((y) => y.archived + y.active));
  const cutoffYear = new Date().getFullYear() - r.settings.retention_years;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.25fr)" }}>
        <Card title="The policy">
          <p style={{ fontSize: 13, color: "#3F3F46", lineHeight: 1.55, marginTop: 0 }}>
            A request settled more than <strong>{r.settings.archive_after_months} months</strong> ago is archived: out of everybody's working lists, still found by search, in reports and here.
            Logs older than <strong>{r.settings.purge_logs_after_months / 12} years</strong> are purged. Records are kept <strong>{r.settings.retention_years} years</strong>; past that they are listed for a records officer to dispose of —
            destroying a financial record is a decision, not a timer. The daily round applies it every morning.
          </p>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", alignItems: "end", marginTop: 14 }}>
            <Field label="Keep records (years)"><input type="number" min={1} max={50} aria-label="Keep records for years" style={inputStyle} value={years} disabled={!r.can_manage} onChange={(e) => setYears(Number(e.target.value))} /></Field>
            <Field label="Archive after (months)"><input type="number" min={1} max={120} aria-label="Archive after months" style={inputStyle} value={archive} disabled={!r.can_manage} onChange={(e) => setArchive(Number(e.target.value))} /></Field>
            <Field label="Purge logs after (months)"><input type="number" min={12} max={600} aria-label="Purge logs after months" style={inputStyle} value={purge} disabled={!r.can_manage} onChange={(e) => setPurge(Number(e.target.value))} /></Field>
          </div>
          {r.can_manage ? (
            <div className="flex gap-2 mt-4 flex-wrap">
              <Button tone="brand" busy={busy === "save"} disabled={!dirty} onClick={() => void save()}>Save policy</Button>
              <Button busy={busy === "run"} onClick={() => void runNow()} name="run-retention"><Archive size={13} /> Run it now</Button>
            </div>
          ) : <div className="mt-3"><Notice tone="zinc">Changing the policy needs the records.manage permission.</Notice></div>}
          <div style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>
            Last run {r.last_run ? fmtWhen(r.last_run) : "never"}{r.last_result ? ` — ${r.last_result.archived} archived, ${r.last_result.purged} purged` : ""}.
          </div>
        </Card>

        <Card title="What the next run will do">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }} data-testid="retention-preview">
            <Due label="To archive" value={r.archive} sub="settled requests past the archive age" />
            <Due label="Logs to purge" value={logsDue} sub={`older than ${r.settings.purge_logs_after_months} months`} />
            <Due label="Past retention" value={r.past_retention} sub={`archived, settled before ${cutoffYear + 1}`} warn={r.past_retention > 0} />
          </div>
          <table className="w-full mt-4" style={{ fontSize: 12.5, borderCollapse: "collapse" }}>
            <tbody>
              {LOGS.map(([k, label]) => (
                <tr key={k} style={{ borderTop: "1px solid #F4F4F5" }}>
                  <td style={{ padding: "6px 4px", color: "#3F3F46" }}>{label}</td>
                  <td style={{ padding: "6px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{(r.logs[k] ?? 0).toLocaleString("en-US")} due</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.past_retention > 0 && (
            <Notice tone="amber">
              {r.past_retention} archived record{r.past_retention === 1 ? " is" : "s are"} older than {r.settings.retention_years} years. They are kept until somebody decides to dispose of them.
            </Notice>
          )}
        </Card>
      </div>

      <ChartCard title="Records by the year they were settled" note={`Archived and still in the working lists. Left of the line: past ${r.settings.retention_years} years.`}
        legend={[{ color: SERIES_1, label: "Archived" }, { color: SERIES_2, label: "Working" }]}
        table={<SimpleTable head={["Year", "Archived", "Working"]} rows={r.by_year.map((y) => [y.year, y.archived, y.active])} />}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={r.by_year} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap={4}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="year" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} domain={[0, maxYear]} />
            {r.by_year.some((y) => y.year <= cutoffYear) && (
              <ReferenceArea x1={r.by_year[0].year} x2={cutoffYear} fill="#FEF3C7" fillOpacity={0.5} ifOverflow="extendDomain" />
            )}
            <Tooltip cursor={{ fill: "#F4F4F5" }} content={<Tip title={(p) => String(p.year)} rows={(p) => [["Archived", p.archived, SERIES_1], ["Working", p.active, SERIES_2]]} />} />
            <Bar dataKey="archived" stackId="a" fill={SERIES_1} stroke="#fff" strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="active" stackId="a" fill={SERIES_2} stroke="#fff" strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
        The archive itself is under <Link to="/submissions" search={{ archived: 1 }} style={{ textDecoration: "underline" }}>My Submissions → Archive</Link>.
        Old tickets come in from ManageEngine under <Link to="/admin/integrations" style={{ textDecoration: "underline" }}>Integrations → Migration</Link>.
      </div>
    </div>
  );
}

function Due({ label, value, sub, warn }: { label: string; value: number; sub: string; warn?: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED }}>{warn && <AlertTriangle size={12} style={{ color: "#B45309" }} aria-label="Needs attention" />}{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>{value.toLocaleString("en-US")}</div>
      <div style={{ fontSize: 11.5, color: MUTED }}>{sub}</div>
    </div>
  );
}

