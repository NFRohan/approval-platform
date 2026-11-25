// A cell starting with = + - @ (or a tab or carriage return) is a formula to
// a spreadsheet — whoever typed it into a request could run it on whoever
// opens the export. It is prefixed with a quote so it stays text, as the
// server's exports do (src/server/export.ts). Numbers are left alone.
export function escapeCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: { key: keyof T; label: string }[],
): string {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => escapeCsvCell(row[c.key])).join(","));
  return [header, ...lines].join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
