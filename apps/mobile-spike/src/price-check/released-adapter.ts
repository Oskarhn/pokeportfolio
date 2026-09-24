import {
  getCard,
  getCardVariants,
  getCardVariantWithCard,
  searchCards,
  type CatalogLanguage as SharedLanguage,
} from '@shared/data/catalog'
import { getCardVariantPriceHistory } from '@shared/data/pricing'
import {
  GRADED_UNAVAILABLE,
  type CardIdentity,
  type CardSearchHit,
  type CardWithVariants,
  type PriceCheckPort,
  type PriceLookup,
  type PriceObservationView,
  type VariantIdentity,
} from './types'

/**
 * Price Check port backed by what the RELEASED backend (DB 104) already offers, reused unchanged from
 * the web data layer: `search_cards`, the `cards` / `card_variants` tables, and the
 * `get_card_variant_price_history` RPC (real `price_snapshots`, converted to NOK server-side).
 * Every one of these is a read. Nothing here can write, and the client would refuse to send one.
 *
 * What the released interface CANNOT say, stated in the data instead of hidden:
 *   - no source currency or metric (the RPC returns provider + NOK only)  -> `source: null`,
 *     `metric: null`, kind 'unknown', and the basis note says so;
 *   - no graded prices at all (no authorized source)                      -> GRADED_UNAVAILABLE;
 *   - no per-condition breakdown                                          -> `condition: null`.
 * P153's richer `observations[]` (source currency, metric, provider timestamp per candidate) is NOT
 * live on DB 104; it is exercised through the fixture adapter instead (fixture-adapter.ts).
 *
 * SPIKE_ONLY: replaced by P153's data layer (src/data/price-check.ts) after it releases.
 */

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  tcgdex_cardmarket: 'Cardmarket via TCGdex',
  tcgdex_tcgplayer: 'TCGplayer via TCGdex',
}

function toLanguage(value: SharedLanguage): 'en' | 'ja' {
  return value === 'ja' ? 'ja' : 'en'
}

export function createReleasedPriceCheckPort(): PriceCheckPort {
  return {
    sourceKind: 'released_snapshots',

    async searchCards(query): Promise<readonly CardSearchHit[]> {
      const page = await searchCards({ query, language: null, limit: 40 })
      return page.results.map((r) => ({
        cardId: r.cardId,
        name: r.name,
        setName: r.setName,
        collectorNumber: r.localId,
        language: toLanguage(r.language),
        rarity: r.rarity,
        variantCount: r.variantCount,
      }))
    },

    async loadCard(cardId): Promise<CardWithVariants | null> {
      const [card, variants] = await Promise.all([getCard(cardId), getCardVariants(cardId)])
      if (card === null) return null
      const identity: CardIdentity = {
        cardId: card.id,
        name: card.name,
        setId: card.setId,
        setName: card.setName,
        collectorNumber: card.localId,
        language: toLanguage(card.language),
        imageBaseUrl: card.imageBaseUrl,
        rarity: card.rarity,
        illustrator: card.illustrator,
      }
      const mapped: VariantIdentity[] = variants.map((v) => ({
        variantId: v.id,
        finish: v.finish,
        stamp: v.stamp,
        subtype: v.subtype,
        size: v.size,
        isActive: v.isActive,
      }))
      return { card: identity, variants: mapped }
    },

    async resolveVariant(variantId) {
      const found = await getCardVariantWithCard(variantId)
      return found === null ? null : { cardId: found.cardId, variantId: found.id }
    },

    async lookup(_cardId, variantId): Promise<PriceLookup> {
      const history = await getCardVariantPriceHistory(variantId)
      // Newest snapshot per provider. Both providers can have a row for the same day.
      const latest = new Map<string, (typeof history)[number]>()
      for (const point of history) {
        const current = latest.get(point.provider ?? 'unknown')
        if (current === undefined || point.snapshotDate > current.snapshotDate) {
          latest.set(point.provider ?? 'unknown', point)
        }
      }
      if (latest.size === 0) {
        return {
          status: 'unavailable',
          source: 'released_snapshots',
          reason: 'no_variant_price',
          graded: GRADED_UNAVAILABLE,
        }
      }
      const observations: PriceObservationView[] = [...latest.entries()].map(
        ([provider, point]) => ({
          provider,
          providerLabel: PROVIDER_LABEL[provider] ?? provider,
          metric: null,
          metricLabel: 'Price index',
          basisNote:
            'Converted to NOK by the server from the provider’s source currency. This endpoint does not return the source currency or the metric.',
          kind: 'unknown',
          source: null,
          nok: { minorUnits: point.valueNokMinor, currency: 'NOK' },
          observedAt: point.snapshotDate,
          condition: null,
          synthetic: false,
        }),
      )
      return {
        status: 'available',
        source: 'released_snapshots',
        observations,
        graded: GRADED_UNAVAILABLE,
      }
    },
  }
}
