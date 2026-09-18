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

/**
 * The one place a typed money field becomes minor units (P130-25, D-135).
 *
 * A blank field and a typed zero are different financial facts (FINANCIAL_MODEL.md §1.1): `""`
 * means "no amount was entered" — unknown, absent — while `"0"` is a real, known zero. So this
 * parser answers `null` for an empty or whitespace-only string and never fabricates `0n`; a caller
 * then decides deliberately what an absent amount means for ITS field:
 *
 *   - a value that may legitimately be unknown keeps the `null` (send it as NULL / omit it);
 *   - a value the server requires to be known asks the person for it (`requireKnownAmount`);
 *   - an additive charge whose blank means "no charge of this kind" says so by name
 *     (`parseOptionalChargeInput`).
 *
 * Both `,` and `.` are accepted as the decimal separator. Digits are parsed exactly by
 * `fromDecimalString` for the given currency's own exponent (JPY has none), which rejects surplus
 * fractional digits instead of rounding them away. No `Number()`, no `||` defaulting, no floats.
 */
export function parseNullableMoneyInput(raw: string, currency: CurrencyCode): bigint | null {
  const normalized = raw.trim().replace(',', '.')
  if (normalized === '') return null
  return fromDecimalString(normalized, currency).minorUnits
}

/** A money field the server needs to be a KNOWN amount (e.g. a purchase line's unit price, a sale
 *  line's price). Blank is refused with `missingMessage`; an explicit `0` is accepted as known 0. */
export function requireKnownAmount(
  raw: string,
  currency: CurrencyCode,
  missingMessage: string,
): bigint {
  const parsed = parseNullableMoneyInput(raw, currency)
  if (parsed === null) throw new InvalidMoneyInputError(missingMessage)
  return parsed
}

/**
 * An optional additive charge — shipping, customs, a discount, marketplace fees. Blank means
 * "no charge of this kind", which is the same fact as an explicit 0: the server columns are
 * `NOT NULL DEFAULT 0` because the ABSENCE of a charge is not unknown, it is zero. This is the
 * only money parser that turns blank into `0n`, and it does so by name so every such decision is
 * visible and greppable — never as an incidental `|| '0'` on a price.
 */
export function parseOptionalChargeInput(raw: string, currency: CurrencyCode): bigint {
  return parseNullableMoneyInput(raw, currency) ?? 0n
}

/** "100,50" and "100.50" both parse; a bare "100" is whole kroner. Never invents a value from an
 *  empty or whitespace-only string — a blank field throws rather than becoming 0. */
export function parseNokInput(raw: string): bigint {
  return requireKnownAmount(raw, 'NOK', 'Enter an amount')
}

/**
 * Formats an exact minor-unit amount for display without ever routing the amount through a
 * JS `Number` — `toDecimalString` already produced an exact digit string, and `Number()` on that
 * string silently loses precision once the magnitude passes `Number.MAX_SAFE_INTEGER` (P114:
 * 9007199254740993 minor units, the same magnitude the backup export tests prove must survive
 * exactly, previously rendered one øre high). The integer part is formatted by handing
 * `Intl.NumberFormat` a BigInt directly — its grouping/sign glyphs are exact for BigInt inputs —
 * and the fraction is appended as the untouched digit string `toDecimalString` produced.
 */
function formatExactDecimal(minorUnits: bigint, currency: CurrencyCode, locale: string): string {
  const decimal = toDecimalString({ minorUnits, currency })
  const negative = decimal.startsWith('-')
  const unsigned = negative ? decimal.slice(1) : decimal
  const dotIndex = unsigned.indexOf('.')
  const wholeDigits = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex)
  const fractionDigits = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1)
  // `wholeDigits` alone (e.g. "0" for -0.50 NOK) cannot carry the sign — BigInt has no negative
  // zero, so `-BigInt("0") === 0n` would silently drop it. The sign is tracked separately and
  // applied via the locale's own minus glyph, never assumed to be a plain hyphen.
  const groupedWhole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    BigInt(wholeDigits),
  )
  let body = groupedWhole
  if (fractionDigits !== '') {
    const decimalSeparator =
      new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        .formatToParts(0)
        .find((part) => part.type === 'decimal')?.value ?? '.'
    body = `${groupedWhole}${decimalSeparator}${fractionDigits}`
  }
  if (!negative) return body
  const minusSign =
    new Intl.NumberFormat(locale).formatToParts(-1).find((part) => part.type === 'minusSign')
      ?.value ?? '-'
  return `${minusSign}${body}`
}

/** Norwegian formatting: non-breaking thin space as the group separator, comma as the decimal
 *  separator — Intl.NumberFormat('nb-NO') gives both for free, exactly for any magnitude. */
export function formatNokMinor(minorUnits: bigint): string {
  return formatExactDecimal(minorUnits, 'NOK', 'nb-NO')
}

const CURRENCY_SYMBOL: Partial<Record<CurrencyCode, string>> = { EUR: '€', USD: '$', GBP: '£' }

/** M9.1's display-currency formatting for EUR/USD (MoneyDisplay's converted figure, Card Detail's
 *  source-currency provenance) — no locale grouping games, just symbol + two decimals, since these
 *  are presentation-only reference figures rather than the app's canonical NOK amounts. */
export function formatCurrencyMinor(minorUnits: bigint, currency: CurrencyCode): string {
  const formatted = formatExactDecimal(minorUnits, currency, 'en-US')
  const symbol = CURRENCY_SYMBOL[currency]
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`
}
