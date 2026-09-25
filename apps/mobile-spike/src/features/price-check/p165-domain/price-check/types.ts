/**
 * Price Check domain model (P153). Read-only: nothing in `src/domain/price-check/` describes,
 * creates or mutates a holding, purchase, sale or ledger row — it only describes what a market
 * data source reported about one exact catalog card variant.
 *
 * Honesty rules baked into these types (docs/FINANCIAL_MODEL.md §6, CLAUDE.md "Honesty in the
 * product"):
 *   - A price is `Money` in the SOURCE currency (integer minor units, explicit ISO 4217 code).
 *     Absence is the absence of an observation — never a zero `Money`.
 *   - Every observation names its provider, the metric the provider called it, what kind of price
 *     that metric is, and when the PROVIDER observed it (`observedAt`) separately from when this
 *     client obtained it (`fetchedAt`). The two are never conflated.
 *   - Raw and graded prices are different subjects; a graded price is keyed by company + grade
 *     (+ qualifier) and is never derived from a raw price.
 */
import type { Money } from '../money'

export type CatalogLanguage = 'en' | 'ja'

/** Catalog identity of one printed card: the thing a set + collector number pin down. A name alone
 *  is not identity — many cards share a name across sets and reprints. */
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

export type VariantFinish = 'normal' | 'holo' | 'reverse' | 'other'

/** One ownable/priceable variant of a printed card. The same artwork can exist as several variants
 *  (normal / reverse holo / stamped print runs) with genuinely different prices. */
export interface VariantIdentity {
  readonly variantId: string
  readonly finish: VariantFinish
  readonly stamp: string
  readonly subtype: string
  readonly size: 'standard' | 'oversized'
  readonly isActive: boolean
}

/** What kind of price a metric is. `sold` and `listing` are reserved for sources that actually
 *  document that basis; every raw metric available today (TCGdex relaying Cardmarket/TCGplayer
 *  statistics) is an `index`: a provider-computed figure whose sale/listing basis TCGdex does not
 *  document (docs/API_SOURCES.md). Nothing is ever labelled `sold` on a guess. */
export type PriceKind = 'listing' | 'sold' | 'index'

export type Freshness = 'fresh' | 'stale' | 'outdated' | 'unknown'

export type GradingCompany = 'PSA' | 'BGS' | 'CGC' | 'SGC' | 'ACE' | 'TAG'

export type ObservationSubject =
  | { readonly type: 'raw' }
  | {
      readonly type: 'graded'
      readonly company: GradingCompany
      /** The grade exactly as the source states it ("10", "9.5"). A string, never a float. */
      readonly grade: string
      /** "Pristine", "Black Label", … — part of the identity: BGS 10 ≠ BGS 10 Pristine. */
      readonly qualifier: string | null
    }

export interface PriceObservation {
  readonly subject: ObservationSubject
  /** Wire id of the provider that supplied the number ('tcgdex_cardmarket', …). */
  readonly provider: string
  /** Human label naming the provider AND the relay ("Cardmarket via TCGdex"). */
  readonly providerLabel: string
  /** Provider's own metric id ('cm_trend', 'tp_market', …). */
  readonly metric: string
  readonly metricLabel: string
  /** Plain-language statement of what the metric is, incl. any undocumented basis. */
  readonly basisNote: string
  readonly kind: PriceKind
  /** Exact source-currency amount. Zero only when the provider explicitly reported zero. */
  readonly price: Money
  /** Averaging window in days when the metric is a windowed statistic. */
  readonly windowDays: number | null
  /** Provider-supplied observation timestamp (ISO 8601), or null when the provider gave none. */
  readonly observedAt: string | null
  /** When this client received the number from our backend (ISO 8601). Not the observation time. */
  readonly fetchedAt: string
  /** Condition the price applies to, exactly as the source states it; null = the source does not
   *  specify (TCGdex/Cardmarket/TCGplayer relays carry no per-condition breakdown). */
  readonly condition: string | null
  /** True only for test fixtures. The UI must render synthetic data as synthetic. */
  readonly synthetic: boolean
}

export type UnavailableReason =
  | 'no_variant_price'
  | 'variant_not_in_response'
  | 'provider_error'
  | 'rate_limited'
  | 'network'
  | 'malformed_response'
  | 'not_found'
  | 'unauthorized'
  | 'graded_source_not_configured'
  | 'graded_no_data'

export type DroppedReason =
  | 'unknown_provider'
  | 'unknown_metric'
  | 'currency_mismatch'
  | 'unsupported_currency'
  | 'malformed_price'
  | 'malformed_grade'
  | 'unknown_company'
  | 'missing_kind'

export interface DroppedObservation {
  readonly reason: DroppedReason
  readonly provider: string | null
}

export type SectionStatus = 'available' | 'unavailable'

export interface RawPriceSection {
  readonly status: SectionStatus
  readonly observations: readonly PriceObservation[]
  /** Set exactly when `status === 'unavailable'`. */
  readonly unavailable: UnavailableReason | null
  /** Provider values this client refused to display (malformed/unsupported) — surfaced, not hidden. */
  readonly dropped: readonly DroppedObservation[]
}

export interface GradedSourceStatus {
  readonly id: string
  readonly label: string
  readonly state: 'ok' | 'error'
}

export interface GradedPriceSection {
  readonly status: SectionStatus
  readonly observations: readonly PriceObservation[]
  readonly unavailable: UnavailableReason | null
  readonly dropped: readonly DroppedObservation[]
  /** Graded sources that were consulted. Empty when no authorized source is configured. */
  readonly sources: readonly GradedSourceStatus[]
}

export interface RateForNok {
  /** NOK per ONE MAJOR unit of the foreign currency (FINANCIAL_MODEL.md §7, P136). */
  readonly rateToNok: string
  /** Date the rate applies to (YYYY-MM-DD), as published by Norges Bank. */
  readonly rateDate: string
}
