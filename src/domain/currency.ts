/**
 * Currency metadata. The minor-unit exponent is looked up per currency, never
 * assumed to be 2 — see FINANCIAL_MODEL.md §1. Every currency this project
 * currently touches (NOK, EUR, USD, GBP) happens to use 2, which is a fact
 * about those currencies, not an assumption baked into the code: adding a
 * zero-exponent currency later is one row in this table, not a code change.
 */

export type CurrencyCode = 'NOK' | 'EUR' | 'USD' | 'GBP'

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
}

export function getCurrencyMeta(code: CurrencyCode): CurrencyMeta {
  return CURRENCIES[code]
}

export function isSupportedCurrencyCode(value: string): value is CurrencyCode {
  return value in CURRENCIES
}
