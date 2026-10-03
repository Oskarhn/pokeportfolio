import type { CurrencyCode } from '@shared/domain/currency'
import { classifyFailure, type FailureKind } from '../../net/failure'
import type { Resettable } from '../../state/registry'
import { nokReference, type FxRateParse } from './p165-domain/price-check/fx'
import { ageInDays, classifyFreshness, isFxRateStale } from './p165-domain/price-check/freshness'
import { gradedSection } from './p165-domain/price-check/graded'
import { buildRawSection, type CardPriceResponse } from './p165-domain/price-check/raw-section'
import { readLatestFxRate, type FxRateReader } from './fx-source'
import {
  PriceLookupError,
  isAbortError,
  type CardIdentity,
  type LookupFailureReason,
  type ObservationRow,
  type PriceCheckResult,
  type PriceSourceKind,
  type RawPriceResult,
  type VariantIdentity,
} from './model'
import { fetchSearchPricesResponse, type SearchPricesInvoker } from './search-prices-source'
import { latestSnapshotHeadlines, type SnapshotHistoryReader } from './snapshot-source'

/**
 * Reads the price of ONE confirmed catalog variant from the chosen source and turns it into the
 * P169 result model, using the vendored P165 domain for every rule (observation validation, raw
 * section states, freshness, FX reference, graded status). Read-only: its only collaborators are
 * the search-prices invoker, the fx_rates reader and the snapshot-history reader.
 *
 * CACHE. Keys are built from stable catalog ids and the source, never from a card name (many cards
 * share one; P169 fixtures include two "P169 Pikachu" #025 in different sets):
 *   search_prices:<cardId>    one function response covers every variant of that card, so a variant
 *                             switch reuses it instead of calling the provider again (P165 keys raw
 *                             data per card for the same reason);
 *   snapshot_rpc:<variantId>  per variant, and ACCOUNT-SPECIFIC (provider by the caller's preference);
 *   fx:<currency>             market data, one read per currency.
 * A cached answer keeps its ORIGINAL fetchedAt and is marked fromCache, so freshness is never
 * refreshed by a cache hit. The whole cache is dropped on every identity change (Resettable), so
 * nothing read as user A can be shown to user B, not even account-independent market data.
 */

export const PRICE_CACHE_TTL_MS = 5 * 60 * 1000
export const FX_CACHE_TTL_MS = 60 * 60 * 1000

export interface PriceLookupDeps {
  readonly invoke: SearchPricesInvoker
  readonly readFx: FxRateReader
  readonly readSnapshots: SnapshotHistoryReader
  readonly now: () => number
  /** Optional instrumentation (request counts, timings) for tests and the device harness. */
  readonly onEvent?: (event: PriceLookupEvent) => void
}

export type PriceLookupEvent =
  | { type: 'provider_request'; cardId: string; ms: number; outcome: 'ok' | 'error' | 'aborted' }
  | { type: 'snapshot_request'; variantId: string; ms: number; outcome: 'ok' | 'error' | 'aborted' }
  | { type: 'fx_request'; currency: string; ms: number }
  | { type: 'cache_hit'; key: string }

interface Cached<T> {
  readonly value: T
  readonly storedAt: number
}

export function rawCacheKey(
  source: PriceSourceKind,
  card: CardIdentity,
  variant: VariantIdentity,
): string {
  return source === 'search_prices'
    ? `search_prices:${card.cardId}`
    : `snapshot_rpc:${variant.variantId}`
}

export class PriceLookupService implements Resettable {
  private readonly responses = new Map<string, Cached<CardPriceResponse>>()
  private readonly snapshots = new Map<
    string,
    Cached<{ history: Awaited<ReturnType<SnapshotHistoryReader>>; fetchedAt: string }>
  >()
  private readonly fx = new Map<string, Cached<FxRateParse>>()
  private generation = 0

  constructor(private readonly deps: PriceLookupDeps) {}

