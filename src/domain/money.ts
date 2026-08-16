/**
 * Money as integer minor units with an explicit currency. Never a float.
 * See FINANCIAL_MODEL.md §1 (representation rules, invariant M1).
 *
 * Money values are readonly and produced only through the factory functions
 * below — there is no way to construct one from a JavaScript float.
 */
import { getCurrencyMeta, type CurrencyCode } from './currency'
import { parseDecimalToBigInt } from './decimal'
import { CurrencyMismatchError, InvalidMoneyInputError } from './errors'

export interface Money {
  readonly minorUnits: bigint
  readonly currency: CurrencyCode
}

/** Constructs Money directly from an exact minor-unit integer. */
export function fromMinorUnits(minorUnits: bigint, currency: CurrencyCode): Money {
  return { minorUnits, currency }
}

/**
 * Parses a plain decimal string, e.g. "699.00" NOK → 69900 minor units.
 * Rejects more fractional digits than the currency supports rather than
 * rounding away real precision at a creation boundary.
 */
export function fromDecimalString(value: string, currency: CurrencyCode): Money {
  const { minorUnitExponent } = getCurrencyMeta(currency)
  const minorUnits = parseDecimalToBigInt(value, minorUnitExponent)
  return { minorUnits, currency }
}

/**
 * Constructs Money from a JavaScript number of minor units. Only accepts
 * safe integers — this is the one place a `number` is allowed to become
 * Money, and it refuses anything that isn't already an exact integer count
 * of minor units (never a major-unit float like `699.00`).
 */
export function fromSafeIntegerMinorUnits(minorUnits: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new InvalidMoneyInputError(
      `${String(minorUnits)} is not a safe integer number of minor units`,
    )
  }
  return { minorUnits: BigInt(minorUnits), currency }
}

export function zero(currency: CurrencyCode): Money {
  return { minorUnits: 0n, currency }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency)
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { minorUnits: a.minorUnits + b.minorUnits, currency: a.currency }
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { minorUnits: a.minorUnits - b.minorUnits, currency: a.currency }
}

export function sum(currency: CurrencyCode, amounts: readonly Money[]): Money {
  return amounts.reduce((total, amount) => add(total, amount), zero(currency))
}

export function negate(a: Money): Money {
  return { minorUnits: -a.minorUnits, currency: a.currency }
}

/** Multiplies by an exact integer quantity — never a fractional scalar. */
export function multiplyByQuantity(a: Money, quantity: bigint): Money {
  return { minorUnits: a.minorUnits * quantity, currency: a.currency }
}

export function isZero(a: Money): boolean {
  return a.minorUnits === 0n
}

export function isNegative(a: Money): boolean {
  return a.minorUnits < 0n
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minorUnits === b.minorUnits
}

/** -1 if a < b, 0 if equal, 1 if a > b. Requires matching currency. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b)
  if (a.minorUnits < b.minorUnits) return -1
  if (a.minorUnits > b.minorUnits) return 1
  return 0
}

/**
 * Formats to a plain decimal string, e.g. 69900 NOK → "699.00". Formatting
 * is deliberately separate from arithmetic (FINANCIAL_MODEL.md §1) — this
 * function computes nothing, it only renders an already-settled amount.
 */
export function toDecimalString(a: Money): string {
  const { minorUnitExponent } = getCurrencyMeta(a.currency)
  const negative = a.minorUnits < 0n
  const magnitude = negative ? -a.minorUnits : a.minorUnits
  const digits = magnitude.toString().padStart(minorUnitExponent + 1, '0')
  const splitAt = digits.length - minorUnitExponent
  const whole = digits.slice(0, splitAt)
  const fraction = digits.slice(splitAt)
  const sign = negative ? '-' : ''
  return minorUnitExponent > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}
