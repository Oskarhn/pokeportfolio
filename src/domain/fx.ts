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