  /** Identity boundary: forget everything, and make any read still in flight unable to fill the cache. */
  reset(): void {
    this.generation += 1
    this.responses.clear()
    this.snapshots.clear()
    this.fx.clear()
  }

  private fresh<T>(entry: Cached<T> | undefined, ttl: number): entry is Cached<T> {
    return entry !== undefined && this.deps.now() - entry.storedAt < ttl
  }

  async lookup(
    source: PriceSourceKind,
    card: CardIdentity,
    variant: VariantIdentity,
    signal?: AbortSignal,
  ): Promise<PriceCheckResult> {
    const raw =
      source === 'search_prices'
        ? await this.fromSearchPrices(card, variant, signal)
        : await this.fromSnapshots(card, variant, signal)
    return {
      cardId: card.cardId,
      variantId: variant.variantId,
      source,
      raw,
      // No authorized graded source exists (P165/P153 §9, docs/API_SOURCES.md): nothing is
      // consulted, and nothing is ever derived from a raw price.
      graded: gradedSection({ sources: [], observations: [], dropped: [] }),
    }
  }

  private async fromSearchPrices(
    card: CardIdentity,
    variant: VariantIdentity,
    signal: AbortSignal | undefined,
  ): Promise<RawPriceResult> {
    const key = rawCacheKey('search_prices', card, variant)
    const cached = this.responses.get(key)
    let response: CardPriceResponse
    let fromCache = false
    if (this.fresh(cached, PRICE_CACHE_TTL_MS)) {
      response = cached.value
      fromCache = true
      this.deps.onEvent?.({ type: 'cache_hit', key })
    } else {
      const generation = this.generation
      const started = this.deps.now()
      try {
        response = await fetchSearchPricesResponse(card.cardId, {
          invoke: this.deps.invoke,
          now: this.deps.now,
          ...(signal !== undefined ? { signal } : {}),
        })
        this.deps.onEvent?.({
          type: 'provider_request',
          cardId: card.cardId,
          ms: this.deps.now() - started,
          outcome: 'ok',
        })
      } catch (error) {
        this.deps.onEvent?.({
          type: 'provider_request',
          cardId: card.cardId,
          ms: this.deps.now() - started,
          outcome: isAbortError(error) ? 'aborted' : 'error',
        })
        throw error
      }
      // Only a complete, non-failed answer is cached; a provider failure is retried next time.
      if (generation === this.generation && response.providerErrorCount === 0) {
        this.responses.set(key, { value: response, storedAt: this.deps.now() })
      }
    }

    const { section, headlineOnly } = buildRawSection(response, variant)
    const contract = headlineOnly ? 'search_prices_headline_only' : 'search_prices_observations'
    if (section.status === 'unavailable') {
      return {
        status: 'unavailable',
        contract,
        reason: section.unavailable ?? 'no_variant_price',
        dropped: section.dropped,
        fetchedAt: response.fetchedAt,
        fromCache,
      }
    }

    const now = this.deps.now()
    const rates = new Map<string, { parse: FxRateParse | null; failed: boolean }>()
    for (const o of section.observations) {
      const currency = o.price.currency
      if (!rates.has(currency)) rates.set(currency, await this.rate(currency, signal))
    }
    const rows: ObservationRow[] = section.observations.map((observation) => {
      const rate = rates.get(observation.price.currency) ?? { parse: null, failed: false }
      const nok = nokReference(observation.price, rate.parse)
      return {
        observation,
        freshness: classifyFreshness(observation.observedAt, now),
        ageDays: ageInDays(observation.observedAt, now),
        nok,
        fxRateStale: nok.status === 'converted' ? isFxRateStale(nok.rate.rateDate, now) : false,
        fxReadFailed: rate.failed,
      }
    })
    return {
      status: 'observations',
      contract,
      rows,
      dropped: section.dropped,
      fetchedAt: response.fetchedAt,
      fromCache,
    }
  }

