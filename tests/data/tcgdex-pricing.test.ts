import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCardPricing } from '../../supabase/functions/_shared/tcgdex'

/**
 * Deterministic, no-network tests for the M9 price-mapping adapter
 * (supabase/functions/_shared/tcgdex.ts's pricing section). Fixture payloads below are trimmed
 * REAL responses captured live 2026-08-21 (docs/RESEARCH.md carries the dated probes) — not
 * synthesized shapes, except where a fixture is explicitly labelled "constructed" to exercise a
 * real-shaped but not-yet-observed ambiguous case (prompt §16/§82).
 */

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchCardPricing — embedded per-variant pricing preferred (base1-4, Charizard)', () => {
  // Real response, trimmed. Only one of four declared variants carries real embedded pricing;
  // the other three either have an explicit null pricing object or no pricing key at all.
  const charizard = {
    id: 'base1-4',
    localId: '4',
    name: 'Charizard',
    variants: { firstEdition: true, holo: true, normal: false, reverse: false, wPromo: false },
    variants_detailed: [
      {
        type: 'holo',
        subtype: 'unlimited',
        size: 'standard',
        variantId: '4ffrmhcfiaejakhepqdkx7o',
        pricing: {
          cardmarket: {
            updated: '2026-08-21T08:03:05.070Z',
            unit: 'EUR',
            idProduct: 273699,
            avg: 402.79,
            low: 100,
            trend: 477.45,
            avg1: 150,
            avg7: 392.76,
            avg30: 399.62,
          },
          tcgplayer: {
            unit: 'USD',
            updated: '2026-08-21T08:03:02.360Z',
            holofoil: {
              productId: 42382,
              lowPrice: 510.07,
              midPrice: 950,
              highPrice: 4698.45,
              marketPrice: 855.52,
              directLowPrice: 633.67,
            },
          },
        },
      },
      {
        type: 'holo',
        subtype: 'shadowless',
        size: 'standard',
        stamp: ['1st-edition'],
        variantId: 'mtltux8qtgdu4exu903oasum21juxbvx6lx',
        pricing: { cardmarket: null, tcgplayer: null },
      },
      {
        type: 'holo',
        subtype: 'shadowless',
        size: 'standard',
        variantId: '3takscxpcqoqcfnxk1ivs2y6',
      },
      {
        type: 'holo',
        subtype: '1999-2000-copyright',
        size: 'standard',
        variantId: 'zqq5g2u9n0st0gren5bssktmac2ywqaw',
      },
    ],
    // Card-level pricing also present (the "-holo" fields here belong to none of the declared
    // variants above unambiguously — this is real, observed data, not a contrived edge case) —
    // must never leak into any variant via the card-level fallback path.
    pricing: {
      cardmarket: {
        updated: '2026-08-21T08:03:05.070Z',
        unit: 'EUR',
        idProduct: 273699,
        avg: 402.79,
        low: 100,
        trend: 477.45,
        'avg-holo': null,
        'low-holo': null,
        'trend-holo': 123.63,
      },
      tcgplayer: {
        unit: 'USD',
        updated: '2026-08-21T08:03:02.360Z',
        holofoil: { productId: 42382, marketPrice: 855.52 },
      },
    },
  }

  it('uses the embedded price for the exact variant TCGdex assigned it to', async () => {
    mockFetchOnce(charizard)
    const result = await fetchCardPricing('en', 'base1-4')
    const unlimited = result.variants.find((v) => v.subtype === 'unlimited')!
    expect(unlimited.cardmarket).toEqual({
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: 47745n,
      providerUpdatedAt: '2026-08-21T08:03:05.070Z',
    })
    expect(unlimited.tcgplayer).toEqual({
      provider: 'tcgdex_tcgplayer',
      priceKind: 'tp_market',
      sourceCurrency: 'USD',
      valueMinor: 85552n,
      providerUpdatedAt: '2026-08-21T08:03:02.360Z',
    })
  })

  it('treats an explicit null embedded pricing object as missing, not as a card-level fallback', async () => {
    mockFetchOnce(charizard)
    const result = await fetchCardPricing('en', 'base1-4')
    const shadowlessStamped = result.variants.find((v) => v.stamp === '1st-edition')!
    expect(shadowlessStamped.cardmarket).toBeNull()
    expect(shadowlessStamped.tcgplayer).toBeNull()
  })

  it('treats an absent pricing key on a declared variant as missing', async () => {
    mockFetchOnce(charizard)
    const result = await fetchCardPricing('en', 'base1-4')
    const copyright = result.variants.find((v) => v.subtype === '1999-2000-copyright')!
    expect(copyright.cardmarket).toBeNull()
    expect(copyright.tcgplayer).toBeNull()
  })

  it('never lets the card-level "-holo" fields leak onto an ambiguous sibling variant', async () => {
    mockFetchOnce(charizard)
    const result = await fetchCardPricing('en', 'base1-4')
    const plainShadowless = result.variants.find(
      (v) => v.subtype === 'shadowless' && v.stamp === '',
    )!
    expect(plainShadowless.cardmarket).toBeNull()
    expect(plainShadowless.tcgplayer).toBeNull()
  })
})

