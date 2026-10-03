import { convert } from '@shared/domain/fx'
import {
  GRADED_UNAVAILABLE,
  type CardSearchHit,
  type CardWithVariants,
  type PriceCheckPort,
  type PriceLookup,
  type UnavailableReason,
  type VariantIdentity,
} from './types'
import { mapObservationsWire, type PriceObservationWire } from './observation-wire'

/**
 * SYNTHETIC fixture of P153's richer price response, used where DB 104 cannot supply it. It is
 * deliberately shaped like the REAL wire (`observations[]` with `provider`, `priceKind`,
 * `sourceCurrency`, `valueMinor` as a decimal string, `providerUpdatedAt`), runs it through the same
 * mapper a live adapter will use, and marks every observation `synthetic: true` so the UI renders it
 * as synthetic. Nothing here is market data and nothing is presented as such.
 *
 * NOK references are computed with the SHARED domain's `convert` at fixed fixture rates; there is no
 * monetary arithmetic in this file.
 *
 * SPIKE_ONLY: delete when P153 releases and its `search-prices` `observations[]` is live.
 */

interface FixtureCard {
  cardId: string
  name: string
  setName: string
  collectorNumber: string
  language: 'en' | 'ja'
  variants: { variantId: string; finish: VariantIdentity['finish'] }[]
  outcome:
    | { kind: 'observations'; byVariant: Record<string, PriceObservationWire[]> }
    | { kind: 'unavailable'; reason: UnavailableReason }
}

const AT = '2026-09-19T10:00:00Z'

function wire(
  provider: string,
  priceKind: string,
  sourceCurrency: string,
  valueMinor: string,
): PriceObservationWire {
  return { provider, priceKind, sourceCurrency, valueMinor, providerUpdatedAt: AT }
}

const CARDS: readonly FixtureCard[] = [
  {
    cardId: 'fixture-card-twin',
    name: 'Fixture Twin Finish',
    setName: 'Synthetic Fixture Set',
    collectorNumber: 'F01',
    language: 'en',
    variants: [
      { variantId: 'fixture-variant-twin-normal', finish: 'normal' },
      { variantId: 'fixture-variant-twin-holo', finish: 'holo' },
    ],
    outcome: {
      kind: 'observations',
      byVariant: {
        'fixture-variant-twin-normal': [
          wire('tcgdex_cardmarket', 'cm_trend', 'EUR', '1234'),
          wire('tcgdex_tcgplayer', 'tp_market', 'USD', '1500'),
        ],
        'fixture-variant-twin-holo': [wire('tcgdex_cardmarket', 'cm_trend', 'EUR', '98765')],
      },
    },
  },
  {
    cardId: 'fixture-card-astronomical',
    name: 'Fixture Astronomical Value',
    setName: 'Synthetic Fixture Set',
    collectorNumber: 'F02',
    language: 'en',
    variants: [{ variantId: 'fixture-variant-astro', finish: 'normal' }],
    outcome: {
      kind: 'observations',
      byVariant: {
        'fixture-variant-astro': [
          wire('tcgdex_cardmarket', 'cm_trend', 'EUR', '288230376151711745'),
        ],
      },
    },
  },
  {
    cardId: 'fixture-card-jpy',
    name: 'Fixture JPY Zero Decimals',
    setName: 'Synthetic Fixture Set (ja)',
    collectorNumber: 'F03',
    language: 'ja',
    variants: [{ variantId: 'fixture-variant-jpy', finish: 'normal' }],
    outcome: {
      kind: 'observations',
      byVariant: {
        'fixture-variant-jpy': [
          wire('p158_fixture_jpy', 'fixture_metric', 'JPY', '9007199254740993'),
        ],
      },
    },
  },
  {
    cardId: 'fixture-card-provider-error',
    name: 'Fixture Provider Error',
    setName: 'Synthetic Fixture Set',
    collectorNumber: 'F04',
    language: 'en',
    variants: [{ variantId: 'fixture-variant-perr', finish: 'normal' }],
    outcome: { kind: 'unavailable', reason: 'provider_error' },
  },
  {
    cardId: 'fixture-card-no-price',
    name: 'Fixture No Price',
    setName: 'Synthetic Fixture Set',
    collectorNumber: 'F05',
    language: 'en',
    variants: [{ variantId: 'fixture-variant-noprice', finish: 'normal' }],
    outcome: { kind: 'unavailable', reason: 'no_variant_price' },
  },
]

const FX_TO_NOK: Readonly<Record<string, string>> = { EUR: '11.5', USD: '10.5', JPY: '0.07' }

function variantIdentity(v: {
  variantId: string
  finish: VariantIdentity['finish']
}): VariantIdentity {
  return {
    variantId: v.variantId,
    finish: v.finish,
    stamp: '',
    subtype: '',
    size: 'standard',
    isActive: true,
  }
}

export function createFixturePriceCheckPort(): PriceCheckPort {
  return {
    sourceKind: 'p153_fixture',

    searchCards(query): Promise<readonly CardSearchHit[]> {
      const needle = query.trim().toLowerCase()
      const hits = CARDS.filter((c) => c.name.toLowerCase().includes(needle)).map((c) => ({
        cardId: c.cardId,
        name: c.name,
        setName: c.setName,
        collectorNumber: c.collectorNumber,
        language: c.language,
        rarity: null,
        variantCount: c.variants.length,
      }))
      return Promise.resolve(hits)
    },

    loadCard(cardId): Promise<CardWithVariants | null> {
      const card = CARDS.find((c) => c.cardId === cardId)
      if (card === undefined) return Promise.resolve(null)
      return Promise.resolve({
        card: {
          cardId: card.cardId,
          name: card.name,
          setId: 'fixture-set',
          setName: card.setName,
          collectorNumber: card.collectorNumber,
          language: card.language,
          imageBaseUrl: null,
          rarity: null,
          illustrator: null,
        },
        variants: card.variants.map(variantIdentity),
      })
    },

    resolveVariant(variantId) {
      const card = CARDS.find((c) => c.variants.some((v) => v.variantId === variantId))
      return Promise.resolve(card === undefined ? null : { cardId: card.cardId, variantId })
    },

    lookup(cardId, variantId): Promise<PriceLookup> {
      const card = CARDS.find((c) => c.cardId === cardId)
      const result = ((): PriceLookup => {
        if (card === undefined || !card.variants.some((v) => v.variantId === variantId)) {
          return {
            status: 'unavailable',
            source: 'p153_fixture',
            reason: 'not_found',
            graded: GRADED_UNAVAILABLE,
          }
        }
        if (card.outcome.kind === 'unavailable') {
          return {
            status: 'unavailable',
            source: 'p153_fixture',
            reason: card.outcome.reason,
            graded: GRADED_UNAVAILABLE,
          }
        }
        const { observations } = mapObservationsWire(card.outcome.byVariant[variantId] ?? [])
        if (observations.length === 0) {
          return {
            status: 'unavailable',
            source: 'p153_fixture',
            reason: 'no_variant_price',
            graded: GRADED_UNAVAILABLE,
          }
        }
        return {
          status: 'available',
          source: 'p153_fixture',
          observations: observations.map((o) => {
            const rate = o.source === null ? undefined : FX_TO_NOK[o.source.currency]
            return {
              ...o,
              nok: o.source !== null && rate !== undefined ? convert(o.source, rate, 'NOK') : null,
            }
          }),
          graded: GRADED_UNAVAILABLE,
        }
      })()
      return Promise.resolve(result)
    },
  }
}
