import type { Money } from '@shared/domain/money'

/**
 * The Price Check ADAPTER CONTRACT of the spike.
 *
 * The identity types deliberately use the names and fields of P153's `src/domain/price-check/types.ts`
 * (branch feat/p153-card-price-check, unreleased at 9e6bb46): `CardIdentity`, `VariantIdentity`, and
 * the variant-resolution statuses `confirmed | choice_required | mismatch | no_variants`. That is so
 * there is ONE price identity model, not two: once P153 releases, this file's identity types are
 * replaced by a type-only re-export of P153's and the adapters below are replaced by its data layer.
 * Nothing here reimplements P153's observation pipeline (freshness, FX presentation, dropped
 * observations); those are listed as future integration work in docs/mobile/PRICE_CHECK_CONTRACT.md.
 *
 * Read-only by construction: no method of {@link PriceCheckPort} can create a holding, purchase, sale
 * or manual-card definition, and the client refuses to send such a request at all
 * (net/spike-fetch.ts).
 */

export type CatalogLanguage = 'en' | 'ja'
export type VariantFinish = 'normal' | 'holo' | 'reverse' | 'other'

export interface CardIdentity {
  readonly cardId: string
  readonly name: string
  readonly setId: string
  readonly setName: string
  readonly collectorNumber: string
  readonly language: CatalogLanguage
  readonly imageBaseUrl: string | null
  readonly rarity: string | null
  readonly illustrator: string | null
}

export interface VariantIdentity {
  readonly variantId: string
  readonly finish: VariantFinish
  readonly stamp: string
  readonly subtype: string
  readonly size: 'standard' | 'oversized'
  readonly isActive: boolean
}

export interface CardSearchHit {
  readonly cardId: string
  readonly name: string
  readonly setName: string
  readonly collectorNumber: string
  readonly language: CatalogLanguage
  readonly rarity: string | null
  readonly variantCount: number
}

export type PriceKind = 'listing' | 'sold' | 'index' | 'unknown'

export interface PriceObservationView {
  readonly provider: string
  readonly providerLabel: string
  /** Provider's own metric id, or null when the endpoint did not supply one. */
  readonly metric: string | null
  readonly metricLabel: string
  /** Plain statement of what the number is, including anything undocumented. */
  readonly basisNote: string
  readonly kind: PriceKind
  /** Exact amount in the SOURCE currency, when the source states it. */
  readonly source: Money | null
  /** Exact NOK reference amount, when one exists. */
  readonly nok: Money | null
  /** Provider/snapshot observation date-time (ISO 8601), or null when none was given. */
  readonly observedAt: string | null
  /** Condition the price applies to, exactly as the source states it; null = not specified. */
  readonly condition: string | null
  /** True only for the P153-shaped fixture. The UI renders it as synthetic. */
  readonly synthetic: boolean
}

export type UnavailableReason =
  | 'no_variant_price'
  | 'provider_error'
  | 'rate_limited'
  | 'not_found'
  | 'graded_source_not_configured'

export interface GradedView {
  readonly status: 'unavailable'
  readonly reason: 'graded_source_not_configured'
}

/** The graded state is ALWAYS unavailable: no authorized graded price source exists (P153 §9,
 *  docs/API_SOURCES.md). Nothing derives a graded price from a raw one. */
export const GRADED_UNAVAILABLE: GradedView = {
  status: 'unavailable',
  reason: 'graded_source_not_configured',
}

export type PriceLookup =
  | {
      readonly status: 'available'
      readonly source: PriceSourceKind
      readonly observations: readonly PriceObservationView[]
      readonly graded: GradedView
    }
  | {
      readonly status: 'unavailable'
      readonly source: PriceSourceKind
      readonly reason: UnavailableReason
      readonly graded: GradedView
    }

export type PriceSourceKind = 'released_snapshots' | 'p153_fixture'

export interface CardWithVariants {
  readonly card: CardIdentity
  readonly variants: readonly VariantIdentity[]
}

export interface PriceCheckPort {
  readonly sourceKind: PriceSourceKind
  searchCards(query: string): Promise<readonly CardSearchHit[]>
  loadCard(cardId: string): Promise<CardWithVariants | null>
  /** The card and variant a holding's variant id belongs to (Card detail -> Price Check). */
  resolveVariant(variantId: string): Promise<{ cardId: string; variantId: string } | null>
  lookup(cardId: string, variantId: string): Promise<PriceLookup>
}

/** Same statuses as P153's `resolveVariant` (src/domain/price-check/identity.ts). */
export type VariantResolution =
  | {
      readonly status: 'confirmed'
      readonly variant: VariantIdentity
      readonly basis: 'chosen' | 'only_variant'
    }
  | { readonly status: 'choice_required'; readonly variants: readonly VariantIdentity[] }
  | {
      readonly status: 'mismatch'
      readonly requestedVariantId: string
      readonly variants: readonly VariantIdentity[]
    }
  | { readonly status: 'no_variants' }
