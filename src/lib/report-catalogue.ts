// =====================================================================
// What a report can be made of.
//
// Three datasets — requests, approval steps, and approvers' performance —
// each with the columns a report may show and the filters it may apply.
// The server builds SQL only from what is listed here (src/server/
// reports.ts); the screens build their pickers from the same list; and
// values are formatted once, here, so the table on screen, the Excel
// file, the PDF and the CSV all say the same thing.
// =====================================================================

import { fmtDate, fmtDateTime } from "./dates";

export type Dataset = "requests" | "steps" | "approvers";
export type ColumnType = "text" | "date" | "datetime" | "number" | "money" | "bool" | "percent" | "status";

export type ColumnDef = { key: string; label: string; type: ColumnType; sql: string };

export const DATASETS: Record<Dataset, { label: string; description: string; columns: ColumnDef[]; dateColumn: string; defaultSort: string }> = {
  requests: {
    label: "Requests",
    description: "One row per request raised: where it is, who it waits on, how long it took.",
    dateColumn: "submitted_at",
    defaultSort: "submitted_at desc",
    columns: [
      { key: "reference",    label: "Reference",      type: "text",     sql: "reference" },
      { key: "form",         label: "Form",           type: "text",     sql: "form" },
      { key: "category",     label: "Category",       type: "text",     sql: "category" },
      { key: "requester",    label: "Requester",      type: "text",     sql: "requester" },
      { key: "department",   label: "Department",     type: "text",     sql: "department" },
      { key: "status",       label: "Status",         type: "status",   sql: "status" },
      { key: "priority",     label: "Priority",       type: "text",     sql: "priority" },
      { key: "flag",         label: "Flag",           type: "text",     sql: "flag" },
      { key: "amount",       label: "Amount (BDT)",   type: "money",    sql: "amount" },
      { key: "submitted_at", label: "Submitted",      type: "datetime", sql: "submitted_at" },
      { key: "decided_at",   label: "Decided",        type: "datetime", sql: "decided_at" },
      { key: "cycle_days",   label: "Cycle (days)",   type: "number",   sql: "cycle_days" },
      { key: "steps_total",  label: "Steps",          type: "number",   sql: "steps_total" },
      { key: "steps_done",   label: "Steps done",     type: "number",   sql: "steps_done" },
      { key: "waiting_on",   label: "Waiting on",     type: "text",     sql: "waiting_on" },
      { key: "overdue",      label: "Overdue",        type: "bool",     sql: "overdue" },
      { key: "late_steps",   label: "Late steps",     type: "number",   sql: "late_steps" },
    ],
  },
  steps: {
    label: "Approval steps",
    description: "One row per approval step: who was asked, when, by when, and when they answered.",
    dateColumn: "opened_at",
    defaultSort: "opened_at desc nulls last",
    columns: [
      { key: "reference",           label: "Reference",       type: "text",     sql: "reference" },
      { key: "form",                label: "Form",            type: "text",     sql: "form" },
      { key: "requester",           label: "Requester",       type: "text",     sql: "requester" },
      { key: "stage",               label: "Stage",           type: "text",     sql: "stage" },
      { key: "approver",            label: "Approver",        type: "text",     sql: "approver" },
      { key: "approver_department", label: "Approver's department", type: "text", sql: "approver_department" },
      { key: "status",              label: "Status",          type: "status",   sql: "status" },
      { key: "priority",            label: "Priority",        type: "text",     sql: "priority" },
      { key: "opened_at",           label: "Opened",          type: "datetime", sql: "opened_at" },
      { key: "deadline_at",         label: "Due",             type: "datetime", sql: "deadline_at" },
      { key: "acted_at",            label: "Decided",         type: "datetime", sql: "acted_at" },
      { key: "response_days",       label: "Response (days)", type: "number",   sql: "response_days" },
      { key: "on_time",             label: "On time",         type: "bool",     sql: "on_time" },
      { key: "overdue",             label: "Overdue now",     type: "bool",     sql: "overdue" },
      { key: "comment",             label: "Comment",         type: "text",     sql: "comment" },
    ],
  },
  approvers: {
    label: "Approver performance",
    description: "One row per approver: tasks assigned and completed, on-time rate, response time, what is outstanding.",
    dateColumn: "opened_at",
    defaultSort: "assigned desc",
    columns: [
      { key: "approver",            label: "Approver",          type: "text",    sql: "max(approver)" },
      { key: "approver_department", label: "Department",        type: "text",    sql: "max(approver_department)" },
      { key: "assigned",            label: "Assigned",          type: "number",  sql: "count(*)::int" },
      { key: "completed",           label: "Completed",         type: "number",  sql: "count(*) filter (where acted_at is not null)::int" },
      { key: "on_time",             label: "On time",           type: "number",  sql: "count(*) filter (where acted_at is not null and on_time)::int" },
      { key: "on_time_pct",         label: "On time (%)",       type: "percent", sql: "round(100.0 * count(*) filter (where acted_at is not null and on_time) / nullif(count(*) filter (where acted_at is not null), 0))" },
      { key: "avg_response_days",   label: "Avg response (days)", type: "number", sql: "round(avg(response_days) filter (where acted_at is not null), 1)" },
      { key: "pending",             label: "Pending",           type: "number",  sql: "count(*) filter (where status in ('pending', 'clarification'))::int" },
      { key: "overdue",             label: "Overdue now",       type: "number",  sql: "count(*) filter (where overdue)::int" },
    ],
  },
};