describe('fetchCardPricing — card-level-only fallback, unambiguous (swsh1-2, Roselia)', () => {
  // Real response: neither declared variant carries embedded pricing (both variantId "generated"),
  // and the two TCGplayer buckets legitimately share one productId (matches the existing
  // DATA_MODEL.md D-034 example) — never used as an identity signal here either.
  const roselia = {
    id: 'swsh1-2',
    localId: '2',
    name: 'Roselia',
    variants: { firstEdition: false, holo: false, normal: true, reverse: true, wPromo: false },
    variants_detailed: [
      { type: 'normal', size: 'standard', variantId: 'generated' },
      { type: 'reverse', size: 'standard', variantId: 'generated' },
    ],
    pricing: {
      cardmarket: {
        updated: '2026-08-21T08:03:04.936Z',
        unit: 'EUR',
        idProduct: 436189,
        avg: 0.14,
        low: 0.02,
        trend: 0.09,
        avg7: 0.1,
        avg30: 0.12,
        'avg-holo': 0.29,
        'low-holo': 0.08,
        'trend-holo': 0.43,
        'avg7-holo': 0.37,
        'avg30-holo': 0.29,
      },
      tcgplayer: {
        unit: 'USD',
        updated: '2026-08-21T08:03:20.122Z',
        'reverse-holofoil': { productId: 208268, marketPrice: 0.3 },
        normal: { productId: 208268, marketPrice: 0.17 },
      },
    },
  }

  it('maps the base Cardmarket fields to the single normal-finish variant', async () => {
    mockFetchOnce(roselia)
    const result = await fetchCardPricing('en', 'swsh1-2')
    const normal = result.variants.find((v) => v.finish === 'normal')!
    expect(normal.cardmarket).toEqual({
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: 9n,
      providerUpdatedAt: '2026-08-21T08:03:04.936Z',
    })
  })

  it('maps the "-holo" Cardmarket fields to the single non-normal (reverse) variant', async () => {
    mockFetchOnce(roselia)
    const result = await fetchCardPricing('en', 'swsh1-2')
    const reverse = result.variants.find((v) => v.finish === 'reverse')!
    expect(reverse.cardmarket).toEqual({
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: 43n,
      providerUpdatedAt: '2026-08-21T08:03:04.936Z',
    })
  })

  it('maps each TCGplayer finish bucket to its matching variant despite a shared productId', async () => {
    mockFetchOnce(roselia)
    const result = await fetchCardPricing('en', 'swsh1-2')
    const normal = result.variants.find((v) => v.finish === 'normal')!
    const reverse = result.variants.find((v) => v.finish === 'reverse')!
    expect(normal.tcgplayer).toEqual({
      provider: 'tcgdex_tcgplayer',
      priceKind: 'tp_market',
      sourceCurrency: 'USD',
      valueMinor: 17n,
      providerUpdatedAt: '2026-08-21T08:03:20.122Z',
    })
    expect(reverse.tcgplayer).toEqual({
      provider: 'tcgdex_tcgplayer',
      priceKind: 'tp_market',
      sourceCurrency: 'USD',
      valueMinor: 30n,
      providerUpdatedAt: '2026-08-21T08:03:20.122Z',
    })
  })
})

