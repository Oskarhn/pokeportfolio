/**
 * P135 — independent, test-only FX conversion oracle for the P130-02 remediation (P133/P134's
 * eventual product fix, integrated in P136).
 *
 * This file is deliberately NOT production code and imports NOTHING from src/ or supabase/ —
 * per the P135 prompt (§4): "Do not call production conversion code from the reference
 * implementation." It exists so P136's integration tests can assert real RPC/edge-function output
 * against an INDEPENDENTLY-derived oracle, rather than against the same code path that might share
 * the bug being fixed.
 *
 * CANONICAL_FX_CONTRACT (derived independently in output_135.txt §3, cross-checked — not copied —
 * against src/domain/fx.ts's convert(), D-007, FINANCIAL_MODEL.md §1/§7, and the Norges Bank SDMX
 * UNIT_MULT attribute):
 *
 *   fx_rate_to_nok is NOK per ONE MAJOR unit of the source currency (never per-minor-unit, never
 *   per-100-units, regardless of what a data provider's raw wire format expresses a rate in).
 *
 *   target_minor_units = round_half_up(
 *     source_minor_units * fx_rate_to_nok * 10^(target_exponent - source_exponent)
 *   )
 *
 * All arithmetic is exact bigint/decimal — never IEEE 754 float — matching FINANCIAL_MODEL.md
 * §1's "never float, never numeric for money" and §1's rounding rule ("half-up to the minor unit
 * at every persistence boundary").
 */

export type OracleCurrency = 'NOK' | 'EUR' | 'USD' | 'GBP' | 'JPY'

export const ORACLE_CURRENCY_EXPONENTS: Readonly<Record<OracleCurrency, number>> = {
  NOK: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
}

/** Decimal fraction digits `fx_rate_to_nok` is stored with, per DATA_MODEL/FINANCIAL_MODEL (`numeric(18,8)`). */
export const RATE_FRACTION_DIGITS = 8

/**
 * Parses a decimal string (e.g. "0.060375") into an exact bigint scaled by 10^fractionDigits.
 * Rejects anything that is not a plain, optionally-signed decimal literal — no exponents, no
 * locale separators — since a `numeric(18,8)` column and this project's own decimal parser
 * (src/domain/decimal.ts, independently reasoned about, not read) would not accept those either.
 */
export function parseDecimalToScaledBigInt(input: string, fractionDigits: number): bigint {
  const trimmed = input.trim()
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) {
    throw new RangeError(`not a plain decimal literal: ${JSON.stringify(input)}`)
  }
  const [, sign, whole, fraction = ''] = match
  if (fraction.length > fractionDigits) {
    throw new RangeError(
      `too many fractional digits for scale ${fractionDigits}: ${JSON.stringify(input)}`,
    )
  }
  const paddedFraction = fraction.padEnd(fractionDigits, '0')
  const magnitude = BigInt((whole ?? '') + paddedFraction)
  return sign === '-' ? -magnitude : magnitude
}

/** Round-half-up division of a bigint numerator/denominator pair (denominator must be positive). */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive')
  const negative = numerator < 0n
  const absNumerator = negative ? -numerator : numerator
  const quotient = (absNumerator * 2n + denominator) / (denominator * 2n)
  return negative ? -quotient : quotient
}

export interface OracleConversionInput {
  readonly sourceCurrency: OracleCurrency
  readonly sourceMinorUnits: bigint
  /** "NOK per one MAJOR unit of sourceCurrency", as a plain decimal string, e.g. "0.060375". */
  readonly fxRateToNokPerMajorUnit: string
}

/**
 * The single canonical conversion function every adversarial/metamorphic test in this package is
 * built on. Exact integer arithmetic throughout; rounds exactly once, half-up, at the very end —
 * matching FINANCIAL_MODEL.md §1's "Rounding: half-up to the minor unit at every persistence
 * boundary" and F11's "computed once at write time."
 */
export function convertToNokMinorUnits(input: OracleConversionInput): bigint {
  const sourceExp = ORACLE_CURRENCY_EXPONENTS[input.sourceCurrency]
  const targetExp = ORACLE_CURRENCY_EXPONENTS.NOK
  const rateScaled = parseDecimalToScaledBigInt(input.fxRateToNokPerMajorUnit, RATE_FRACTION_DIGITS)
  const rateDivisor = 10n ** BigInt(RATE_FRACTION_DIGITS)
  const exponentShift = targetExp - sourceExp

  const numerator =
    exponentShift >= 0
      ? input.sourceMinorUnits * rateScaled * 10n ** BigInt(exponentShift)
      : input.sourceMinorUnits * rateScaled
  const denominator = exponentShift >= 0 ? rateDivisor : rateDivisor * 10n ** BigInt(-exponentShift)

  return divideRoundHalfUp(numerator, denominator)
}

/**
 * Norges Bank publishes SDMX-JSON observations expressed per `10^UNIT_MULT` units of the base
 * currency (confirmed live by P130 for JPY: UNIT_MULT=2, "Hundreds"; EUR/USD/GBP: UNIT_MULT=0,
 * "Units"). This function normalizes a raw published number to the canonical
 * "per one major unit" contract above — this is the operation the released parser
 * (supabase/functions/_shared/norges-bank.ts) never performs.
 */
export function normalizeNorgesBankRate(rawPublishedRate: string, unitMult: number): string {
  if (unitMult === 0) return rawPublishedRate
  const scaled = parseDecimalToScaledBigInt(rawPublishedRate, RATE_FRACTION_DIGITS)
  const normalized = divideRoundHalfUp(scaled, 10n ** BigInt(unitMult))
  const whole = normalized / 10n ** BigInt(RATE_FRACTION_DIGITS)
  const frac = (normalized % 10n ** BigInt(RATE_FRACTION_DIGITS))
    .toString()
    .padStart(RATE_FRACTION_DIGITS, '0')
  return `${whole.toString()}.${frac}`
}

/** Known Norges Bank UNIT_MULT values for this project's supported currencies (live-verified by P130 2026-09-13). */
export const NORGES_BANK_UNIT_MULT: Readonly<Record<Exclude<OracleCurrency, 'NOK'>, number>> = {
  EUR: 0,
  USD: 0,
  GBP: 0,
  JPY: 2,
}
