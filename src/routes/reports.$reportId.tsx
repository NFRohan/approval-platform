import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft, CalendarClock, Download, FileSpreadsheet, FileText, GitPullRequestArrow, Mail, Pencil, Trash2,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import {
  decideReportChange, deleteReport, emailReport, getReport, reportFilterOptions, requestReportChange,
  runReportFn, saveReport, setReportSchedule, type FilterOptions, type ReportTemplate,
} from "@/lib/report-fn";
import { DATASETS, describeFilters, type ReportFilters, type ReportResult } from "@/lib/report-catalogue";
import { Button, Card, Field, NoPermission, Notice, Page, Pill, fmtWhen, inputStyle } from "@/components/admin/kit";
import { ColumnPicker, FilterBar, PeoplePicker, ResultTable, control, exportHref } from "@/components/reports/ReportParts";

export const Route = createFileRoute("/reports/$reportId")({
  head: () => ({ meta: [{ title: "Report · Admin Services Portal" }] }),
  component: ReportPage,
});

type Sort = { key: string; dir: "asc" | "desc" };

function ReportPage() {
  const { reportId } = Route.useParams();
  const { can, currentUser } = useCurrentUser();
  const manage = can("reports.manage");
  const allowed = can("reports.view") || manage;

  const [report, setReport] = useState<ReportTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReportFilters>({});
  const [sort, setSort] = useState<Sort | undefined>();
  const [result, setResult] = useState<ReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [panel, setPanel] = useState<"none" | "edit" | "request" | "schedule">("none");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const r = await getReport({ data: { id: reportId } });
    if (!r.ok) { setError(r.error); return; }
    setReport(r.report);
    setFilters(r.report.filters ?? {});
  }, [reportId]);

  useEffect(() => {
    if (!allowed) return;
    void load();
    void reportFilterOptions().then(setOptions);
  }, [allowed, load, currentUser.employee_id]);

  // Run whenever what is asked for changes; only the latest answer counts.
  useEffect(() => {
    if (!report) return;
    const mine = ++seq.current;
    setRunning(true);
    void runReportFn({ data: { dataset: report.dataset, columns: report.columns, filters, sort } }).then((r) => {
      if (mine !== seq.current) return;
      setRunning(false);
      if (r.ok) setResult(r.result); else toast.error(r.error);
    });
  }, [report, filters, sort]);

  if (!allowed) return <Page title="Report"><NoPermission need="reports.view" /></Page>;
  if (error) return <Page title="Report"><Notice tone="red">{error}</Notice></Page>;
  if (!report) return <Page title="Report"><div style={{ fontSize: 13, color: "#A1A1AA" }}>Loading…</div></Page>;

  const ds = DATASETS[report.dataset];
  const href = (format: "xlsx" | "pdf" | "csv") => exportHref(report.id, format, { columns: report.columns, filters, sort });
  const requestedByMe = report.change_requested_by === currentUser.employee_id;

  return (
    <div className="mx-auto" style={{ maxWidth: 1280, padding: "28px 28px 56px" }}>
      <Link to="/reports" className="inline-flex items-center gap-1" style={{ fontSize: 12.5, color: "#71717A", textDecoration: "none", marginBottom: 10 }}>
        <ArrowLeft size={13} /> Reports
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: 0 }} data-testid="report-name">{report.name}</h1>
            <Pill>{ds.label}</Pill>
            {report.standard && <Pill tone="brand">Standard</Pill>}
            {report.schedule !== "none" && (
              <Pill tone="brand"><CalendarClock size={11} style={{ marginRight: 4 }} />{report.schedule === "weekly" ? "Weekly" : "Monthly"} · {report.format.toUpperCase()}</Pill>
            )}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "#71717A" }}>{report.description ?? ds.description}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <a href={href("xlsx")} style={{ textDecoration: "none" }} data-testid="export-xlsx"><Button><FileSpreadsheet size={14} /> Excel</Button></a>
          <a href={href("pdf")} style={{ textDecoration: "none" }} data-testid="export-pdf"><Button><FileText size={14} /> PDF</Button></a>
          <a href={href("csv")} style={{ textDecoration: "none" }} data-testid="export-csv"><Button><Download size={14} /> CSV</Button></a>
          <EmailNow report={report} people={options?.people ?? []} />
          {manage ? (
            <>
              <Button onClick={() => setPanel(panel === "edit" ? "none" : "edit")}><Pencil size={14} /> Edit</Button>
              <Button onClick={() => setPanel(panel === "schedule" ? "none" : "schedule")}><CalendarClock size={14} /> Schedule</Button>
            </>
          ) : (
            <Button onClick={() => setPanel(panel === "request" ? "none" : "request")} name="request-change">
              <GitPullRequestArrow size={14} /> Request a column change
            </Button>
          )}
        </div>
      </div>

      {report.pending_columns && (
        <ChangeWaiting report={report} canDecide={manage && !requestedByMe} mine={requestedByMe} onDone={load} />
      )}

      {panel === "edit" && (
        <EditPanel report={report} filters={filters} onClose={() => setPanel("none")} onSaved={async () => { setPanel("none"); await load(); }} />
      )}
      {panel === "request" && (
        <RequestPanel report={report} onClose={() => setPanel("none")} onSent={async () => { setPanel("none"); await load(); }} />
      )}
      {panel === "schedule" && (
        <SchedulePanel report={report} people={options?.people ?? []} onClose={() => setPanel("none")} onSaved={async () => { setPanel("none"); await load(); }} />
      )}

      <div className="rounded-xl bg-white mb-3" style={{ border: "1px solid #E4E4E7", padding: "12px 14px" }}>
        <FilterBar dataset={report.dataset} filters={filters} onChange={setFilters} options={options} />
      </div>
      <div className="flex items-center justify-between mb-2" style={{ fontSize: 12, color: "#71717A" }}>
        <span>{describeFilters(filters)}</span>
        {running && <span>Running…</span>}
      </div>
      {result && (
        <div style={{ opacity: running ? 0.6 : 1, transition: "opacity 120ms" }}>
          <ResultTable columns={result.columns} rows={result.rows} truncated={result.truncated} sort={sort} onSort={setSort} />
        </div>
      )}
    </div>
  );
}

