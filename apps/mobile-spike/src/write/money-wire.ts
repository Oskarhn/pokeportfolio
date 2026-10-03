/**
 * The bigint <-> PostgREST WRITE boundary for the finance write seam (P175). Ported (not imported)
 * from the unreleased web `src/data/money.ts` (branch fix/p146-exact-bigint-money): the released
 * base's own `src/data/money.ts` predates that fix and has neither `moneyArg` nor
 * `serializeMinorUnits`'s range check, so `@shared/data/money` cannot be used here without silently
 * depending on an unmerged branch. Reading money back off the wire already goes through
 * `money/wire.ts`'s `parseMinorUnitsWire` (P173); this file is the missing WRITE half.
 *
 * THE CONTRACT: a money amount is an integer count of minor units. Inside the app it is a
 * `bigint`. Across the JSON wire it is a DECIMAL INTEGER STRING, never a JSON number: PostgREST
 * casts a JSON string to a `bigint` RPC parameter, and to a `->> '...'::bigint` field inside a
 * jsonb argument, exactly. There is deliberately no overload that accepts a `number`.
 */

export class MoneyWireError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyWireError'
  }
}

/** The range a stored money amount can have: Postgres `bigint`. Refused client-side before a
 *  request is built — the server would refuse it too ("bigint out of range"). */
export const LEDGER_MINOR_MIN = -(2n ** 63n)
export const LEDGER_MINOR_MAX = 2n ** 63n - 1n

/**
 * Serialises a money amount for the wire: a canonical decimal string, refused when it is outside
 * what the ledger can hold or is not actually a `bigint` (a plain `number` is a caller bug, not a
 * value to coerce).
 */
export function serializeMinorUnits(value: bigint): string {
  if (typeof value !== 'bigint') {
    throw new MoneyWireError(`money must be a bigint, got ${typeof value}`)
  }
  if (value < LEDGER_MINOR_MIN || value > LEDGER_MINOR_MAX) {
    throw new MoneyWireError(
      `amount ${value.toString()} is outside the supported money range ` +
        `(${LEDGER_MINOR_MIN.toString()} to ${LEDGER_MINOR_MAX.toString()} minor units)`,
    )
  }
  return value.toString()
}

/** `undefined` stays `undefined` (the key is omitted, the server default applies) — never turned
 *  into a serialized zero. */
export function serializeOptionalMinorUnits(value: bigint | undefined): string | undefined {
  return value === undefined ? undefined : serializeMinorUnits(value)
}

/**
 * A money argument for an RPC parameter the generated types describe as `number` (PostgREST's
 * *output* representation of `bigint`, which this project must never use for a WRITE). The
 * parameter accepts a decimal string equally well; this return type is deliberately dishonest
 * (`string` under `number`) so the call site type-checks against the generated `Database` type
 * while the wire carries the exact string. Pinned by tests/unit/money-wire.test.ts.
 */
export function moneyArg(value: bigint): number {
  return serializeMinorUnits(value) as unknown as number
}

export function optionalMoneyArg(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : moneyArg(value)
}
