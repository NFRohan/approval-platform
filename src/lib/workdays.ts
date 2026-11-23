// =====================================================================
// The calendar the organisation works to.
//
// Two rules the database already applies, mirrored here for the screens
// that have to show or filter by the same dates before asking it:
//
//   * the day is the one on the wall in Dhaka, not in UTC — at UTC+6,
//     `new Date().toISOString().slice(0, 10)` is tomorrow from 18:00;
//   * the weekend is Friday and Saturday;
//   * and the organisation's holidays (public.holidays) are not worked
//     either — loaded once per page with loadOrgHolidays().
//
// app.add_working_days and app.may_act in db/005_chain.sql are the
// authority. If either rule changes, it changes there first.
// =====================================================================

export const ORG_TIME_ZONE = "Asia/Dhaka";

/** Friday and Saturday, as `Date.getUTCDay()` numbers them. */
const WEEKEND = new Set([5, 6]);

/** Today's date in Dhaka, as YYYY-MM-DD — the form `date` columns take. */
export function todayInOrg(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ORG_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The weekday in Dhaka, 0 = Sunday … 6 = Saturday. */
function orgWeekday(d: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: ORG_TIME_ZONE, weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

// The organisation's holidays, as YYYY-MM-DD. Empty until loaded, when
// only the weekend is skipped — what the database did before holidays.
let holidays = new Set<string>();
export function setOrgHolidays(days: Iterable<string>) { holidays = new Set(days); }

/** Fetch the working calendar once, for pages that preview a deadline. */
let loading: Promise<void> | null = null;
export function loadOrgHolidays(): Promise<void> {
  loading ??= import("./db").then(async ({ db }) => {
    const { data } = await db.from("holidays").select("on_date").limit(2000);
    setOrgHolidays(((data ?? []) as { on_date: string }[]).map((h) => h.on_date));
  }).catch(() => { loading = null; });
  return loading;
}

/** Whether a day is worked: not Friday or Saturday, and not a holiday. */
export function isWorkingDay(d: Date, extra: ReadonlySet<string> = holidays): boolean {
  return !WEEKEND.has(orgWeekday(d)) && !extra.has(todayInOrg(d));
}

/** `days` working days after `from`, skipping Fridays, Saturdays and holidays. */
export function addWorkingDays(from: Date, days: number, days_off: ReadonlySet<string> = holidays): Date {
  const d = new Date(from.getTime());
  let n = 0;
  while (n < days) {
    d.setTime(d.getTime() + 86_400_000);
    if (isWorkingDay(d, days_off)) n += 1;
  }
  return d;
}
