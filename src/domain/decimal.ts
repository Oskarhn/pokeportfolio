/**
 * Exact bigint decimal helpers. No floating point anywhere in this module —
 * that is the entire point of it. See FINANCIAL_MODEL.md §1.
 */
import { InvalidMoneyInputError } from './errors'

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * Parses a plain decimal string (e.g. "699.00", "-45.5", "11.54000000") into
 * a bigint scaled to exactly `fractionDigits` decimal places. Fewer supplied
 * digits are zero-padded; more supplied digits are rejected rather than
 * silently truncated, since truncation would discard real precision.
 */
export function parseDecimalToBigInt(value: string, fractionDigits: number): bigint {
  const trimmed = value.trim()
  const match = DECIMAL_PATTERN.exec(trimmed)
  if (!match) {
    throw new InvalidMoneyInputError(`Not a valid decimal amount: ${JSON.stringify(value)}`)
  }
  const [, sign = '', whole = '', fraction = ''] = match
  if (fraction.length > fractionDigits) {
    throw new InvalidMoneyInputError(
      `${JSON.stringify(value)} has more precision than ${String(fractionDigits)} decimal places allow`,
    )
  }
  const paddedFraction = fraction.padEnd(fractionDigits, '0')
  const magnitude = BigInt(whole + paddedFraction)
  return sign === '-' ? -magnitude : magnitude
}

/** Round-half-away-from-zero division, exact in bigint. */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new InvalidMoneyInputError('divideRoundHalfUp requires a positive denominator')
  }
  const sign = numerator < 0n ? -1n : 1n
  const absNumerator = numerator < 0n ? -numerator : numerator
  const quotient = absNumerator / denominator
  const remainder = absNumerator % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  return sign * rounded
}
