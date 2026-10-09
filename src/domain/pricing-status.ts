/**
 * What a catalog price reference means to the person looking at it — the four states that must
 * never be collapsed into one another (docs/FINANCIAL_MODEL.md §6, CLAUDE.md "Honesty in the
 * product"):
 *
 *   loading      the lookup has not answered yet
 *   unavailable  OUR lookup failed (transport, or the price source could not be reached) — we do not
 *                know whether a price exists; this is never shown as "no price"
 *   none         the source answered and has no price for this exact variant
 *   priced       a real observation, with its age: fresh, stale, outdated or of unknown age
 *
 * Pure: the clock is passed in, so it is deterministic to test. The age thresholds are the ones the
 * portfolio valuation and Price Check already use (src/domain/price-check/freshness.ts).
 */
import { ageInDays, classifyFreshness } from './price-check/freshness'
import type { Freshness } from './price-check/types'

export type LookupStatus = 'pending' | 'ok' | 'provider_failed' | 'request_failed'

export interface PriceReference {
  readonly priceState: 'available' | 'missing'
  readonly providerUpdatedAt: string | null
  readonly valueNokMinor: bigint | null
}

export type PriceStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly cause: 'provider' | 'request' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'priced'
      readonly freshness: Freshness
      readonly ageDays: number | null
      /** False when the source price exists but no NOK reference could be derived (no FX rate). */
      readonly nokKnown: boolean
    }

export function classifySearchPrice(
  lookup: LookupStatus,
  reference: PriceReference | undefined,
  nowMs: number,
): PriceStatus {
  if (lookup === 'pending') return { kind: 'loading' }
  // A failed lookup says nothing about whether a price exists, whatever rows (if any) came back.
  if (lookup === 'request_failed') return { kind: 'unavailable', cause: 'request' }
  if (lookup === 'provider_failed') return { kind: 'unavailable', cause: 'provider' }
  if (reference === undefined || reference.priceState !== 'available') return { kind: 'none' }
  return {
    kind: 'priced',
    freshness: classifyFreshness(reference.providerUpdatedAt, nowMs),
    ageDays: ageInDays(reference.providerUpdatedAt, nowMs),
    nokKnown: reference.valueNokMinor !== null,
  }
}

/** Short badge text for a priced state, or null when the price needs no qualifier. */
export function freshnessBadge(status: Extract<PriceStatus, { kind: 'priced' }>): string | null {
  switch (status.freshness) {
    case 'fresh':
      return null
    case 'stale':
      return `Stale · ${String(status.ageDays)} days old`
    case 'outdated':
      return `Outdated · ${String(status.ageDays)} days old`
    case 'unknown':
      return 'Age unknown'
  }
}
