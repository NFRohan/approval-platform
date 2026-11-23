// The pieces the report screens share: the filter bar, a multi-select,
// the results table, and the column picker.

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DATASETS, PERIODS, PRIORITIES, REQUEST_STATUSES, STEP_STATUSES, formatValue,
  type ColumnType, type Dataset, type ReportFilters,
} from "@/lib/report-catalogue";
import type { FilterOptions } from "@/lib/report-fn";

export const control: React.CSSProperties = {
  padding: "6px 9px", fontSize: 12.5, border: "1px solid #E4E4E7", borderRadius: 6,
  background: "#fff", color: "#18181B", fontFamily: "inherit",
};

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function MultiSelect({ label, options, value, onChange, format = (s) => s }: {
  label: string; options: string[]; value: string[] | undefined; onChange: (v: string[] | undefined) => void;
  format?: (s: string) => string;
}) {
  const chosen = value ?? [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filter by ${label.toLowerCase()}`}
          className="inline-flex items-center gap-1.5"
          style={{ ...control, cursor: "pointer", background: chosen.length ? "#EEF2FF" : "#fff", borderColor: chosen.length ? "#C7D2FE" : "#E4E4E7" }}
        >
          <span style={{ color: "#71717A" }}>{label}</span>
          {chosen.length > 0 && (
            <span style={{ fontWeight: 600, color: "#3730A3" }}>
              {chosen.length === 1 ? format(chosen[0]) : `${chosen.length} chosen`}
            </span>
          )}
          <ChevronDown size={12} style={{ color: "#A1A1AA" }} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {options.map((o) => {
            const on = chosen.includes(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => {
                  const next = on ? chosen.filter((x) => x !== o) : [...chosen, o];
                  onChange(next.length ? next : undefined);
                }}
                className="flex items-center gap-2 w-full rounded-md text-left hover:bg-zinc-100"
                style={{ padding: "6px 8px", fontSize: 12.5, border: "none", background: "transparent", cursor: "pointer" }}
              >
                <span className="inline-flex items-center justify-center rounded" style={{ width: 15, height: 15, border: `1px solid ${on ? "#4F46E5" : "#D4D4D8"}`, background: on ? "#4F46E5" : "#fff" }}>
                  {on && <Check size={11} color="#fff" />}
                </span>
                {format(o)}
              </button>
            );
          })}
          {options.length === 0 && <div style={{ padding: 8, fontSize: 12, color: "#A1A1AA" }}>Nothing to choose from.</div>}
        </div>
        {chosen.length > 0 && (
          <button type="button" onClick={() => onChange(undefined)} style={{ width: "100%", marginTop: 4, padding: "6px", fontSize: 12, color: "#71717A", border: "none", borderTop: "1px solid #F4F4F5", background: "transparent", cursor: "pointer" }}>
            Clear
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One row of filters above the table. Which ones appear depends on the dataset. */
export function FilterBar({ dataset, filters, onChange, options }: {
  dataset: Dataset; filters: ReportFilters; onChange: (f: ReportFilters) => void; options: FilterOptions | null;
}) {
  const set = (patch: Partial<ReportFilters>) => onChange({ ...filters, ...patch });
  const [search, setSearch] = useState(filters.search ?? "");
  const statuses = dataset === "requests" ? REQUEST_STATUSES : STEP_STATUSES;
  const active = Object.entries(filters).filter(([k, v]) => k !== "period" && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)).length;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="report-filters">
      <select aria-label="Period" style={control} value={filters.period ?? "all"} onChange={(e) => set({ period: e.target.value as ReportFilters["period"] })}>
        {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      {filters.period === "custom" && (
        <>
          <input type="date" aria-label="From" style={control} value={filters.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
          <span style={{ color: "#A1A1AA", fontSize: 12 }}>to</span>
          <input type="date" aria-label="To" style={control} value={filters.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
        </>
      )}
      {dataset !== "approvers" && (
        <MultiSelect label="Status" options={statuses} value={filters.status} onChange={(v) => set({ status: v })} format={titleCase} />
      )}
      <MultiSelect label="Form" options={options?.forms ?? []} value={filters.form} onChange={(v) => set({ form: v })} />
      <MultiSelect label="Department" options={options?.departments ?? []} value={filters.department} onChange={(v) => set({ department: v })} />
      {dataset !== "approvers" && (
        <MultiSelect label="Priority" options={PRIORITIES} value={filters.priority} onChange={(v) => set({ priority: v })} format={titleCase} />
      )}
      {dataset === "requests" && (
        <MultiSelect label="Category" options={options?.categories ?? []} value={filters.category} onChange={(v) => set({ category: v })} />
      )}
      {dataset === "steps" && (
        <select aria-label="On time" style={control} value={filters.on_time === undefined ? "" : String(filters.on_time)}
          onChange={(e) => set({ on_time: e.target.value === "" ? undefined : e.target.value === "true" })}>
          <option value="">On time or late</option>
          <option value="true">On time only</option>
          <option value="false">Late only</option>
        </select>
      )}
      {dataset !== "approvers" && (
        <label className="inline-flex items-center gap-1.5" style={{ fontSize: 12.5, color: "#52525B" }}>
          <input type="checkbox" checked={filters.overdue === true} onChange={(e) => set({ overdue: e.target.checked ? true : undefined })} />
          Overdue now
        </label>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); set({ search: search.trim() || undefined }); }}
        className="inline-flex items-center gap-1" style={{ ...control, padding: "0 8px", marginLeft: "auto" }}
      >
        <Search size={13} style={{ color: "#A1A1AA" }} />
        <input
          aria-label="Search the report"
          placeholder={dataset === "approvers" ? "Find an approver" : "Reference, form, person"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onBlur={() => set({ search: search.trim() || undefined })}
          style={{ border: "none", outline: "none", padding: "6px 0", fontSize: 12.5, width: 170, background: "transparent" }}
        />
      </form>
      {active > 0 && (
        <button type="button" onClick={() => { setSearch(""); onChange({ period: filters.period, from: filters.from, to: filters.to }); }}
          className="inline-flex items-center gap-1" style={{ ...control, border: "none", color: "#71717A", cursor: "pointer", background: "transparent" }}>
          <X size={12} /> Clear filters
        </button>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, [string, string]> = {
  completed: ["#F0FDF4", "#15803D"], approved: ["#F0FDF4", "#15803D"],
  rejected: ["#FEF2F2", "#B91C1C"], cancelled: ["#F4F4F5", "#71717A"], skipped: ["#F4F4F5", "#71717A"],
  pending: ["#FFFBEB", "#B45309"], clarification: ["#FFFBEB", "#B45309"], on_hold: ["#FFFBEB", "#B45309"],
  in_progress: ["#EEF2FF", "#4338CA"], submitted: ["#EFF6FF", "#1D4ED8"], waiting: ["#F4F4F5", "#52525B"],
};

export function Cell({ value, type }: { value: unknown; type: ColumnType }) {
  if (value === null || value === undefined || value === "") return <span style={{ color: "#D4D4D8" }}>—</span>;
  if (type === "status") {
    const [bg, fg] = STATUS_TONE[String(value)] ?? ["#F4F4F5", "#52525B"];
    return <span className="rounded-full" style={{ padding: "1px 8px", fontSize: 11.5, fontWeight: 500, background: bg, color: fg, whiteSpace: "nowrap" }}>{formatValue(value, type)}</span>;
  }
  if (type === "bool") {
    const yes = value === true;
    return <span style={{ color: yes ? "#15803D" : "#A1A1AA", fontWeight: 500 }}>{yes ? "Yes" : "No"}</span>;
  }
  return <>{formatValue(value, type)}</>;
}

export function ResultTable({ columns, rows, sort, onSort, truncated }: {
  columns: { key: string; label: string; type: ColumnType }[];
  rows: Record<string, unknown>[];
  sort?: { key: string; dir: "asc" | "desc" };
  onSort?: (s: { key: string; dir: "asc" | "desc" }) => void;
  truncated?: boolean;
}) {
  const [page, setPage] = useState(0);
  const per = 100;
  const shown = rows.slice(page * per, page * per + per);
  const pages = Math.ceil(rows.length / per);
  const right = (t: ColumnType) => t === "number" || t === "money" || t === "percent";

  return (
    <div>
      <div style={{ overflowX: "auto", border: "1px solid #E4E4E7", borderRadius: 10, background: "#fff" }}>
        <table className="w-full" style={{ borderCollapse: "collapse", fontSize: 12.5 }} data-testid="report-table">
          <thead>
            <tr style={{ background: "#FAFAFA" }}>
              {columns.map((c) => {
                const on = sort?.key === c.key;
                return (
                  <th key={c.key} style={{ textAlign: right(c.type) ? "right" : "left", padding: "9px 12px", fontWeight: 600, color: "#52525B", borderBottom: "1px solid #E4E4E7", whiteSpace: "nowrap", position: "sticky", top: 0, background: "#FAFAFA" }}>
                    <button
                      type="button"
                      onClick={() => onSort?.({ key: c.key, dir: on && sort?.dir === "desc" ? "asc" : "desc" })}
                      className="inline-flex items-center gap-1"
                      style={{ border: "none", background: "transparent", cursor: onSort ? "pointer" : "default", font: "inherit", color: "inherit", padding: 0 }}
                    >
                      {c.label}
                      {on && (sort?.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} style={{ borderTop: i ? "1px solid #F4F4F5" : undefined }}>
                {columns.map((c) => (
                  <td key={c.key} style={{ padding: "8px 12px", textAlign: right(c.type) ? "right" : "left", color: "#27272A", whiteSpace: c.key === "comment" || c.key === "waiting_on" ? "normal" : "nowrap", fontVariantNumeric: right(c.type) ? "tabular-nums" : undefined }}>
                    <Cell value={r[c.key]} type={c.type} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} style={{ padding: "36px 12px", textAlign: "center", color: "#A1A1AA" }}>Nothing matches these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between" style={{ marginTop: 8, fontSize: 12, color: "#71717A" }}>
        <span data-testid="row-count">
          {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
          {truncated && " — only the first 5,000; narrow the filters for the rest"}
        </span>
        {pages > 1 && (
          <span className="inline-flex items-center gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} style={{ ...control, padding: "3px 8px", cursor: "pointer" }}>Previous</button>
            {page + 1} of {pages}
            <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} style={{ ...control, padding: "3px 8px", cursor: "pointer" }}>Next</button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Choose columns and their order. */
export function ColumnPicker({ dataset, value, onChange }: { dataset: Dataset; value: string[]; onChange: (v: string[]) => void }) {
  const all = DATASETS[dataset].columns;
  const chosen = value.filter((k) => all.some((c) => c.key === k));
  const rest = all.filter((c) => !chosen.includes(c.key));
  const label = (k: string) => all.find((c) => c.key === k)?.label ?? k;
  const move = (i: number, d: -1 | 1) => {
    const next = [...chosen];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }} data-testid="column-picker">
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: "#71717A", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>Shown, in order</div>
        <div className="flex flex-col gap-1">
          {chosen.map((k, i) => (
            <div key={k} className="flex items-center gap-1.5 rounded-md" style={{ padding: "5px 8px", background: "#EEF2FF", border: "1px solid #C7D2FE", fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>{label(k)}</span>
              <IconBtn label={`Move ${label(k)} up`} disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size={13} /></IconBtn>
              <IconBtn label={`Move ${label(k)} down`} disabled={i === chosen.length - 1} onClick={() => move(i, 1)}><ChevronDown size={13} /></IconBtn>
              <IconBtn label={`Remove ${label(k)}`} onClick={() => onChange(chosen.filter((x) => x !== k))}><X size={13} /></IconBtn>
            </div>
          ))}
          {chosen.length === 0 && <div style={{ fontSize: 12, color: "#A1A1AA" }}>Add at least one column.</div>}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: "#71717A", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>Available</div>
        <div className="flex flex-wrap gap-1.5">
          {rest.map((c) => (
            <button key={c.key} type="button" name={`add-column-${c.key}`} onClick={() => onChange([...chosen, c.key])}
              className="rounded-full" style={{ padding: "3px 10px", fontSize: 12, border: "1px dashed #D4D4D8", background: "#fff", color: "#52525B", cursor: "pointer" }}>
              + {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, onClick, disabled, label }: { children: ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      style={{ border: "none", background: "transparent", padding: 2, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.3 : 1, display: "inline-flex", color: "#4338CA" }}>
      {children}
    </button>
  );
}

/** People, for choosing who a report goes to. */
export function PeoplePicker({ people, value, onChange }: {
  people: { id: string; name: string; designation: string | null }[]; value: string[]; onChange: (v: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return people.filter((p) => !value.includes(p.id) && (!s || p.name.toLowerCase().includes(s) || (p.designation ?? "").toLowerCase().includes(s))).slice(0, 8);
  }, [people, value, q]);
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full" style={{ padding: "2px 4px 2px 9px", fontSize: 12, background: "#F4F4F5", border: "1px solid #E4E4E7" }}>
            {name(id)}
            <button type="button" aria-label={`Remove ${name(id)}`} onClick={() => onChange(value.filter((x) => x !== id))}
              style={{ border: "none", background: "transparent", cursor: "pointer", display: "inline-flex", padding: 2 }}><X size={11} /></button>
          </span>
        ))}
        {value.length === 0 && <span style={{ fontSize: 12, color: "#A1A1AA" }}>Nobody yet</span>}
      </div>
      <input placeholder="Add somebody" aria-label="Add a recipient" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...control, width: "100%" }} />
      {q && (
        <div className="flex flex-col" style={{ border: "1px solid #E4E4E7", borderRadius: 6 }}>
          {matches.map((p) => (
            <button key={p.id} type="button" onClick={() => { onChange([...value, p.id]); setQ(""); }}
              className="text-left hover:bg-zinc-50" style={{ padding: "6px 9px", fontSize: 12.5, border: "none", background: "transparent", cursor: "pointer" }}>
              {p.name} <span style={{ color: "#A1A1AA" }}>{p.designation}</span>
            </button>
          ))}
          {matches.length === 0 && <div style={{ padding: 8, fontSize: 12, color: "#A1A1AA" }}>Nobody by that name.</div>}
        </div>
      )}
    </div>
  );
}

/** The download link for what the screen is showing. */
export function exportHref(id: string, format: "xlsx" | "pdf" | "csv", opts: { dataset?: Dataset; columns: string[]; filters: ReportFilters; sort?: { key: string; dir: string } }) {
  const p = new URLSearchParams({ format, f: JSON.stringify(opts.filters), c: opts.columns.join(",") });
  if (opts.sort) p.set("s", `${opts.sort.key}:${opts.sort.dir}`);
  if (opts.dataset) p.set("d", opts.dataset);
  return `/exports/report/${id}?${p.toString()}`;
}
