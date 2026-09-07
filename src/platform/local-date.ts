/**
 * The single "what does the user's own calendar say today is" helper.
 *
 * P114: `new Date().toISOString().slice(0, 10)` was duplicated across roughly ten call sites to
 * default date-only financial fields (purchase date, sale date, opening date, acquired-on) to
 * "today". `toISOString()` always converts to UTC first, which shifts the reported calendar day
 * for any positive UTC offset — including every timezone Norway uses (CET/UTC+1, CEST/UTC+2) —
 * during the hours after local midnight but before UTC midnight. A person opening the purchase
 * form at, say, 00:30 local time got "yesterday" silently defaulted into a date-only financial
 * fact they never typed themselves.
 *
 * The domain layer deliberately never touches `Date` at all (FINANCIAL_MODEL.md date-only fields
 * travel as plain YYYY-MM-DD strings and stay timezone-agnostic once entered) — "what is today,
 * here, right now" is a UI-layer question, which is why this lives in `platform/`, not `domain/`.
 */
export function localTodayIso(): string {
  const now = new Date()
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
