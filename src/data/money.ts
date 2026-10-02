/**
 * The bigint <-> PostgREST money boundary (FINANCIAL_MODEL.md §1; docs/DECISIONS.md D-137).
 *
 * THE CONTRACT: a money amount is an integer count of minor units. Inside the application it is a
 * `bigint`. Across the JSON wire it is a DECIMAL INTEGER STRING — never a JSON number — in both
 * directions. Postgres `bigint` covers ±9.2e18; a JavaScript number only holds integers exactly up
 * to 2^53 - 1 (about 9.0e15), and `JSON.parse` / `Number()` round everything above that without
 * any error. Measured against the real local stack in tests/db/p146_transport_layers.test.ts:
 *
 *   Postgres          exact                          (select total_minor::text)
 *   PostgREST body    exact digits on the wire        ({"total_minor":9007199254740993})
 *   JSON.parse        LOST — first layer to lose it   (9007199254740992)
 *
 * so a value has to be a string BEFORE the response body is parsed:
 *
 *   OUTPUT  every money column is selected `col::text`, and every SQL function that returns money
 *           declares the column `text`. `parseMinorUnits` then reads the exact digits.
 *   INPUT   a bigint is serialised to a decimal string (`serializeMinorUnits` / `moneyArg`).
 *           PostgREST casts a JSON string to a bigint parameter, and to a `->> '...'::bigint`
 *           field inside a jsonb argument, exactly (verified, same test file).
 *
 * Two independent guards keep this from regressing silently:
 *   - `parseMinorUnits` refuses a JSON number that is not a safe integer instead of "recovering"
 *     it with `BigInt(number)`, which would preserve the already-rounded value;
 *   - src/data/exact-json-guard.ts (installed on the app's fetch) rejects any request or response
 *     body that carries an integer literal outside the safe range, whatever field it is in.
 *
 * There is no `Number(<money>)` in src/data. `Number(<bigint>)` is allowed only where a chart
 * library needs a coordinate; it is documented as non-authoritative there and never feeds back
 * into a ledger value (src/domain/dashboard.ts `chartMajorUnits`).
 */

export class MoneyTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyTransportError'
  }
}

/** The range a stored money amount can have: Postgres `bigint`. Anything outside it is refused
 *  before a request is built — the server would refuse it too (`bigint out of range`). */
export const LEDGER_MINOR_MIN = -(2n ** 63n)
export const LEDGER_MINOR_MAX = 2n ** 63n - 1n

/** A canonical decimal integer: optional minus, no plus, no leading zeros, no `-0`, no decimal
 *  point, no exponent, no whitespace, no hex/octal/binary prefix. Exactly what Postgres prints
 *  for a bigint (`BigInt('')`, `BigInt(' 12 ')` and `BigInt('0x10')` all "succeed" — this does not). */
const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/

/**
 * Reads a money amount that crossed the wire.
 *
 * A string must be a canonical decimal integer of ANY length: an aggregate the server computed in
 * `numeric` may legitimately exceed the bigint range, and it is still exact here. A number is
 * accepted only when it is a safe integer, i.e. when it cannot have been rounded on the way in;
 * an unsafe number is refused, never converted — `BigInt(9007199254740992)` is the wrong value
 * wearing the right type.
 */
export function parseMinorUnits(value: string | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyTransportError(
        `refusing to read ${String(value)} as minor units: a JSON number outside ` +
          `±${String(Number.MAX_SAFE_INTEGER)} may already be rounded, money must arrive as text`,
      )
    }
    return BigInt(value)
  }
  if (typeof value !== 'string' || !CANONICAL_INTEGER.test(value)) {
    throw new MoneyTransportError(
      `not a canonical decimal integer of minor units: ${describe(value)}`,
    )
  }
  return BigInt(value)
}

/** NULL is "not applicable / unknown" and stays `null`; a stored 0 is a known zero and stays
 *  `0n`. The two are never exchanged (FINANCIAL_MODEL.md §1.1). `undefined` is treated as absent
 *  for the same reason. */
export function parseNullableMinorUnits(value: string | number | null | undefined): bigint | null {
  return value === null || value === undefined ? null : parseMinorUnits(value)
}

/**
 * Serialises a money amount for the wire: a canonical decimal string, refused when it is outside
 * what the ledger can hold. There is deliberately no overload that accepts a `number`.
 */
export function serializeMinorUnits(value: bigint): string {
  if (typeof value !== 'bigint') {
    throw new MoneyTransportError(`money must be a bigint, got ${typeof value}`)
  }
  if (value < LEDGER_MINOR_MIN || value > LEDGER_MINOR_MAX) {
    throw new MoneyTransportError(
      `amount ${value.toString()} is outside the supported money range ` +
        `(${LEDGER_MINOR_MIN.toString()} to ${LEDGER_MINOR_MAX.toString()} minor units)`,
    )
  }
  return value.toString()
}

/** `undefined` stays `undefined` so the key is omitted from the request (the server default
 *  applies); it is never turned into 0. */
export function serializeOptionalMinorUnits(value: bigint | undefined): string | undefined {
  return value === undefined ? undefined : serializeMinorUnits(value)
}

/**
 * A money argument for an RPC parameter typed `bigint`.
 *
 * The generated `Database` types (database.types.ts) describe every `bigint` parameter as
 * `number` — that is PostgREST's *output* representation, and the one this project must not use
 * for money. The parameter accepts a decimal string equally well (see the header), so this returns
 * the string under the generated type. The disagreement between the generated type and the wire is
 * confined to these two functions on purpose; tests/data/money.test.ts pins that the value is a
 * string at runtime and tests/data/money-wire-structure.test.ts pins that nothing else in
 * src/data converts money with `Number()`.
 */
export function moneyArg(value: bigint): number {
  return serializeMinorUnits(value) as unknown as number
}

export function optionalMoneyArg(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : moneyArg(value)
}

function describe(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

const DECIMAL_TEXT = /^(-?[0-9]+)(?:\.([0-9]+))?$/

/**
 * A `numeric` rate (fx_rate_to_nok, numeric(18,8)) read as Postgres text, with trailing fractional
 * zeros removed for display: "11.50000000" -> "11.5", "1.00000000" -> "1". String surgery only.
 * The same column read through PostgREST's default JSON number would be a double — 18 significant
 * digits do not fit in one — and would be re-sent on the next edit, so rates are read `::text` too.
 */
export function normalizeDecimalText(value: string): string {
  const match = DECIMAL_TEXT.exec(value)
  if (!match) throw new MoneyTransportError(`not a decimal number: ${describe(value)}`)
  const whole = match[1] as string
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}
