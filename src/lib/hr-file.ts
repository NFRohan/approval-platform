// =====================================================================
// Reading the HR master file.
//
// A CSV as HR systems export it: a header row, quoted fields where they
// need them, commas or semicolons. Headers are matched loosely, so
// "Employee ID", "employee_id" and "Staff No" all find the same column.
// Pure, so it is tested without a browser.
// =====================================================================

/** A column the file does not have is absent from every row, so the import leaves it alone. */
export type HrRow = {
  employee_id: string;
  name: string;
  department?: string | null;
  designation?: string | null;
  line_manager_id?: string | null;
  email?: string | null;
};

/** RFC 4180, plus a semicolon delimiter when the header uses one. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const ALIASES: Record<keyof HrRow, string[]> = {
  employee_id:     ["employeeid", "empid", "employeeno", "employeenumber", "staffid", "staffno", "id"],
  name:            ["name", "fullname", "employeename", "displayname"],
  department:      ["department", "dept", "division", "unit"],
  designation:     ["designation", "title", "jobtitle", "position", "role"],
  line_manager_id: ["linemanagerid", "managerid", "linemanager", "manager", "reportsto", "supervisorid"],
  email:           ["email", "mail", "workemail", "emailaddress"],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

export type HrParse = { rows: HrRow[]; missing: string[]; columns: Partial<Record<keyof HrRow, string>> };

export function readHrFile(text: string): HrParse {
  const [header, ...body] = parseCsv(text);
  if (!header) return { rows: [], missing: ["employee_id", "name"], columns: {} };
  const heads = header.map(norm);
  const columns: Partial<Record<keyof HrRow, string>> = {};
  const index: Partial<Record<keyof HrRow, number>> = {};
  for (const key of Object.keys(ALIASES) as (keyof HrRow)[]) {
    const at = heads.findIndex((h) => ALIASES[key].includes(h));
    if (at >= 0) { index[key] = at; columns[key] = header[at].trim(); }
  }
  const missing = (["employee_id", "name"] as const).filter((k) => index[k] === undefined);
  if (missing.length) return { rows: [], missing: [...missing], columns };

  const get = (r: string[], k: keyof HrRow) => {
    const i = index[k];
    const v = i === undefined ? "" : (r[i] ?? "").trim();
    return v === "" ? null : v;
  };
  const optional = (["department", "designation", "line_manager_id", "email"] as const).filter((k) => index[k] !== undefined);
  const rows = body.map((r) => {
    const row: HrRow = { employee_id: get(r, "employee_id") ?? "", name: get(r, "name") ?? "" };
    for (const k of optional) row[k] = get(r, k);
    return row;
  });
  return { rows, missing: [], columns };
}
