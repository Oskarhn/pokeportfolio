/**
 * Read-only NOK reference conversion for Price Check. Canonical semantics (P136, FINANCIAL_MODEL.md
 * §7): `rateToNok` is NOK per ONE MAJOR unit of the source currency, and the conversion respects
 * both currencies' minor-unit exponents (NOK/EUR/USD/GBP = 2, JPY = 0) — all delegated to the one
 * exact bigint `convert` in `../fx`. No floating point, and nothing here is ever stored.
 *
 * When there is no usable rate the conversion is `unavailable`: the caller shows the original
 * source currency and never a guessed NOK figure.
 */
import { convert } from '../fx'
import type { Money } from '../money'
import type { RateForNok } from './types'

/** Norges Bank rates are stored as numeric(18,8) — at most 8 fractional digits. */
const RATE_PATTERN = /^\d{1,10}(?:\.\d{1,8})?$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type FxRateParse =
  | { readonly ok: true; readonly rate: RateForNok }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' }

/**
 * Validates a rate read from `fx_rates`. PostgREST serializes `numeric` as a JSON number, so the
 * value may arrive as a `number`; it is accepted only if its canonical string form is a plain
 * positive decimal (no exponent notation, ≤ 8 fractional digits), which is exact for every rate
 * magnitude this table holds. Anything else is `malformed` — distinct from `missing`.
 */
export function parseFxRate(rawRate: unknown, rawDate: unknown): FxRateParse {
  if (rawRate === null || rawRate === undefined || rawDate === null || rawDate === undefined) {
    return { ok: false, reason: 'missing' }
  }
  const rateText =
    typeof rawRate === 'number' && Number.isFinite(rawRate)
      ? String(rawRate)
      : typeof rawRate === 'string'
        ? rawRate.trim()
        : null
  if (rateText === null || !RATE_PATTERN.test(rateText)) return { ok: false, reason: 'malformed' }
  if (/^0+(?:\.0+)?$/.test(rateText)) return { ok: false, reason: 'malformed' }
  if (typeof rawDate !== 'string' || !DATE_PATTERN.test(rawDate)) {
    return { ok: false, reason: 'malformed' }
  }
  return { ok: true, rate: { rateToNok: rateText, rateDate: rawDate } }
}

export type NokReference =
  | { readonly status: 'converted'; readonly nok: Money; readonly rate: RateForNok }
  | { readonly status: 'source_is_nok'; readonly nok: Money }
  | { readonly status: 'unavailable'; readonly reason: 'fx_missing' | 'fx_malformed' }

/** The NOK reference for one observation price, or the honest reason there is none. */
export function nokReference(price: Money, rate: FxRateParse | null): NokReference {
  if (price.currency === 'NOK') return { status: 'source_is_nok', nok: price }
  if (rate === null || !rate.ok) {
    return {
      status: 'unavailable',
      reason: rate !== null && rate.reason === 'malformed' ? 'fx_malformed' : 'fx_missing',
    }
  }
  return {
    status: 'converted',
    nok: convert(price, rate.rate.rateToNok, 'NOK'),
    rate: rate.rate,
  }
}
