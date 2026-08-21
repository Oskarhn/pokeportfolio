/**
 * Currency metadata. The minor-unit exponent is looked up per currency, never
 * assumed to be 2 — see FINANCIAL_MODEL.md §1. Most currencies this project
 * touches (NOK, EUR, USD, GBP) happen to use 2, which is a fact about those
 * currencies, not an assumption baked into the code: adding a currency is one
 * row in this table, not a code change. JPY (M8) is the zero-exponent proof —
 * a purchase in JPY has no fractional minor unit at all, so `1 JPY` is
 * `minorUnits = 1n`, not `100n`, and toDecimalString renders it with no
 * decimal point (FINANCIAL_MODEL.md §1, "never assumed to be 2").
 */

export type CurrencyCode = 'NOK' | 'EUR' | 'USD' | 'GBP' | 'JPY'

export interface CurrencyMeta {
  readonly code: CurrencyCode
  /** Number of decimal digits between the major unit and the minor unit. */
  readonly minorUnitExponent: number
}

const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyMeta>> = {
  NOK: { code: 'NOK', minorUnitExponent: 2 },
  EUR: { code: 'EUR', minorUnitExponent: 2 },
  USD: { code: 'USD', minorUnitExponent: 2 },
  GBP: { code: 'GBP', minorUnitExponent: 2 },
  JPY: { code: 'JPY', minorUnitExponent: 0 },
}

export function getCurrencyMeta(code: CurrencyCode): CurrencyMeta {
  return CURRENCIES[code]
}

export function isSupportedCurrencyCode(value: string): value is CurrencyCode {
  return value in CURRENCIES
}
