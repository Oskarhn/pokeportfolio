/**
 * Reading money that arrives from the network (PostgREST / Edge Function JSON).
 *
 * The transport contract (src/data/money.ts in the web app) is: every money column travels as a
 * decimal STRING. A JSON number above 2^53-1 has already been rounded by JSON.parse before any
 * application code runs, so it can only be refused, not repaired. This module is the last line for
 * values the app parses itself; the fetch-level guard (net/exact-transport-guard.ts) refuses the
 * same literals before they are parsed at all.
 *
 * SPIKE_ONLY: superseded by P149's exact-money client (src/data/exact-json-guard.ts) once released.
 */

export class UnsafeMoneyTransportError extends Error {
  readonly code = 'unsafe_money_transport'
  constructor(field: string, reason: string) {
    super(`refusing money field "${field}": ${reason}`)
    this.name = 'UnsafeMoneyTransportError'
  }
}

// Optional minus, 1-19 digits (bigint range), no whitespace, no hex, no exponent, no empty string.
// (The shared parseMinorUnits is BigInt(value), which turns "" into 0n and accepts " 12 " and "0x10".)
const INTEGER_STRING = /^-?\d{1,19}$/

/** null -> null (NOT zero). string -> exact bigint. number -> only if it is a safe integer. */
export function parseMinorUnitsWire(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    if (!INTEGER_STRING.test(value)) {
      throw new UnsafeMoneyTransportError(field, 'not a plain integer string')
    }
    return BigInt(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new UnsafeMoneyTransportError(field, 'a JSON number outside the exact integer range')
    }
    return BigInt(value)
  }
  throw new UnsafeMoneyTransportError(field, `unexpected ${typeof value}`)
}
