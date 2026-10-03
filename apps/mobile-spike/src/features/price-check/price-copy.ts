import { formatMoney } from '../../money/format-money'
import type { NokReference } from './p165-domain/price-check/fx'
import type {
  DroppedObservation,
  Freshness,
  PriceKind,
  UnavailableReason,
} from './p165-domain/price-check/types'
import type { LookupFailureReason, ObservationRow, PriceContract } from './model'

/** Fixed, user-safe copy for every Price Check state. No server text ever reaches the screen. */

export const UNAVAILABLE_COPY: Readonly<Record<UnavailableReason, string>> = {
  no_variant_price: 'The provider has no price for this printing. This is not a price of zero.',
  variant_not_in_response: 'The price service did not return this printing, so no price is shown.',
  provider_error:
    'The price provider failed for this card. This is not a price of zero — try again later.',
  rate_limited: 'The price provider is limiting requests. Try again in a moment.',
  network: 'Could not reach the price service. Check your connection and try again.',
  malformed_response: 'The price response could not be read exactly, so nothing from it is shown.',
  not_found: 'This card or printing could not be found.',
  unauthorized: 'Your session is no longer valid. Sign in again.',
  graded_source_not_configured: 'No verified graded market data available.',
  graded_no_data: 'The graded source has no data for this card.',
}

export const FAILURE_COPY: Readonly<Record<LookupFailureReason, string>> = {
  network: UNAVAILABLE_COPY.network,
  unauthorized: UNAVAILABLE_COPY.unauthorized,
  rate_limited: UNAVAILABLE_COPY.rate_limited,
  provider_error: UNAVAILABLE_COPY.provider_error,
  malformed_response: UNAVAILABLE_COPY.malformed_response,
  not_found: UNAVAILABLE_COPY.not_found,
  write_refused: 'This build is read-only; the request was refused.',
  unknown: 'Something went wrong while looking up the price. Try again.',
}

export const CONTRACT_COPY: Readonly<Record<PriceContract, string>> = {
  search_prices_observations: 'Every provider value reported for this exact printing.',
  search_prices_headline_only:
    'Partial: this server reports ONE provider value per printing. Another provider may have a price that is not shown.',
  released_snapshot_rpc:
    'Stored snapshot, converted to NOK by the server. The provider is chosen by your account’s EU/US pricing preference. This source does not report the original currency, amount or metric.',
}

export const FRESHNESS_COPY: Readonly<Record<Freshness, string>> = {
  fresh: 'Fresh',
  stale: 'Stale',
  outdated: 'Outdated — not a current price',
  unknown: 'Age unknown',
}

export const KIND_COPY: Readonly<Record<PriceKind, string>> = {
  index: 'Provider statistic',
  sold: 'Sold price',
  listing: 'Listing price',
}

export function ageText(ageDays: number | null): string {
  if (ageDays === null) return ''
  if (ageDays === 0) return 'today'
  return ageDays === 1 ? '1 day ago' : `${String(ageDays)} days ago`
}

/** "Provider updated 2026-09-15 (10 days ago) · Stale" — or the honest absence. */
export function observedText(
  observedAt: string | null,
  ageDays: number | null,
  freshness: Freshness,
): string {
  if (observedAt === null)
    return `Provider did not say when this was observed · ${FRESHNESS_COPY.unknown}`
  const age = ageText(ageDays)
  return `Provider updated ${observedAt.slice(0, 10)}${age === '' ? '' : ` (${age})`} · ${FRESHNESS_COPY[freshness]}`
}

export function nokText(row: Pick<ObservationRow, 'nok' | 'fxRateStale' | 'fxReadFailed'>): string {
  const nok: NokReference = row.nok
  if (nok.status === 'source_is_nok') return 'Reported in NOK'
  if (nok.status === 'converted') {
    return `NOK reference at ${nok.rate.rateToNok} NOK per unit (Norges Bank, ${nok.rate.rateDate})${
      row.fxRateStale ? ' — the rate is more than a week old' : ''
    }`
  }
  if (row.fxReadFailed)
    return 'No NOK reference: the exchange rate could not be read. The original currency is shown.'
  return nok.reason === 'fx_malformed'
    ? 'No NOK reference: the stored exchange rate is not valid. The original currency is shown.'
    : 'No NOK reference: no exchange rate is available. The original currency is shown.'
}

export function droppedText(dropped: readonly DroppedObservation[]): string | null {
  if (dropped.length === 0) return null
  return dropped.length === 1
    ? '1 provider value was refused (malformed or unsupported) and is not shown.'
    : `${String(dropped.length)} provider values were refused (malformed or unsupported) and are not shown.`
}

export function fetchedText(fetchedAt: string, fromCache: boolean): string {
  const time = fetchedAt.slice(11, 16)
  return `Fetched ${fetchedAt.slice(0, 10)} ${time} UTC${fromCache ? ' (from this session’s cache)' : ''}`
}

/** Accessibility label for one observation, read as one sentence. */
export function observationLabel(row: ObservationRow): string {
  const o = row.observation
  const nok = row.nok.status === 'converted' ? `, about ${formatMoney(row.nok.nok)}` : ''
  return `${o.providerLabel}, ${o.metricLabel}: ${formatMoney(o.price)}${nok}. ${observedText(o.observedAt, row.ageDays, row.freshness)}.`
}