export type ReportValue = string | number | boolean | null;

/** A report's answer: its columns, its rows (at most 5,000), and whether there were more. */
export type ReportResult = {
  columns: { key: string; label: string; type: ColumnType }[];
  rows: Record<string, ReportValue>[];
  truncated: boolean;
};

export function columnsOf(dataset: Dataset): ColumnDef[] {
  return DATASETS[dataset]?.columns ?? [];
}

export function isDataset(v: unknown): v is Dataset {
  return v === "requests" || v === "steps" || v === "approvers";
}

// ---------------------------------------------------------------------
// Filters.
// ---------------------------------------------------------------------
export type Period = "all" | "last_30" | "last_90" | "this_month" | "last_month" | "this_year" | "custom";

export type ReportFilters = {
  period?: Period;
  from?: string;   // yyyy-mm-dd, for custom
  to?: string;
  status?: string[];
  form?: string[];
  department?: string[];
  priority?: string[];
  category?: string[];
  overdue?: boolean;
  on_time?: boolean;
  search?: string;
};

export const PERIODS: { value: Period; label: string }[] = [
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_year", label: "This year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Between dates" },
];

export const REQUEST_STATUSES = ["submitted", "in_progress", "on_hold", "completed", "rejected", "cancelled"];
export const STEP_STATUSES = ["waiting", "pending", "clarification", "approved", "rejected", "skipped"];
export const PRIORITIES = ["normal", "high", "urgent"];

export function periodLabel(f: ReportFilters): string {
  if (f.period === "custom") return `${f.from ? fmtDate(f.from) : "…"} – ${f.to ? fmtDate(f.to) : "…"}`;
  return PERIODS.find((p) => p.value === (f.period ?? "all"))?.label ?? "All time";
}

/** The filters in words, for the top of an exported file. */
export function describeFilters(f: ReportFilters): string {
  const parts = [periodLabel(f)];
  const list = (label: string, v?: string[]) => { if (v?.length) parts.push(`${label}: ${v.join(", ")}`); };
  list("Status", f.status);
  list("Form", f.form);
  list("Department", f.department);
  list("Priority", f.priority);
  list("Category", f.category);
  if (f.overdue !== undefined) parts.push(f.overdue ? "Overdue only" : "Not overdue");
  if (f.on_time !== undefined) parts.push(f.on_time ? "On time only" : "Late only");
  if (f.search) parts.push(`Matching "${f.search}"`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------
// Values, as every format shows them.
// ---------------------------------------------------------------------
const STATUS_WORDS: Record<string, string> = {
  in_progress: "In progress", on_hold: "On hold", submitted: "Submitted", completed: "Completed",
  rejected: "Rejected", cancelled: "Cancelled", pending: "Pending", waiting: "Waiting",
  clarification: "Clarification", approved: "Approved", skipped: "Skipped", draft: "Draft",
};

export function formatValue(v: unknown, type: ColumnType): string {
  if (v === null || v === undefined || v === "") return "";
  switch (type) {
    case "date": return fmtDate(String(v));
    case "datetime": return fmtDateTime(String(v));
    case "money": return Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
    case "number": return String(Number(v));
    case "percent": return `${Number(v)}%`;
    case "bool": return v === true || v === "true" ? "Yes" : "No";
    case "status": return STATUS_WORDS[String(v)] ?? String(v);
    default: return String(v);
  }
}