function EmailNow({ report, people }: { report: ReportTemplate; people: FilterOptions["people"] }) {
  const [to, setTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span><Button name="email-report"><Mail size={14} /> Email</Button></span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Email this report</div>
        <div style={{ fontSize: 12, color: "#71717A", marginBottom: 10 }}>
          As {report.format.toUpperCase()}, with its saved filters, made when it is sent.
        </div>
        <PeoplePicker people={people} value={to} onChange={setTo} />
        <div style={{ marginTop: 10 }}>
          <Button tone="brand" busy={busy} disabled={!to.length} onClick={async () => {
            setBusy(true);
            const r = await emailReport({ data: { id: report.id, recipients: to } });
            setBusy(false);
            if (!r.ok) return void toast.error(r.error);
            toast.success(`Sent to ${r.queued} ${r.queued === 1 ? "person" : "people"} — see the email log`);
            setTo([]); setOpen(false);
          }}>Send now</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChangeWaiting({ report, canDecide, mine, onDone }: { report: ReportTemplate; canDecide: boolean; mine: boolean; onDone: () => Promise<void> }) {
  const label = (k: string) => DATASETS[report.dataset].columns.find((c) => c.key === k)?.label ?? k;
  const added = (report.pending_columns ?? []).filter((k) => !report.columns.includes(k));
  const removed = report.columns.filter((k) => !(report.pending_columns ?? []).includes(k));
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const decide = async (approve: boolean) => {
    if (!approve && !reason.trim()) return void toast.error("Give a reason; it goes to whoever asked.");
    const r = await decideReportChange({ data: { id: report.id, approve, reason: approve ? undefined : reason } });
    if (!r.ok) return void toast.error(r.error);
    toast.success(approve ? "Change approved — the report now shows these columns" : "Change turned down; they have been told why");
    await onDone();
  };
  return (
    <div className="rounded-xl mb-4 flex items-start gap-3 flex-wrap" style={{ padding: "12px 14px", background: "#FFFBEB", border: "1px solid #FDE68A" }} data-testid="change-waiting">
      <GitPullRequestArrow size={16} style={{ color: "#B45309", marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 260, fontSize: 13, color: "#78350F" }}>
        <strong>{mine ? "Your" : `${report.change_requested_by_name ?? report.change_requested_by}'s`} column change is waiting for an administrator.</strong>
        {report.change_note && <span> "{report.change_note}"</span>}
        <div className="flex flex-wrap gap-1.5" style={{ marginTop: 6 }}>
          {added.map((k) => <Pill key={k} tone="green">+ {label(k)}</Pill>)}
          {removed.map((k) => <Pill key={k} tone="red">− {label(k)}</Pill>)}
          {!added.length && !removed.length && <Pill>Columns reordered</Pill>}
        </div>
        {mine && <div style={{ marginTop: 6, fontSize: 12.5 }}>It is in the administrators' Pending Approvals; you will be told when it is decided.</div>}
        {canDecide && rejecting && (
          <div className="flex gap-2 items-center" style={{ marginTop: 8 }}>
            <input aria-label="Reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                   placeholder="Why not? They will see this." className="flex-1 rounded-md"
                   style={{ padding: "6px 9px", fontSize: 13, border: "1px solid #FDE68A", background: "#fff", color: "#18181B" }} />
            <Button small onClick={() => setRejecting(false)}>Cancel</Button>
            <Button small tone="danger" onClick={() => void decide(false)}>Turn it down</Button>
          </div>
        )}
      </div>
      {canDecide && !rejecting && (
        <div className="flex gap-2">
          <Button small tone="good" name="approve-change" onClick={() => void decide(true)}>Approve</Button>
          <Button small tone="danger" onClick={() => setRejecting(true)}>Reject</Button>
        </div>
      )}
    </div>
  );
}

function EditPanel({ report, filters, onClose, onSaved }: { report: ReportTemplate; filters: ReportFilters; onClose: () => void; onSaved: () => Promise<void> }) {
  const navigate = useNavigate();
  const [name, setName] = useState(report.name);
  const [description, setDescription] = useState(report.description ?? "");
  const [columns, setColumns] = useState(report.columns);
  const [keepFilters, setKeepFilters] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Edit report" aside={<Button small onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-3.5">
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 2fr" }}>
          <Field label="Name"><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="What it is for"><input style={inputStyle} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <ColumnPicker dataset={report.dataset} value={columns} onChange={setColumns} />
        <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={keepFilters} onChange={(e) => setKeepFilters(e.target.checked)} />
          Save the filters on screen as this report's own ({describeFilters(filters)})
        </label>
        <div className="flex gap-2 items-center">
          <Button tone="brand" busy={busy} disabled={!columns.length || !name.trim()} onClick={async () => {
            setBusy(true);
            const r = await saveReport({ data: { id: report.id, name, description, dataset: report.dataset, columns, filters: keepFilters ? filters : report.filters } });
            setBusy(false);
            if (!r.ok) return void toast.error(r.error);
            toast.success("Report saved");
            await onSaved();
          }}>Save</Button>
          {!report.standard && (
            <Button tone="danger" onClick={async () => {
              if (!window.confirm(`Delete ${report.name}?`)) return;
              const r = await deleteReport({ data: { id: report.id } });
              if (!r.ok) return void toast.error(r.error);
              toast.success("Report deleted");
              navigate({ to: "/reports" });
            }}><Trash2 size={13} /> Delete</Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function RequestPanel({ report, onClose, onSent }: { report: ReportTemplate; onClose: () => void; onSent: () => Promise<void> }) {
  const [columns, setColumns] = useState(report.pending_columns ?? report.columns);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Request a column change" aside={<Button small onClick={onClose}>Close</Button>}>
      <p style={{ fontSize: 13, color: "#52525B", margin: "0 0 12px" }}>
        Choose the columns you need. An administrator approves the change before the report shows it, for everybody.
      </p>
      <ColumnPicker dataset={report.dataset} value={columns} onChange={setColumns} />
      <div style={{ marginTop: 12, maxWidth: 520 }}>
        <Field label="Why"><input name="change-note" style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Audit needs the decision dates" /></Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Button tone="brand" busy={busy} disabled={!columns.length} name="send-change" onClick={async () => {
          setBusy(true);
          const r = await requestReportChange({ data: { id: report.id, dataset: report.dataset, columns, note } });
          setBusy(false);
          if (!r.ok) return void toast.error(r.error);
          toast.success("Change requested — it waits for an administrator");
          await onSent();
        }}>Send request</Button>
      </div>
    </Card>
  );
}

function SchedulePanel({ report, people, onClose, onSaved }: { report: ReportTemplate; people: FilterOptions["people"]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [schedule, setSchedule] = useState(report.schedule);
  const [recipients, setRecipients] = useState(report.recipients);
  const [format, setFormat] = useState(report.format);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Send it on a schedule" aside={<Button small onClick={onClose}>Close</Button>}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)" }}>
        <div className="flex flex-col gap-3">
          <Field label="How often">
            <select name="schedule" style={control} value={schedule} onChange={(e) => setSchedule(e.target.value as ReportTemplate["schedule"])}>
              <option value="none">Not scheduled</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </Field>
          <Field label="As">
            <select name="format" style={control} value={format} onChange={(e) => setFormat(e.target.value as ReportTemplate["format"])}>
              <option value="xlsx">Excel</option>
              <option value="pdf">PDF</option>
              <option value="csv">CSV</option>
            </select>
          </Field>
          <div style={{ fontSize: 12, color: "#71717A" }}>
            {report.last_sent_at ? `Last sent ${fmtWhen(report.last_sent_at)}.` : "Not sent yet."} Sent with the daily round at 08:00, Dhaka.
          </div>
        </div>
        <Field label="To"><PeoplePicker people={people} value={recipients} onChange={setRecipients} /></Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <Button tone="brand" busy={busy} onClick={async () => {
          setBusy(true);
          const r = await setReportSchedule({ data: { id: report.id, schedule, recipients, format } });
          setBusy(false);
          if (!r.ok) return void toast.error(r.error);
          toast.success(schedule === "none" ? "No longer scheduled" : "Schedule saved");
          await onSaved();
        }}>Save schedule</Button>
      </div>
    </Card>
  );
}
