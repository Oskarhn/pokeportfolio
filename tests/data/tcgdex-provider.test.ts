import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCardDetail,
  fetchSetDetail,
  isPocketSeries,
  TcgdexNotFoundError,
} from '../../supabase/functions/_shared/tcgdex'

/**
 * Deterministic, no-network tests for the TCGdex provider adapter (docs/ARCHITECTURE.md §5).
 * Fixture payloads below are trimmed real responses captured 2026-08-20 — see docs/RESEARCH.md —
 * not synthesized shapes, so a genuine upstream change (a renamed field, a new `type` value) is
 * exactly the kind of thing these tests would catch. Real-provider contract tests live separately
 * (docs/TESTING.md) and are not part of this deterministic suite.
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

describe('isPocketSeries', () => {
  it('identifies the Pokémon TCG Pocket series id', () => {
    expect(isPocketSeries('tcgp')).toBe(true)
  })

  it('does not flag an ordinary physical series', () => {
    expect(isPocketSeries('base')).toBe(false)
    expect(isPocketSeries('sv')).toBe(false)
  })
})

describe('fetchCardDetail — variants_detailed present', () => {
  // Real base1-4 (Charizard, Base Set) response, trimmed to the fields the adapter reads.
  const charizardResponse = {
    id: 'base1-4',
    localId: '4',
    name: 'Charizard',
    category: 'Pokemon',
    rarity: 'Rare',
    illustrator: 'Mitsuhiro Arita',
    image: 'https://assets.tcgdex.net/en/base/base1/4',
    set: { id: 'base1', name: 'Base Set' },
    variants: { firstEdition: true, holo: true, normal: false, reverse: false, wPromo: false },
    variants_detailed: [
      {
        type: 'holo',
        subtype: 'unlimited',
        size: 'standard',
        variantId: '4ffrmhcfiaejakhepqdkx7o',
        pricing: {
          cardmarket: { idProduct: 273699 },
          tcgplayer: { holofoil: { productId: 42382 } },
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
  }

  it('maps four distinct real variants spanning finish, subtype and stamp at once', async () => {
    mockFetchOnce(charizardResponse)
    const card = await fetchCardDetail('en', 'base1-4')

    expect(card.variants).toHaveLength(4)
    // The exact combination the M3 single-enum variant_type could not represent.
    expect(card.variants).toContainEqual(
      expect.objectContaining({ finish: 'holo', subtype: 'shadowless', stamp: '1st-edition' }),
    )
    expect(card.variants).toContainEqual(
      expect.objectContaining({ finish: 'holo', subtype: 'unlimited', stamp: '' }),
    )
    expect(card.variants).toContainEqual(
      expect.objectContaining({ finish: 'holo', subtype: '1999-2000-copyright', stamp: '' }),
    )
  })

  it('keeps a real provider variant id and best-effort pricing product ids', async () => {
    mockFetchOnce(charizardResponse)
    const card = await fetchCardDetail('en', 'base1-4')
    const unlimited = card.variants.find((v) => v.subtype === 'unlimited')
    expect(unlimited?.tcgdexVariantId).toBe('4ffrmhcfiaejakhepqdkx7o')
    expect(unlimited?.cardmarketProductId).toBe('273699')
    expect(unlimited?.tcgplayerProductId).toBe('42382')
  })

  it('maps card-level fields', async () => {
    mockFetchOnce(charizardResponse)
    const card = await fetchCardDetail('en', 'base1-4')
    expect(card.name).toBe('Charizard')
    expect(card.category).toBe('Pokemon')
    expect(card.rarity).toBe('Rare')
  })
})

describe('fetchCardDetail — the "generated" sentinel', () => {
  it('maps a literal "generated" variantId to null rather than a fake identity', async () => {
    mockFetchOnce({
      id: 'swsh1-1',
      localId: '1',
      name: 'Celebi V',
      set: { id: 'swsh1' },
      variants: { holo: true, normal: false, reverse: false, firstEdition: false, wPromo: false },
      variants_detailed: [{ type: 'holo', size: 'standard', variantId: 'generated' }],
    })
    const card = await fetchCardDetail('en', 'swsh1-1')
    expect(card.variants).toHaveLength(1)
    expect(card.variants[0]?.tcgdexVariantId).toBeNull()
  })
})

describe('fetchCardDetail — fallback to boolean flags', () => {
  it('synthesizes variants from `variants` when variants_detailed is absent', async () => {
    mockFetchOnce({
      id: 'old1-1',
      localId: '1',
      name: 'Old Card',
      set: { id: 'old1' },
      variants: { holo: false, normal: true, reverse: true, firstEdition: false, wPromo: false },
    })
    const card = await fetchCardDetail('en', 'old1-1')
    expect(card.variants.map((v) => v.finish).sort()).toEqual(['normal', 'reverse'])
  })

  it('marks a first-edition flag as a stamp on the fallback path', async () => {
    mockFetchOnce({
      id: 'old1-2',
      localId: '2',
      name: 'Old First Edition Card',
      set: { id: 'old1' },
      variants: { holo: false, normal: true, reverse: false, firstEdition: true, wPromo: false },
      variants_detailed: [],
    })
    const card = await fetchCardDetail('en', 'old1-2')
    expect(card.variants).toEqual([
      expect.objectContaining({ finish: 'normal', stamp: '1st-edition' }),
    ])
  })

  it('never returns zero variants, even with every flag false', async () => {
    mockFetchOnce({
      id: 'old1-3',
      localId: '3',
      name: 'Mystery Card',
      set: { id: 'old1' },
      variants: { holo: false, normal: false, reverse: false, firstEdition: false, wPromo: false },
    })
    const card = await fetchCardDetail('en', 'old1-3')
    expect(card.variants).toHaveLength(1)
    expect(card.variants[0]?.finish).toBe('other')
  })
})

describe('fetchCardDetail — an Energy card', () => {
  it('carries category "Energy" through untouched', async () => {
    mockFetchOnce({
      id: 'base1-98',
      localId: '98',
      name: 'Fire Energy',
      category: 'Energy',
      set: { id: 'base1' },
      variants: { holo: false, normal: true, reverse: false, firstEdition: true, wPromo: false },
      variants_detailed: [{ type: 'normal', subtype: 'unlimited', size: 'standard' }],
    })
    const card = await fetchCardDetail('en', 'base1-98')
    expect(card.category).toBe('Energy')
    expect(card.variants[0]?.finish).toBe('normal')
  })
})

describe('fetchCardDetail — not found', () => {
  it('throws TcgdexNotFoundError on a 404', async () => {
    mockFetchOnce({ status: 404 }, 404)
    await expect(fetchCardDetail('en', 'does-not-exist')).rejects.toBeInstanceOf(
      TcgdexNotFoundError,
    )
  })
})

describe('fetchSetDetail', () => {
  it('maps series, cardCount and the lite card id list', async () => {
    mockFetchOnce({
      id: 'base1',
      name: 'Base Set',
      serie: { id: 'base', name: 'Base' },
      cardCount: { official: 102, total: 102 },
      releaseDate: '1999-01-09',
      cards: [
        { id: 'base1-1', localId: '1', name: 'Alakazam' },
        { id: 'base1-4', localId: '4', name: 'Charizard' },
      ],
    })
    const set = await fetchSetDetail('en', 'base1')
    expect(set.series).toEqual({ tcgdexSeriesId: 'base', name: 'Base' })
    expect(set.cardCountOfficial).toBe(102)
    expect(set.cardIds).toEqual(['base1-1', 'base1-4'])
  })

  it('identifies a Pokémon TCG Pocket set via its serie id', async () => {
    mockFetchOnce({
      id: 'A1',
      name: 'Genetic Apex',
      serie: { id: 'tcgp', name: 'Pokémon TCG Pocket' },
      cardCount: { official: 226, total: 286 },
      cards: [],
    })
    const set = await fetchSetDetail('en', 'A1')
    expect(isPocketSeries(set.series.tcgdexSeriesId)).toBe(true)
  })
})
