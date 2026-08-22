import { fromDecimalString, toDecimalString } from '../domain/money'
import { InvalidMoneyInputError } from '../domain/errors'
import type { CurrencyCode } from '../domain/currency'

/**
 * The UI-layer half of the money input boundary (FINANCIAL_MODEL.md §1, DESIGN_SYSTEM.md §2).
 * `src/domain/money.ts`'s `fromDecimalString` is the exact, tested parser and stays dot-only by
 * design — this module only normalizes what a person actually types before handing it to that
 * parser, and formats an already-settled amount back for nb-NO display. No arithmetic happens
 * here; see the domain layer for that.
 */

/** "100,50" and "100.50" both parse; a bare "100" is whole kroner. Never invents a value from an
 *  empty or whitespace-only string — the caller decides what "no amount entered" means. */
export function parseNokInput(raw: string): bigint {
  const normalized = raw.trim().replace(',', '.')
  if (normalized === '') {
    throw new InvalidMoneyInputError('Enter an amount')
  }
  return fromDecimalString(normalized, 'NOK').minorUnits
}

/** Norwegian formatting: non-breaking thin space as the group separator, comma as the decimal
 *  separator — Intl.NumberFormat('nb-NO') gives both for free. */
export function formatNokMinor(minorUnits: bigint): string {
  const decimal = toDecimalString({ minorUnits, currency: 'NOK' })
  return new Intl.NumberFormat('nb-NO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(decimal))
}

const CURRENCY_SYMBOL: Partial<Record<CurrencyCode, string>> = { EUR: '€', USD: '$', GBP: '£' }

/** M9.1's display-currency formatting for EUR/USD (MoneyDisplay's converted figure, Card Detail's
 *  source-currency provenance) — no locale grouping games, just symbol + two decimals, since these
 *  are presentation-only reference figures rather than the app's canonical NOK amounts. */
export function formatCurrencyMinor(minorUnits: bigint, currency: CurrencyCode): string {
  const decimal = toDecimalString({ minorUnits, currency })
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: currency === 'JPY' ? 0 : 2,
    maximumFractionDigits: currency === 'JPY' ? 0 : 2,
  }).format(Number(decimal))
  const symbol = CURRENCY_SYMBOL[currency]
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`
}