describe('fetchCardPricing — a real zero observation and a real missing provider (sve-001, Grass Energy)', () => {
  const grassEnergy = {
    id: 'sve-001',
    localId: '1',
    name: 'Grass Energy',
    category: 'Energy',
    variants: { firstEdition: false, holo: false, normal: true, reverse: true, wPromo: false },
    variants_detailed: [
      {
        type: 'normal',
        size: 'standard',
        variantId: 'endfynwn4n10gzq',
        pricing: {
          cardmarket: {
            updated: '2026-08-21T08:03:05.070Z',
            unit: 'EUR',
            idProduct: 689750,
            avg: 0.03,
            low: 0.02,
            trend: 0.04,
            avg7: 0.03,
            avg30: 0.03,
          },
          tcgplayer: null,
        },
      },
      {
        type: 'normal',
        stamp: ['player-rewards-program'],
        size: 'standard',
        variantId: 'gx8bq2hegum3q6irsxlvqxm955ikw9gd1h311',
        pricing: { cardmarket: null, tcgplayer: null },
      },
      {
        type: 'reverse',
        size: 'standard',
        variantId: '3739bbtj3i910y5ynn9xc6ryf',
        pricing: {
          cardmarket: {
            updated: '2026-08-21T08:03:05.070Z',
            unit: 'EUR',
            idProduct: 780803,
            avg: null,
            low: 0.02,
            trend: 0,
            avg7: null,
            avg30: null,
          },
          tcgplayer: {
            unit: 'USD',
            updated: '2026-08-21T08:03:24.506Z',
            'reverse-holofoil': { productId: 562155, marketPrice: 0.45 },
          },
        },
      },
    ],
    pricing: { cardmarket: { idProduct: 689750, avg: 0.03 }, tcgplayer: null },
  }

  it('stores a genuine zero trend as a real fresh price, not as missing (F9/F14)', async () => {
    mockFetchOnce(grassEnergy)
    const result = await fetchCardPricing('en', 'sve-001')
    const reverse = result.variants.find(
      (v) => v.finish === 'reverse' && v.stamp === '' && v.tcgplayer !== null,
    )!
    expect(reverse.cardmarket).toEqual({
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: 0n,
      providerUpdatedAt: '2026-08-21T08:03:05.070Z',
    })
  })

  it('leaves tcgplayer null for a variant whose embedded tcgplayer pricing is null', async () => {
    mockFetchOnce(grassEnergy)
    const result = await fetchCardPricing('en', 'sve-001')
    const plainNormal = result.variants.find((v) => v.finish === 'normal' && v.stamp === '')!
    expect(plainNormal.cardmarket).not.toBeNull()
    expect(plainNormal.tcgplayer).toBeNull()
  })

  it('leaves a stamped sibling variant unpriced even though other variants of the same card are priced', async () => {
    mockFetchOnce(grassEnergy)
    const result = await fetchCardPricing('en', 'sve-001')
    const stamped = result.variants.find((v) => v.stamp === 'player-rewards-program')!
    expect(stamped.cardmarket).toBeNull()
    expect(stamped.tcgplayer).toBeNull()
  })

  it('resolves distinct real Cardmarket idProducts per variant (never assumes product-id uniqueness, D-034)', async () => {
    mockFetchOnce(grassEnergy)
    const result = await fetchCardPricing('en', 'sve-001')
    // Both variants resolve independently priced Cardmarket candidates despite being the "same
    // card" — the whole point of variant-level, not card-level, identity.
    const normal = result.variants.find((v) => v.finish === 'normal' && v.stamp === '')!
    const reverse = result.variants.find((v) => v.finish === 'reverse' && v.stamp === '')!
    expect(normal.cardmarket?.valueMinor).toBe(4n)
    expect(reverse.cardmarket?.valueMinor).toBe(0n)
  })
})

