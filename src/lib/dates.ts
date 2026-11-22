// =====================================================================
// How dates are written: dd/MM/yyyy.
//
// "All date fields should be in dd MM yyyy format." Every screen had its
// own formatter, most of them American — "Nov 22, 2026" on one page,
// "22 Nov 2026" on the next. They all come here now, and all on Dhaka's
// calendar, so a time just after midnight there is not shown as the day
// before.
//
// A bare YYYY-MM-DD (a date answer, a delegation window) is a calendar
// date with no time zone and is written as it stands; anything with a
// time is placed in Dhaka first.
// =====================================================================

import { ORG_TIME_ZONE } from "@/lib/workdays";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(d: Date) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: ORG_TIME_ZONE,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { day: get("day"), month: get("month"), year: get("year"), hour: get("hour"), minute: get("minute") };
}

function toDate(v: string | Date): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 22/11/2026. Empty input gives "—". */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  if (typeof v === "string") {
    const m = DATE_ONLY.exec(v);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  const d = toDate(v);
  if (!d) return String(v);
  const p = parts(d);
  return `${p.day}/${p.month}/${p.year}`;
}

/** 22/11/2026 14:05, in Dhaka. */
export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  if (typeof v === "string" && DATE_ONLY.test(v)) return fmtDate(v);
  const d = toDate(v);
  if (!d) return String(v);
  const p = parts(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** A stored answer that is a date is written as one; anything else is left alone. */
export function fmtIfDate(v: string | null | undefined): string | null | undefined {
  return typeof v === "string" && DATE_ONLY.test(v) ? fmtDate(v) : v;
}
