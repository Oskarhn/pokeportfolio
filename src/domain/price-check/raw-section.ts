/**
 * Builds the raw-price section for one exact variant from a `search-prices` response for the
 * variant's card. Every outcome is a distinct, named state — provider failure, "the provider has no
 * price for this variant", "the variant was not in the response", and "prices available" are never
 * collapsed into one another, and none of them is ever a zero.
 */
import {
  parseHeadlineObservation,
  parseRawObservations,
  type RawObservationContext,
} from './raw-observations'
import type { DroppedObservation, PriceObservation, RawPriceSection } from './types'
import { asRecord } from './wire'

/** What the fetch layer hands to the domain for one card. `rows` is the untrusted wire array. */
export interface CardPriceResponse {
  /** ISO 8601 instant at which the response reached this client. */
  readonly fetchedAt: string
  readonly rows: readonly unknown[]
  /** Number of upstream card lookups that failed. One card is requested per call, so a value > 0
   *  means THIS card's provider lookup failed — its rows are then "unknown", not "no price". */
  readonly providerErrorCount: number
}

/** Result of a section build, plus whether it came from the limited pre-`observations` shape. */
export interface RawSectionResult {
  readonly section: RawPriceSection
  /** True when the deployed function only reported a single headline value per variant, so a
   *  second provider's price may exist and simply not be visible. Shown as partial coverage. */
  readonly headlineOnly: boolean
}

export function buildRawSection(
  response: CardPriceResponse,
  variant: { readonly variantId: string; readonly finish: RawObservationContext['finish'] },
): RawSectionResult {
  if (response.providerErrorCount > 0) {
    return {
      headlineOnly: false,
      section: {
        status: 'unavailable',
        observations: [],
        unavailable: 'provider_error',
        dropped: [],
      },
    }
  }

  const row = response.rows
    .map(asRecord)
    .find((candidate) => candidate !== null && candidate.cardVariantId === variant.variantId)
  if (row === undefined || row === null) {
    return {
      headlineOnly: false,
      section: {
        status: 'unavailable',
        observations: [],
        unavailable: 'variant_not_in_response',
        dropped: [],
      },
    }
  }

  const ctx: RawObservationContext = { fetchedAt: response.fetchedAt, finish: variant.finish }
  const hasObservations = Array.isArray(row.observations)
  const parsed = hasObservations
    ? parseRawObservations(row.observations, ctx)
    : parseHeadlineObservation(
        {
          provider: row.provider,
          priceKind: row.priceKind,
          sourceCurrency: row.sourceCurrency,
          sourceValueMinor: row.sourceValueMinor,
          providerUpdatedAt: row.providerUpdatedAt,
        },
        ctx,
      )

  const observations: readonly PriceObservation[] = parsed.observations
  const dropped: readonly DroppedObservation[] = parsed.dropped
  if (observations.length === 0) {
    return {
      headlineOnly: !hasObservations,
      section: {
        status: 'unavailable',
        observations: [],
        // Everything the provider sent was refused as malformed → the response is bad, which is
        // different from the provider honestly having no price for this variant.
        unavailable: dropped.length > 0 ? 'malformed_response' : 'no_variant_price',
        dropped,
      },
    }
  }
  return {
    headlineOnly: !hasObservations,
    section: { status: 'available', observations, unavailable: null, dropped },
  }
}
