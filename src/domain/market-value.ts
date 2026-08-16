/**
 * Market value resolution, FINANCIAL_MODEL.md §6. A missing price is a
 * distinct state, never a zero Money — invariant F14. A provider price that
 * is genuinely 0.00 is a real observation and is represented as `fresh` (or
 * `stale`) with `value` set to zero; that is categorically different from
 * `missing`, and the type system keeps them from ever colliding.
 */
import type { Money } from './money'

export type MarketValue =
  | { readonly state: 'manual'; readonly value: Money }
  | { readonly state: 'fresh'; readonly value: Money; readonly ageDays: number }
  | { readonly state: 'stale'; readonly value: Money; readonly ageDays: number }
  | { readonly state: 'missing' }

export function hasResolvableValue(
  marketValue: MarketValue,
): marketValue is Exclude<MarketValue, { readonly state: 'missing' }> {
  return marketValue.state !== 'missing'
}

export interface ProviderSnapshot {
  readonly value: Money
  /** Age of the snapshot in whole days as of the resolution date. */
  readonly ageDays: number
}

const FRESH_MAX_AGE_DAYS = 3
const STALE_MAX_AGE_DAYS = 30

/**
 * Resolves the single value used for a lot, in the priority order fixed by
 * §6: an active manual valuation always wins; otherwise the most recent
 * provider snapshot, aged into `fresh` / `stale` / `missing`. A provider
 * outage never manufactures a zero — it just ages the last snapshot
 * (invariant F9), which this function expresses by simply never being
 * called with a fabricated snapshot in the first place.
 */
export function resolveMarketValue(input: {
  readonly manualValue: Money | null
  readonly providerSnapshot: ProviderSnapshot | null
}): MarketValue {
  if (input.manualValue !== null) {
    return { state: 'manual', value: input.manualValue }
  }
  if (input.providerSnapshot === null) {
    return { state: 'missing' }
  }
  const { value, ageDays } = input.providerSnapshot
  if (ageDays <= FRESH_MAX_AGE_DAYS) {
    return { state: 'fresh', value, ageDays }
  }
  if (ageDays <= STALE_MAX_AGE_DAYS) {
    return { state: 'stale', value, ageDays }
  }
  return { state: 'missing' }
}
