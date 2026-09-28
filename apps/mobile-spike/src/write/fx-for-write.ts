import type { CurrencyCode } from '@shared/domain/currency'
import { convert } from '../features/price-check/p165-domain/fx'
import { isFxRateStale } from '../features/price-check/p165-domain/price-check/freshness'
import { readLatestFxRate } from '../features/price-check/fx-source'
import type { FxRateReader } from '../features/price-check/fx-source'
import type { Money } from '../features/price-check/p165-domain/money'
import type { FxSource } from './purchase-writes'

/**
 * P180 primary task: `create_purchase`/`create_sale` require `p_fx_rate_to_nok`/`p_fx_rate_date`/
 * `p_fx_source` for any non-NOK currency (supabase/migrations/20260915120000_p133_currency_
 * exponent_fx_conversion.sql — the RPC itself raises "a positive p_fx_rate_to_nok is required for a
 * non-NOK purchase/sale" and fails the whole write when it is missing). The P178 currency selector
 * made a non-NOK currency reachable in the UI without ever supplying this, so every non-NOK write
 * was refused server-side (P178/P179's own disclosed finding). This module reuses Price Check's
 * OWN existing FX read (`fx-source.ts`'s `readLatestFxRate`, the same live `fx_rates` table, the
 * same Norges-Bank-backed source) rather than inventing a second FX mechanism — the mission's own
 * instruction (§3) and D-132/D-007's "one canonical rate, one canonical semantic" precedent.
 *
 * `fx_rate_to_nok` is always "NOK per ONE MAJOR unit of the source currency" (FINANCIAL_MODEL.md
 * §7) — this module never inverts or rescales it; the rate read from `fx_rates` is passed straight
 * through to the RPC as a decimal string, exactly as Price Check already treats it.
 */

export type FxWriteState =
  | { readonly kind: 'not_needed' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready'
      readonly rateToNok: string
      readonly rateDate: string
      readonly source: FxSource
      /** Norges Bank contract (P165, price-check/freshness.ts): >7 days old. The rate is still
       *  used — never silently substituted or refused — but the person sees it is old. */
      readonly stale: boolean
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'read_failed' }

/** True only for the one state a write is allowed to submit with: NOK (no rate needed) or a
 *  successfully-read rate (fresh or stale — staleness warns, it does not block). */
export function fxWriteIsSubmittable(state: FxWriteState): boolean {
  return state.kind === 'not_needed' || state.kind === 'ready'
}

/**
 * Resolves the FX state for a non-NOK write. NOK always resolves synchronously to `not_needed`
 * without touching the network — never a spurious "loading" flash for the common case. Every
 * failure mode the mission's FX FAILURE STATES section names is a distinct, honest state: a rate
 * that was never ingested (`missing`), one that fails the stored-value shape check
 * (`malformed`), and a read that could not complete at all — including being offline — collapsed
 * into `read_failed`, matching `fx-source.ts`'s own existing granularity (P169's own documented
 * contract: "FX: converted, missing, malformed, read failed" — this module adds nothing Price
 * Check does not already distinguish). None of these ever becomes a fabricated rate or a silent 0.
 */
export async function loadFxForWrite(
  currency: CurrencyCode,
  read: FxRateReader,
  nowMs: number,
): Promise<FxWriteState> {
  if (currency === 'NOK') return { kind: 'not_needed' }
  try {
    const parse = await readLatestFxRate(currency, read)
    if (!parse.ok) return { kind: parse.reason }
    return {
      kind: 'ready',
      rateToNok: parse.rate.rateToNok,
      rateDate: parse.rate.rateDate,
      source: 'norges_bank',
      stale: isFxRateStale(parse.rate.rateDate, nowMs),
    }
  } catch {
    return { kind: 'read_failed' }
  }
}

/** Presentation-only NOK reference for the receipt preview — exact bigint, the SAME conversion
 *  `money_minor_to_nok_minor` performs server-side (P133), computed here only to SHOW the person
 *  what the server will record, never sent back as if it were the entered amount. The source
 *  amount stays the amount of record; this is a reference figure only (mission §4). */
export function nokReferenceForWrite(amount: Money, state: FxWriteState): Money | null {
  if (state.kind !== 'ready') return null
  return convert(amount, state.rateToNok, 'NOK')
}
