/**
 * Foreign-currency conversion. A conversion is computed once, at write time,
 * from the rate for that specific date, and is never recomputed later
 * (FINANCIAL_MODEL.md §7, invariant F11). This module only does the
 * arithmetic; freezing the result and the rate date is the caller's job.
 */
import type { CurrencyCode } from './currency'
import { getCurrencyMeta } from './currency'
import { divideRoundHalfUp, parseDecimalToBigInt } from './decimal'
import { fromMinorUnits, type Money } from './money'

/** `numeric(18,8)` in FINANCIAL_MODEL.md §7 — 8 fractional digits, exact. */
const FX_RATE_FRACTION_DIGITS = 8

/**
 * Converts `amount` to `targetCurrency` using `rateToTarget` (units of
 * target currency per one unit of `amount`'s currency), rounding half-up to
 * the target currency's minor unit exactly once.
 */
export function convert(amount: Money, rateToTarget: string, targetCurrency: CurrencyCode): Money {
  const rateScaled = parseDecimalToBigInt(rateToTarget, FX_RATE_FRACTION_DIGITS)
  const sourceExp = exponentOf(amount.currency)
  const targetExp = exponentOf(targetCurrency)
  const rateDivisor = 10n ** BigInt(FX_RATE_FRACTION_DIGITS)
  const exponentShift = targetExp - sourceExp

  const scaledNumerator =
    exponentShift >= 0
      ? amount.minorUnits * rateScaled * 10n ** BigInt(exponentShift)
      : amount.minorUnits * rateScaled

  const denominator = exponentShift >= 0 ? rateDivisor : rateDivisor * 10n ** BigInt(-exponentShift)

  const targetMinorUnits = divideRoundHalfUp(scaledNumerator, denominator)
  return fromMinorUnits(targetMinorUnits, targetCurrency)
}

function exponentOf(currency: CurrencyCode): number {
  return getCurrencyMeta(currency).minorUnitExponent
}

/**
 * Exact reciprocal of a stored rate — M9.1's presentation-only display-currency conversion
 * (FINANCIAL_MODEL.md §7's `fx_rate_to_nok` is always "NOK per one unit of the foreign currency";
 * showing a NOK amount in EUR/USD needs the inverse, "target units per one NOK"). This is never
 * used to freeze a stored amount (F11 stays untouched — only real transaction-time conversions are
 * ever persisted); it exists purely so `MoneyDisplay` can convert for reading without floating
 * point (§10/§42's explicit requirement).
 */
export function invertRate(rateToNok: string, fractionDigits = FX_RATE_FRACTION_DIGITS): string {
  const scaled = parseDecimalToBigInt(rateToNok, fractionDigits)
  if (scaled <= 0n) {
    throw new RangeError(`invertRate requires a positive rate, got ${rateToNok}`)
  }
  const numerator = 10n ** BigInt(fractionDigits * 2)
  const invertedScaled = divideRoundHalfUp(numerator, scaled)
  return formatScaledBigInt(invertedScaled, fractionDigits)
}

function formatScaledBigInt(scaled: bigint, fractionDigits: number): string {
  const divisor = 10n ** BigInt(fractionDigits)
  const whole = scaled / divisor
  const fraction = (scaled % divisor).toString().padStart(fractionDigits, '0')
  return `${whole.toString()}.${fraction}`
}

/** Converts a NOK amount to a display currency using the latest cached EUR/NOK or USD/NOK rate.
 *  Presentation only — never writes anything, never used for a stored/frozen amount. */
export function convertNokToDisplayCurrency(
  nokMinorUnits: bigint,
  displayCurrency: Exclude<CurrencyCode, 'NOK'>,
  rateToNok: string,
): Money {
  return convert(fromMinorUnits(nokMinorUnits, 'NOK'), invertRate(rateToNok), displayCurrency)
}
