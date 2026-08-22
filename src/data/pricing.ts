import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import { summarizeCardPricing as summarizeCardPricingPure } from '../domain/pricing-summary'
export { type CardPriceSummary } from '../domain/pricing-summary'

/**
 * On-demand catalog pricing (search-prices Edge Function, M9/M9.1 prompt §48-50/§8-11) and real
 * snapshot history (get_card_variant_price_history RPC, prompt §51-53). Neither persists anything
 * — a search does not become history (DATA_MODEL.md §4.2); only the scheduled ingest job writes
 * `price_snapshots`.
 *
 * Search/Card Detail get an exact NOK reference alongside the real source-currency provenance
 * (M9.1 prompt §10-11) — the Edge Function converts server-side using the same `fx_rates` market
 * data `resolve_variant_market_values` reads, at the observation's own date. `valueNokMinor` is
 * `null` only when no FX rate is cached yet for that (currency, date) — shown as "—", never a
 * fabricated figure.
 */

export interface SearchPriceResult {
  cardVariantId: string
  cardId: string
  priceState: 'available' | 'missing'
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer' | null
  sourceCurrency: string | null
  sourceValueMinor: bigint | null
  valueNokMinor: bigint | null
  providerUpdatedAt: string | null
}

interface SearchPricesFunctionRow {
  cardVariantId: string
  cardId: string
  priceState: 'available' | 'missing'
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer' | null
  priceKind: string | null
  sourceCurrency: string | null
  sourceValueMinor: number | null
  valueNokMinor: string | null
  providerUpdatedAt: string | null
}

interface SearchPricesFunctionBody {
  ok: boolean
  results?: SearchPricesFunctionRow[]
  error?: string
}

export const SEARCH_PRICES_MAX_CARD_IDS = 20
const MAX_CARD_IDS = SEARCH_PRICES_MAX_CARD_IDS

/** Bounded batch (<=20 cards) — never one request per visible card (prompt §48). Silently returns
 *  an empty map on failure: pricing is a secondary enhancement and must never break Search/Card
 *  Detail's primary catalog browsing (prompt §80). */
export async function searchPrices(
  cardIds: string[],
  useEuPricing: boolean,
): Promise<Map<string, SearchPriceResult>> {
  const bounded = cardIds.slice(0, MAX_CARD_IDS)
  if (bounded.length === 0) return new Map()

  try {
    const invoked = await supabase.functions.invoke('search-prices', {
      body: { cardIds: bounded, useEuPricing },
    })
    const body = invoked.data as SearchPricesFunctionBody | null
    if (invoked.error || !body?.ok || !body.results) return new Map()

    return new Map(
      body.results.map((r) => [
        r.cardVariantId,
        {
          cardVariantId: r.cardVariantId,
          cardId: r.cardId,
          priceState: r.priceState,
          provider: r.provider,
          sourceCurrency: r.sourceCurrency,
          sourceValueMinor:
            r.sourceValueMinor === null ? null : BigInt(Math.round(r.sourceValueMinor)),
          valueNokMinor: r.valueNokMinor === null ? null : BigInt(r.valueNokMinor),
          providerUpdatedAt: r.providerUpdatedAt,
        },
      ]),
    )
  } catch {
    return new Map()
  }
}

/** Thin re-export over the pure `src/domain/pricing-summary.ts` implementation — kept here so
 *  existing `../../data/pricing` call sites don't change, tested directly against the domain
 *  module (no Supabase env needed) in `tests/data/pricing.test.ts`. */
export function summarizeCardPricing(
  results: Iterable<SearchPriceResult>,
): Map<string, import('../domain/pricing-summary').CardPriceSummary> {
  return summarizeCardPricingPure(results)
}

export interface PriceHistoryPoint {
  snapshotDate: string
  valueNokMinor: bigint
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'
}

interface PriceHistoryRow {
  snapshot_date: string
  value_nok_minor: string
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'
  price_kind: string
}

/** Real snapshots only — never a fabricated point, never an avg7/avg30 rolling statistic
 *  mistaken for history (D-008). Empty for a variant nobody has ever owned (watched_card_variants
 *  never covered it) or one owned for less than a day. */
export type MarketMoverSort =
  'most_movement' | 'least_movement' | 'highest_increase' | 'largest_decrease'

export interface MarketMover {
  holdingId: string
  cardVariantId: string
  cardName: string | null
  cardImageBaseUrl: string | null
  quantity: number
  currentValueMinor: bigint
  previousValueMinor: bigint
  changeMinor: bigint
  changePct: number | null
  /** Secondary, informational only (M9.1 prompt §23) — unit change x quantity. Ranking is always
   *  by the per-unit change_pct; this never drives sort order. */
  holdingImpactMinor: bigint
}

interface MarketMoverRow {
  holding_id: string
  card_variant_id: string
  card_name: string | null
  card_image_base_url: string | null
  quantity: number
  current_value_nok_minor: string
  previous_value_nok_minor: string
  change_nok_minor: string
  change_pct: number | null
  holding_impact_nok_minor: string
}

/** Real price movement of currently-owned, currently-priced holdings only (prompt §18-23) — never
 *  a global catalog ranking, never a realized-P/L figure. A holding with no historical observation
 *  in the window is simply absent, never shown as 0% movement. Ranks by per-unit change_pct
 *  (`sort`), never by holding-total kroner — see the migration header for why. */
export async function getMarketMovers(
  periodDays: number,
  limit = 10,
  sort: MarketMoverSort = 'most_movement',
): Promise<MarketMover[]> {
  const { data, error } = await supabase
    .rpc('get_market_movers', { p_period_days: periodDays, p_limit: limit, p_sort: sort })
    .overrideTypes<MarketMoverRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    holdingId: row.holding_id,
    cardVariantId: row.card_variant_id,
    cardName: row.card_name,
    cardImageBaseUrl: row.card_image_base_url,
    quantity: row.quantity,
    currentValueMinor: parseMinorUnits(row.current_value_nok_minor),
    previousValueMinor: parseMinorUnits(row.previous_value_nok_minor),
    changeMinor: parseMinorUnits(row.change_nok_minor),
    changePct: row.change_pct,
    holdingImpactMinor: parseMinorUnits(row.holding_impact_nok_minor),
  }))
}

export async function getCardVariantPriceHistory(
  cardVariantId: string,
  since?: string,
): Promise<PriceHistoryPoint[]> {
  const { data, error } = await supabase
    .rpc('get_card_variant_price_history', { p_card_variant_id: cardVariantId, p_since: since })
    .overrideTypes<PriceHistoryRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    snapshotDate: row.snapshot_date,
    valueNokMinor: parseMinorUnits(row.value_nok_minor),
    provider: row.provider,
  }))
}
