import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BarChart3, CalendarClock, FileSpreadsheet, GitPullRequestArrow, Plus } from "lucide-react";
import { useCurrentUser } from "@/contexts/CurrentUserContext";
import { listReports, type ReportTemplate } from "@/lib/report-fn";
import { DATASETS } from "@/lib/report-catalogue";
import { Button, NoPermission, Notice, Page, Pill } from "@/components/admin/kit";

export const Route = createFileRoute("/reports/")({
  head: () => ({ meta: [{ title: "Reports · Admin Services Portal" }] }),
  component: ReportsPage,
});

function ReportsPage() {
  const { can, currentUser } = useCurrentUser();
  const allowed = can("reports.view") || can("reports.manage");
  const [reports, setReports] = useState<ReportTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    void listReports().then((r) => (r.ok ? setReports(r.reports) : setError(r.error)));
  }, [allowed, currentUser.employee_id]);

  if (!allowed) return <Page title="Reports"><NoPermission need="reports.view" /></Page>;

  const standard = (reports ?? []).filter((r) => r.standard);
  const custom = (reports ?? []).filter((r) => !r.standard);

  return (
    <Page
      wide
      title="Reports"
      intro="Reports are templates of columns and filters over every request and approval. Open one to filter it, export it to Excel, PDF or CSV, or email it. Administrators keep the templates; anybody can ask for a change to the columns."
    >
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {can("reports.manage") && (
          <Link to="/reports/new" style={{ textDecoration: "none" }}>
            <Button tone="brand"><Plus size={14} /> New report</Button>
          </Link>
        )}
        <Link to="/analytics" style={{ textDecoration: "none" }}>
          <Button><BarChart3 size={14} /> Analytics dashboard</Button>
        </Link>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
      {reports === null && !error && <div style={{ fontSize: 13, color: "#A1A1AA" }}>Loading…</div>}

      {standard.length > 0 && <Section title="Standard reports" reports={standard} />}
      <Section title="Your organisation's reports" reports={custom}
        empty={can("reports.manage") ? "None yet. Start one from New report." : "None yet. An administrator can add them."} />
    </Page>
  );
}

function Section({ title, reports, empty }: { title: string; reports: ReportTemplate[]; empty?: string }) {
  return (
    <section className="mb-7">
      <h2 style={{ fontSize: 13, fontWeight: 600, color: "#52525B", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.04em" }}>{title}</h2>
      {reports.length === 0 && empty && (
        <div className="rounded-xl" style={{ padding: "28px 20px", border: "1px dashed #E4E4E7", color: "#A1A1AA", fontSize: 13, textAlign: "center" }}>{empty}</div>
      )}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }} data-testid="report-cards">
        {reports.map((r) => (
          <Link
            key={r.id}
            to="/reports/$reportId"
            params={{ reportId: r.id }}
            className="rounded-xl bg-white flex flex-col gap-2 transition-shadow hover:shadow-sm"
            style={{ border: "1px solid #E4E4E7", padding: 16, textDecoration: "none", color: "inherit" }}
          >
            <div className="flex items-start gap-2.5">
              <span className="inline-flex items-center justify-center rounded-lg shrink-0" style={{ width: 32, height: 32, background: "#EEF2FF", color: "#4338CA" }}>
                <FileSpreadsheet size={16} />
              </span>
              <div className="min-w-0">
                <div style={{ fontSize: 14, fontWeight: 600, color: "#18181B" }}>{r.name}</div>
                <div style={{ fontSize: 12, color: "#71717A", marginTop: 2, lineHeight: 1.45 }}>{r.description ?? DATASETS[r.dataset].description}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5" style={{ marginTop: "auto", paddingTop: 4 }}>
              <Pill>{DATASETS[r.dataset].label}</Pill>
              <Pill>{r.columns.length} columns</Pill>
              {r.schedule !== "none" && (
                <Pill tone="brand"><CalendarClock size={11} style={{ marginRight: 4 }} />{r.schedule === "weekly" ? "Weekly" : "Monthly"} to {r.recipients.length}</Pill>
              )}
              {r.pending_columns && <Pill tone="amber"><GitPullRequestArrow size={11} style={{ marginRight: 4 }} />Change requested</Pill>}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
