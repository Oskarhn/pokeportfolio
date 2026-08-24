/**
 * Money, NULL-honesty and precision semantics the M13 backup/export pipeline must satisfy.
 * Derived from FINANCIAL_MODEL.md §1 (integer minor units + ISO 4217, never float), invariant M1
 * (NULL means "not applicable", never zero) and the project's bigint-serialization boundary —
 * not from any implementation.
 */

/**
 * Serialize integer minor units for the JSON backup as a DECIMAL STRING.
 *
 * Rationale: PostgREST returns int8 columns as JSON numbers, and JSON numbers past 2^53 lose
 * precision the moment any JS runtime parses them. A backup is the artifact most likely to be
 * re-read years later by unknown tooling; string-wrapped integers are immune and match the
 * convention every money-returning RPC already uses at this boundary.
 */
export function serializeMinorUnits(value: bigint): string {
  return value.toString(10)
}

/** The canonical adversarial value: 2^53 + 1 — the smallest positive integer JSON.parse corrupts. */
export const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n

/**
 * Demonstrates (does not assert) exactly how a number-encoded pipeline loses this row: useful in
 * tests as the contrast case proving why string encoding is mandatory.
 */
export function corruptViaJsonNumber(value: bigint): bigint {
  return BigInt(Math.trunc(JSON.parse(JSON.stringify(Number(value))) as number))
}

/**
 * Timestamps must travel VERBATIM. `timestamptz` values arrive from PostgREST as RFC 3339 strings
 * that can carry sub-microsecond... microsecond precision; a round-trip through `new Date()`
 * truncates to milliseconds and localizes. A restore author comparing `created_at` against the
 * live database would find silently shifted history. The contract: string equality with what the
 * database returned.
 */
export const TIMESTAMP_PRECISION_CASES: readonly { name: string; wire: string }[] = [
  { name: 'whole seconds', wire: '2026-08-24T12:00:00Z' },
  { name: 'milliseconds', wire: '2026-08-24T12:00:00.123Z' },
  { name: 'microseconds', wire: '2026-08-24T12:00:00.123456+00:00' },
]

export function timestampWouldSurviveDateRoundTrip(wire: string): boolean {
  return new Date(wire).toISOString() === wire
}

/**
 * The REAL corruption test: does a Date round-trip lose precision (not merely reformat)?
 * A whole-second wire gains '.000' (formatting only, same instant, no information lost);
 * sub-millisecond digits are DESTROYED by Date. The backup contract forbids the second case:
 * timestamps travel as verbatim strings, never through a Date.
 */
export function timestampPrecisionLoss(wire: string): boolean {
  const parsed = new Date(wire)
  if (Number.isNaN(parsed.getTime())) return true
  const match = /\.(\d+)/.exec(wire)
  const fractionDigits = match?.[1] ?? ''
  // Any non-zero digit beyond milliseconds cannot survive a Date.
  return fractionDigits.length > 3 && /[1-9]/.test(fractionDigits.slice(3))
}

/**
 * NULL honesty case table (prompt §5): each entry states a stored state and the ONLY acceptable
 * backup representation. "0" where the database stores NULL is the project's cardinal sin
 * (invariant M1): it fabricates "worth nothing" / "cost nothing".
 */
export interface NullHonestyCase {
  readonly name: string
  readonly storedSqlValue: 'NULL' | '0' | 'NEGATIVE'
  readonly columnExample: string
  readonly requiredRepresentation: 'null' | 'zero' | 'negative-number'
}

export const NULL_HONESTY_CASES: readonly NullHonestyCase[] = [
  {
    name: 'gift lot has no unit cost basis',
    storedSqlValue: 'NULL',
    columnExample: 'acquisition_lots.unit_cost_basis_minor',
    requiredRepresentation: 'null',
  },
  {
    name: 'unknown-basis sale line freezes NULL cost basis and NULL result together',
    storedSqlValue: 'NULL',
    columnExample: 'sale_lines.cost_basis_at_sale_nok_minor',
    requiredRepresentation: 'null',
  },
  {
    name: 'manual valuation absent for an unpriced holding',
    storedSqlValue: 'NULL',
    columnExample: 'holdings.notes',
    requiredRepresentation: 'null',
  },
  {
    name: 'genuine zero discount is data, not absence',
    storedSqlValue: '0',
    columnExample: 'purchases.discount_minor',
    requiredRepresentation: 'zero',
  },
  {
    name: 'a sale can genuinely net a loss',
    storedSqlValue: 'NEGATIVE',
    columnExample: 'sales.net_proceeds_minor',
    requiredRepresentation: 'negative-number',
  },
]
