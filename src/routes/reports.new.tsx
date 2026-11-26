import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check } from "lucide-react";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { reportFilterOptions, runReportFn, saveReport, type FilterOptions } from "@/lib/report-fn";
import { DATASETS, type Dataset, type ReportFilters, type ReportResult } from "@/lib/report-catalogue";
import { Button, Card, Field, NoPermission, Page, inputStyle } from "@/components/admin/kit";
import { ColumnPicker, FilterBar, ResultTable } from "@/components/reports/ReportParts";

export const Route = createFileRoute("/reports/new")({
  head: () => ({ meta: [{ title: "New Report · Admin Services Portal" }] }),
  component: NewReport,
});

const STARTERS: Record<Dataset, string[]> = {
  requests: ["reference", "form", "requester", "department", "status", "submitted_at", "cycle_days"],
  steps: ["reference", "form", "approver", "stage", "status", "opened_at", "acted_at", "on_time"],
  approvers: ["approver", "approver_department", "completed", "on_time_pct", "avg_response_days"],
};

function NewReport() {
  const { can } = useCurrentUser();
  const navigate = useNavigate();
  const [dataset, setDataset] = useState<Dataset>("requests");
  const [columns, setColumns] = useState<string[]>(STARTERS.requests);
  const [filters, setFilters] = useState<ReportFilters>({ period: "last_90" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [preview, setPreview] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => { void reportFilterOptions().then(setOptions); }, []);
  useEffect(() => {
    if (!columns.length) return;
    const mine = ++seq.current;
    void runReportFn({ data: { dataset, columns, filters } }).then((r) => {
      if (mine === seq.current && r.ok) setPreview(r.result);
    });
  }, [dataset, columns, filters]);

  if (!can("reports.manage")) return <Page title="New Report"><NoPermission need="reports.manage" /></Page>;

  return (
    <div className="mx-auto" style={{ maxWidth: 1280, padding: "28px 28px 56px" }}>
      <Link to="/reports" className="inline-flex items-center gap-1" style={{ fontSize: 12.5, color: "#71717A", textDecoration: "none", marginBottom: 10 }}>
        <ArrowLeft size={13} /> Reports
      </Link>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: "#18181B", margin: "0 0 16px" }}>New Report</h1>

      <Card title="1. What it is about">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {(Object.keys(DATASETS) as Dataset[]).map((d) => {
            const on = d === dataset;
            return (
              <button key={d} type="button" name={`dataset-${d}`}
                onClick={() => { setDataset(d); setColumns(STARTERS[d]); setFilters({ period: filters.period }); }}
                className="rounded-lg text-left"
                style={{ padding: "12px 14px", border: `1.5px solid ${on ? "#4F46E5" : "#E4E4E7"}`, background: on ? "#EEF2FF" : "#fff", cursor: "pointer" }}>
                <div className="flex items-center gap-1.5" style={{ fontSize: 13.5, fontWeight: 600, color: "#18181B" }}>
                  {on && <Check size={14} style={{ color: "#4F46E5" }} />}{DATASETS[d].label}
                </div>
                <div style={{ fontSize: 12, color: "#71717A", marginTop: 3, lineHeight: 1.45 }}>{DATASETS[d].description}</div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="2. Columns">
        <ColumnPicker dataset={dataset} value={columns} onChange={setColumns} />
      </Card>

      <Card title="3. Filters it starts with">
        <FilterBar dataset={dataset} filters={filters} onChange={setFilters} options={options} />
        {preview && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "#71717A", marginBottom: 6 }}>Preview</div>
            <ResultTable columns={preview.columns} rows={preview.rows.slice(0, 10)} />
          </div>
        )}
      </Card>

      <Card title="4. Name it">
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 2fr" }}>
          <Field label="Name"><input name="report-name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finance turnaround" /></Field>
          <Field label="What it is for"><input style={inputStyle} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Button tone="brand" busy={busy} disabled={!name.trim() || !columns.length} name="save-report" onClick={async () => {
            setBusy(true);
            const r = await saveReport({ data: { id: null, name, description, dataset, columns, filters } });
            setBusy(false);
            if (!r.ok) return void toast.error(r.error);
            toast.success("Report saved");
            navigate({ to: "/reports/$reportId", params: { reportId: r.id } });
          }}>Save report</Button>
        </div>
      </Card>
    </div>
  );
}
