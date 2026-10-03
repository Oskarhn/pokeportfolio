import type { Money } from '@shared/domain/money'
import type { NokReference } from './p165-domain/price-check/fx'
import type {
  CardIdentity,
  DroppedObservation,
  Freshness,
  GradedPriceSection,
  PriceObservation,
  UnavailableReason,
  VariantIdentity,
} from './p165-domain/price-check/types'

/**
 * The P169 Price Check result model. It is the P165 web model (vendored, byte-identical, in
 * ./p165-domain) plus the ONE thing the native client needs on top: which wire CONTRACT answered.
 * Three contracts exist and they say different amounts of truth, so they are never collapsed:
 *
 *   search_prices_observations   P165 candidate `search-prices`: every provider value of the exact
 *                                variant, each with source currency, metric and provider timestamp.
 *   search_prices_headline_only  RELEASED `search-prices` (main d8682e0): ONE preferred value per
 *                                variant. Genuine and variant-exact, but a second provider's value
 *                                may exist and simply not be visible -> shown as partial.
 *   released_snapshot_rpc        DB 104/106 `get_card_variant_price_history`: stored snapshots,
 *                                converted to NOK by the server, ONE provider chosen by the caller's
 *                                own EU/US preference. Source currency, source amount and metric
 *                                are NOT reported by this interface and are shown as not reported.
 *
 * Nothing in this model can express a write. Absent is never zero: a missing price is an
 * `unavailable` result with a named reason, a missing NOK reference is `nok.status: 'unavailable'`.
 */

export type { CardIdentity, VariantIdentity, PriceObservation, Freshness, UnavailableReason }

export type PriceSourceKind = 'search_prices' | 'snapshot_rpc'

export type PriceContract =
  'search_prices_observations' | 'search_prices_headline_only' | 'released_snapshot_rpc'

export interface ObservationRow {
  readonly observation: PriceObservation
  /** Classified from the PROVIDER's own timestamp; 'unknown' when it gave none. */
  readonly freshness: Freshness
  readonly ageDays: number | null
  /** NOK reference or the honest reason there is none (never a guessed figure). */
  readonly nok: NokReference
  /** The Norges Bank rate used is older than a week (P165 FX_STALE_AFTER_DAYS). */
  readonly fxRateStale: boolean
  /** The rate could not be READ (as opposed to: no rate exists). The source amount is still shown. */
  readonly fxReadFailed: boolean
}

export interface SnapshotHeadline {
  readonly provider: string
  readonly providerLabel: string
  /** Server-converted NOK amount, exact. */
  readonly nok: Money
  /** Date of the stored snapshot (YYYY-MM-DD). */
  readonly snapshotDate: string
  readonly freshness: Freshness
  readonly ageDays: number | null
}

interface ResultBase {
  /** When this client received the answer (ISO 8601). A cached answer keeps its ORIGINAL time. */
  readonly fetchedAt: string
  readonly fromCache: boolean
}

export type RawPriceResult =
  | (ResultBase & {
      readonly status: 'observations'
      readonly contract: 'search_prices_observations' | 'search_prices_headline_only'
      readonly rows: readonly ObservationRow[]
      readonly dropped: readonly DroppedObservation[]
    })
  | (ResultBase & {
      readonly status: 'snapshot'
      readonly contract: 'released_snapshot_rpc'
      readonly headlines: readonly SnapshotHeadline[]
    })
  | (ResultBase & {
      readonly status: 'unavailable'
      readonly contract: PriceContract
      readonly reason: UnavailableReason
      readonly dropped: readonly DroppedObservation[]
    })

export interface PriceCheckResult {
  readonly cardId: string
  readonly variantId: string
  readonly source: PriceSourceKind
  readonly raw: RawPriceResult
  readonly graded: GradedPriceSection
}

/** Why a lookup produced no result at all (as opposed to an honest "no price"). */
export type LookupFailureReason =
  | 'network'
  | 'unauthorized'
  | 'rate_limited'
  | 'provider_error'
  | 'malformed_response'
  | 'not_found'
  | 'write_refused'
  | 'unknown'

export class PriceLookupError extends Error {
  readonly reason: LookupFailureReason
  constructor(reason: LookupFailureReason, detail?: string) {
    super(detail ?? reason)
    this.name = 'PriceLookupError'
    this.reason = reason
  }
}

export const RETRYABLE_FAILURES: ReadonlySet<LookupFailureReason> = new Set([
  'network',
  'rate_limited',
  'provider_error',
  'unknown',
])

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

export function abortError(): Error {
  const error = new Error('Price lookup was cancelled')
  error.name = 'AbortError'
  return error
}