describe('fetchCardPricing — ambiguous card-level mapping is skipped, never guessed (constructed)', () => {
  // Constructed, not captured live: a card-level-only (no embedded pricing) card declaring BOTH a
  // true holo and a reverse variant. Cardmarket's top-level pricing has only one non-normal slot
  // ("-holo"), so it cannot be safely attributed to either — prompt §15's exact "ambiguous price =
  // no price" case. Shaped from the same real fields observed elsewhere in this file.
  const ambiguousCard = {
    id: 'ambiguous-1',
    localId: '1',
    name: 'Ambiguous Test Card',
    variants: { firstEdition: false, holo: true, normal: true, reverse: true, wPromo: false },
    variants_detailed: [
      { type: 'normal', size: 'standard', variantId: 'generated' },
      { type: 'holo', size: 'standard', variantId: 'generated' },
      { type: 'reverse', size: 'standard', variantId: 'generated' },
    ],
    pricing: {
      cardmarket: {
        updated: '2026-08-21T08:03:05.070Z',
        unit: 'EUR',
        avg: 1,
        trend: 1.5,
        'avg-holo': 3,
        'trend-holo': 4.5,
      },
      tcgplayer: {
        unit: 'USD',
        updated: '2026-08-21T08:03:05.070Z',
        normal: { marketPrice: 1 },
        // Deliberately no holofoil/reverse-holofoil bucket — TCGplayer side stays unambiguous
        // regardless, since it is keyed by name; only the Cardmarket "-holo" slot is ambiguous here.
      },
    },
  }

  it('maps the unambiguous normal-finish Cardmarket/TCGplayer prices normally', async () => {
    mockFetchOnce(ambiguousCard)
    const result = await fetchCardPricing('en', 'ambiguous-1')
    const normal = result.variants.find((v) => v.finish === 'normal')!
    expect(normal.cardmarket?.valueMinor).toBe(150n)
    expect(normal.tcgplayer?.valueMinor).toBe(100n)
  })

  it('never guesses which of two non-normal variants the "-holo" Cardmarket slot belongs to', async () => {
    mockFetchOnce(ambiguousCard)
    const result = await fetchCardPricing('en', 'ambiguous-1')
    const holo = result.variants.find((v) => v.finish === 'holo')!
    const reverse = result.variants.find((v) => v.finish === 'reverse')!
    expect(holo.cardmarket).toBeNull()
    expect(reverse.cardmarket).toBeNull()
  })

  it('never guesses a TCGplayer bucket when more than one variant shares the unmapped finish', async () => {
    mockFetchOnce(ambiguousCard)
    const result = await fetchCardPricing('en', 'ambiguous-1')
    const holo = result.variants.find((v) => v.finish === 'holo')!
    const reverse = result.variants.find((v) => v.finish === 'reverse')!
    // No holofoil/reverse-holofoil bucket exists at all here, so both are correctly unpriced —
    // this asserts the *absence* case rather than a genuine same-key collision (TCGplayer keys are
    // already unambiguous by name; this test documents that TCGplayer degrades to "missing" rather
    // than a false match when no bucket exists for a finish).
    expect(holo.tcgplayer).toBeNull()
    expect(reverse.tcgplayer).toBeNull()
  })
})

describe('fetchCardPricing — no pricing at all', () => {
  it('resolves every variant to a fully missing price when the card has no pricing object', async () => {
    mockFetchOnce({
      id: 'no-price-1',
      localId: '1',
      name: 'Unpriced Card',
      variants: { firstEdition: false, holo: false, normal: true, reverse: false, wPromo: false },
    })
    const result = await fetchCardPricing('en', 'no-price-1')
    expect(result.variants).toHaveLength(1)
    expect(result.variants[0]!.cardmarket).toBeNull()
    expect(result.variants[0]!.tcgplayer).toBeNull()
  })
})
