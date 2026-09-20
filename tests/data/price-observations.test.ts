import { describe, expect, it } from 'vitest'
import { observationsForVariant } from '../../supabase/functions/_shared/price-observations'
import { fetchCardPricing } from '../../supabase/functions/_shared/tcgdex'

/**
 * The wire shape `search-prices` adds for Price Check (P153): every provider candidate the
 * variant-safe TCGdex mapper found for ONE exact variant, as exact integer-string minor units with
 * the provider's own timestamp. Expected values are literals.
 */

const CM = {
  provider: 'tcgdex_cardmarket',
  priceKind: 'cm_trend',
  sourceCurrency: 'EUR',
  valueMinor: 1234n,
  providerUpdatedAt: '2026-09-19T08:03:04Z',
} as const
const TP = {
  provider: 'tcgdex_tcgplayer',
  priceKind: 'tp_market',
  sourceCurrency: 'USD',
  valueMinor: 1500n,
  providerUpdatedAt: '2026-09-18T00:00:00Z',
} as const

describe('observationsForVariant', () => {
  it('returns both providers, Cardmarket first, with exact string minor units and provider dates', () => {
    expect(observationsForVariant({ cardmarket: CM, tcgplayer: TP })).toEqual([
      {
        provider: 'tcgdex_cardmarket',
        priceKind: 'cm_trend',
        sourceCurrency: 'EUR',
        valueMinor: '1234',
        providerUpdatedAt: '2026-09-19T08:03:04Z',
      },
      {
        provider: 'tcgdex_tcgplayer',
        priceKind: 'tp_market',
        sourceCurrency: 'USD',
        valueMinor: '1500',
        providerUpdatedAt: '2026-09-18T00:00:00Z',
      },
    ])
  })

  it('an ambiguous provider (the mapper returned null) contributes nothing — no borrowed value', () => {
    expect(observationsForVariant({ cardmarket: null, tcgplayer: TP })).toHaveLength(1)
    expect(observationsForVariant({ cardmarket: CM, tcgplayer: null })).toHaveLength(1)
    expect(observationsForVariant({ cardmarket: null, tcgplayer: null })).toEqual([])
  })

  it('an unmatched variant yields an empty list, never a zero', () => {
    expect(observationsForVariant(undefined)).toEqual([])
  })

  it('keeps a genuine zero and values beyond Number.MAX_SAFE_INTEGER exact', () => {
    const [zero] = observationsForVariant({
      cardmarket: { ...CM, valueMinor: 0n },
      tcgplayer: null,
    })
    expect(zero?.valueMinor).toBe('0')
    const [big] = observationsForVariant({
      cardmarket: { ...CM, valueMinor: 9007199254740993n },
      tcgplayer: null,
    })
    expect(big?.valueMinor).toBe('9007199254740993')
  })

  it('preserves a missing provider timestamp as null (it is never stamped with "now")', () => {
    const [o] = observationsForVariant({
      cardmarket: { ...CM, providerUpdatedAt: null },
      tcgplayer: null,
    })
    expect(o?.providerUpdatedAt).toBeNull()
  })
})

describe('end to end with the real TCGdex variant mapper (fetch stubbed)', () => {
  it('a card whose pricing is ambiguous across variants gets no observation for the ambiguous slot', async () => {
    // Two non-normal finishes on one card: the Cardmarket `-holo` slot cannot be attributed to
    // either (see the mapper's own header), so neither variant may receive it.
    const payload = {
      id: 'x-1',
      localId: '1',
      name: 'X',
      variants: { normal: false, holo: true, reverse: true, firstEdition: false, wPromo: false },
      pricing: {
        cardmarket: { updated: '2026-09-19T08:03:04Z', 'trend-holo': 9.99 },
        tcgplayer: null,
      },
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch
    try {
      const pricing = await fetchCardPricing('en', 'x-1')
      expect(pricing.variants.length).toBeGreaterThanOrEqual(2)
      for (const variant of pricing.variants) {
        expect(observationsForVariant(variant)).toEqual([])
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
