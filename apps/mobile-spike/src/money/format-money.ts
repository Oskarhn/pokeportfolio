import { getCurrencyMeta, type CurrencyCode } from '@shared/domain/currency'
import { toDecimalString, type Money } from '@shared/domain/money'

/**
 * Display formatting of an exact minor-unit amount, written for Hermes: bigint and string handling
 * only. It never touches `Number`, never calls `Intl.NumberFormat` (its BigInt and `formatToParts`
 * support on Hermes is documented as partial), and never computes anything: the exact digit string
 * comes from the shared domain's `toDecimalString`, which owns the currency's minor-unit exponent
 * (JPY = 0). This module only groups digits and places the sign and symbol.
 *
 * Absent is not zero (CLAUDE.md "Honesty in the product"): `null`/`undefined` renders as
 * {@link ABSENT}, never as a formatted zero.
 *
 * It replaces `src/ui/money-format.ts` for the native client; the web file is untouched. The
 * digits are cross-checked against that file's `Intl`-based output in
 * tests/unit/money-format-parity.test.ts.
 */

export const ABSENT = '—'

export type NumberStyle = 'nb-NO' | 'en-US'

interface Glyphs {
  group: string
  decimal: string
  minus: string
}

// Glyphs as ICU/CLDR emits them for these locales (verified against Intl in Node by the parity test).
const GLYPHS: Record<NumberStyle, Glyphs> = {
  'nb-NO': { group: ' ', decimal: ',', minus: '−' },
  'en-US': { group: ',', decimal: '.', minus: '-' },
}

const SYMBOL: Partial<Record<CurrencyCode, string>> = { EUR: '€', USD: '$', GBP: '£' }

function groupDigits(whole: string, separator: string): string {
  let out = ''
  for (let i = 0; i < whole.length; i += 1) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += separator
    out += whole[i]
  }
  return out
}

/** The number without sign, symbol or currency code: "1 234,56". */
function unsignedBody(minorUnits: bigint, currency: CurrencyCode, style: NumberStyle): string {
  const glyphs = GLYPHS[style]
  const decimal = toDecimalString({
    minorUnits: minorUnits < 0n ? -minorUnits : minorUnits,
    currency,
  })
  const dot = decimal.indexOf('.')
  const whole = dot === -1 ? decimal : decimal.slice(0, dot)
  const fraction = dot === -1 ? '' : decimal.slice(dot + 1)
  const grouped = groupDigits(whole, glyphs.group)
  return fraction === '' ? grouped : `${grouped}${glyphs.decimal}${fraction}`
}

/** Digits only, signed the way the web's Intl formatter signs them: "−1 234,56". */
export function formatMoneyBody(
  minorUnits: bigint,
  currency: CurrencyCode,
  style: NumberStyle,
): string {
  const body = unsignedBody(minorUnits, currency, style)
  return minorUnits < 0n ? `${GLYPHS[style].minus}${body}` : body
}

/**
 * Full display string. NOK: "1 234,56 kr". EUR/USD/GBP: "€1,234.56". Other codes (JPY):
 * "12,345 JPY". A negative amount puts the sign first: "−1,00 kr", "-€1.00".
 */
export function formatMoney(value: Money | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  const { minorUnits, currency } = value
  // Consulted (rather than assumed) so an unsupported currency code fails loudly here.
  getCurrencyMeta(currency)
  const negative = minorUnits < 0n
  if (currency === 'NOK') {
    const body = unsignedBody(minorUnits, currency, 'nb-NO')
    return `${negative ? GLYPHS['nb-NO'].minus : ''}${body} kr`
  }
  const body = unsignedBody(minorUnits, currency, 'en-US')
  const sign = negative ? GLYPHS['en-US'].minus : ''
  const symbol = SYMBOL[currency]
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency}`
}
