/**
 * Calendar-safe fixture dates for database suites.
 *
 * The purchase date trigger rejects a business date after today + 1 day, so a fixture that
 * assumes "the 10th of the current month" is invalid on days 1-8 of every month. The helpers
 * here build the date from year/month arithmetic (never `setUTCMonth` followed by `setUTCDate`,
 * which overflows: 31 March minus one month is "31 February" = 3 March).
 */

/** Day used for a past month: mid-month, inside the month on every calendar. */
const PAST_MONTH_DAY = 10

/**
 * An ISO date (YYYY-MM-DD) that lies in the calendar month `monthsAgo` months before `now`'s
 * month and is never later than `now`. The current month uses day 1, which is `<= today` on
 * every day of the month; earlier months use day 10, which exists in every month.
 */
export function monthlyFixtureDate(now: Date, monthsAgo: number): string {
  if (!Number.isInteger(monthsAgo) || monthsAgo < 0) {
    throw new Error(`monthsAgo must be a non-negative integer, got ${String(monthsAgo)}`)
  }
  const day = monthsAgo === 0 ? 1 : PAST_MONTH_DAY
  // Date.UTC normalises a negative month index into the previous year(s).
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day))
  return d.toISOString().slice(0, 10)
}
