// =====================================================================
// The calendar the organisation works to.
//
// Two rules the database already applies, mirrored here for the screens
// that have to show or filter by the same dates before asking it:
//
//   * the day is the one on the wall in Dhaka, not in UTC — at UTC+6,
//     `new Date().toISOString().slice(0, 10)` is tomorrow from 18:00;
//   * the weekend is Friday and Saturday.
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

/** `days` working days after `from`, skipping Fridays and Saturdays. */
export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let n = 0;
  while (n < days) {
    d.setTime(d.getTime() + 86_400_000);
    if (!WEEKEND.has(orgWeekday(d))) n += 1;
  }
  return d;
}
