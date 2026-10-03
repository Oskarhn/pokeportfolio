/**
 * Client-side mirror of the server's completed-event date contract (P144's migration
 * `20260918120000_p144_financial_boundary_semantics.sql`, `enforce_completed_event_date()`): a
 * completed ledger event's date is a calendar date in [1996-10-20, today]. 1996-10-20 is the Base
 * Set's Japan release date — nothing this ledger can record predates the product. The server itself
 * accepts up to (UTC today + 1 day) since it does not know the caller's timezone; this client is
 * deliberately stricter (max = the device's own local calendar today), matching the released web
 * forms' convention, so a person is never offered a date the server would refuse.
 *
 * MUST use the device's LOCAL calendar date, never `Date#toISOString()` (which is UTC): a person in
 * Oslo between local midnight and ~01:00-02:00 (the UTC offset) would otherwise see "today" reported
 * as yesterday, and a date they just picked as today could round-trip as invalid. `getFullYear`,
 * `getMonth` and `getDate` are local-timezone accessors in JavaScript; this file uses only those.
 */

export const EARLIEST_EVENT_DATE = '1996-10-20'

function pad(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n)
}

/** `YYYY-MM-DD` for `date`'s LOCAL calendar day (defaults to now). */
export function localDateIso(date: Date = new Date()): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Today, in the device's own local calendar — the form's default and its upper bound. */
export function localTodayIso(): string {
  return localDateIso(new Date())
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export class InvalidEventDateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEventDateError'
  }
}

/**
 * Throws unless `iso` is a `YYYY-MM-DD` calendar date within [1996-10-20, local today]. String
 * comparison is exact and timezone-free once both sides are canonical `YYYY-MM-DD` text — no `Date`
 * arithmetic, so there is no additional place a UTC/local slip could be introduced here.
 */
export function assertValidEventDate(iso: string, today: string = localTodayIso()): void {
  if (!DATE_ONLY.test(iso)) {
    throw new InvalidEventDateError('Enter a valid date (YYYY-MM-DD).')
  }
  if (iso < EARLIEST_EVENT_DATE) {
    throw new InvalidEventDateError(
      `This date is before the first Pokémon Trading Card Game product (${EARLIEST_EVENT_DATE}).`,
    )
  }
  if (iso > today) {
    throw new InvalidEventDateError('This date is in the future.')
  }
}