  private async rate(
    currency: CurrencyCode,
    signal: AbortSignal | undefined,
  ): Promise<{ parse: FxRateParse | null; failed: boolean }> {
    const key = `fx:${currency}`
    const cached = this.fx.get(key)
    if (this.fresh(cached, FX_CACHE_TTL_MS)) return { parse: cached.value, failed: false }
    const generation = this.generation
    const started = this.deps.now()
    try {
      const parse = await readLatestFxRate(currency, this.deps.readFx)
      this.deps.onEvent?.({ type: 'fx_request', currency, ms: this.deps.now() - started })
      if (signal?.aborted === true)
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      if (generation === this.generation)
        this.fx.set(key, { value: parse, storedAt: this.deps.now() })
      return { parse, failed: false }
    } catch (error) {
      if (isAbortError(error)) throw error
      // A failed rate READ keeps the observation visible in its source currency.
      return { parse: null, failed: true }
    }
  }

  private async fromSnapshots(
    card: CardIdentity,
    variant: VariantIdentity,
    signal: AbortSignal | undefined,
  ): Promise<RawPriceResult> {
    const key = rawCacheKey('snapshot_rpc', card, variant)
    const cached = this.snapshots.get(key)
    let entry: { history: Awaited<ReturnType<SnapshotHistoryReader>>; fetchedAt: string }
    let fromCache = false
    if (this.fresh(cached, PRICE_CACHE_TTL_MS)) {
      entry = cached.value
      fromCache = true
      this.deps.onEvent?.({ type: 'cache_hit', key })
    } else {
      const generation = this.generation
      const started = this.deps.now()
      let history: Awaited<ReturnType<SnapshotHistoryReader>>
      try {
        history = await this.deps.readSnapshots(variant.variantId)
      } catch (error) {
        this.deps.onEvent?.({
          type: 'snapshot_request',
          variantId: variant.variantId,
          ms: this.deps.now() - started,
          outcome: 'error',
        })
        throw error instanceof PriceLookupError ? error : classifySnapshotError(error)
      }
      this.deps.onEvent?.({
        type: 'snapshot_request',
        variantId: variant.variantId,
        ms: this.deps.now() - started,
        outcome: 'ok',
      })
      if (signal?.aborted === true)
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      entry = { history, fetchedAt: new Date(this.deps.now()).toISOString() }
      if (generation === this.generation)
        this.snapshots.set(key, { value: entry, storedAt: this.deps.now() })
    }
    const headlines = latestSnapshotHeadlines(entry.history, this.deps.now())
    if (headlines.length === 0) {
      return {
        status: 'unavailable',
        contract: 'released_snapshot_rpc',
        reason: 'no_variant_price',
        dropped: [],
        fetchedAt: entry.fetchedAt,
        fromCache,
      }
    }
    return {
      status: 'snapshot',
      contract: 'released_snapshot_rpc',
      headlines,
      fetchedAt: entry.fetchedAt,
      fromCache,
    }
  }
}

const FAILURE_TO_REASON: Readonly<Record<FailureKind, LookupFailureReason>> = {
  offline: 'network',
  unauthorized: 'unauthorized',
  forbidden: 'unauthorized',
  not_found: 'not_found',
  server: 'provider_error',
  unsafe_numeric: 'malformed_response',
  write_refused: 'write_refused',
  request_rejected: 'provider_error',
  identity_changed: 'unknown',
  credentials_unavailable: 'network',
  unknown: 'unknown',
}

/** The shared data wrapper rethrows `new Error(message)`; P166's `classifyFailure` recovers the
 *  status from it (src/net/failure.ts). A money column that is not an integer string makes the
 *  shared `parseMinorUnits` (BigInt) throw a SyntaxError: that is a malformed response. */
function classifySnapshotError(error: unknown): PriceLookupError {
  if ((error as { name?: unknown } | null)?.name === 'SyntaxError') {
    return new PriceLookupError('malformed_response')
  }
  const failure = classifyFailure(error)
  if (failure.status === 429) return new PriceLookupError('rate_limited')
  return new PriceLookupError(FAILURE_TO_REASON[failure.kind])
}
