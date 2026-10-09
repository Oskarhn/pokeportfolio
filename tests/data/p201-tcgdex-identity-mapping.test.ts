import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCardPricing, normalizeProviderInstant } from '../../supabase/functions/_shared/tcgdex'

/**
 * P201 — dangerous price-to-variant mapping cases. Fixtures are CONSTRUCTED (labelled as such): they
 * reproduce real-shaped payload combinations the dated live probes in docs/RESEARCH.md did not
 * happen to capture, each one a way a wrong printing's price could have reached a holding.
 */

function mockCard(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const STAMP_1ST = ['1st-edition']

function tcgplayer(buckets: Record<string, number | null>, extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {
    unit: 'USD',
    updated: '2026-10-08T10:00:00.000Z',
    ...extra,
  }
  for (const [key, market] of Object.entries(buckets)) {
    out[key] = { productId: 1, marketPrice: market }
  }
  return out
}

describe('1st-edition and unlimited TCGplayer buckets never cross editions (constructed)', () => {
  it('does not give a first-edition price to a holo variant without the first-edition stamp', async () => {
    mockCard({
      id: 'x-1',
      variants_detailed: [{ type: 'holo', size: 'standard' }],
      pricing: { tcgplayer: tcgplayer({ '1st-edition-holofoil': 900 }) },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants).toHaveLength(1)
    expect(variants[0]!.tcgplayer).toBeNull()
  })

  it('does not give an unstamped holo price to a first-edition variant', async () => {
    mockCard({
      id: 'x-1',
      variants_detailed: [{ type: 'holo', size: 'standard', stamp: STAMP_1ST }],
      pricing: { tcgplayer: tcgplayer({ holofoil: 40 }) },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.tcgplayer).toBeNull()
  })

  it('maps each edition to its own bucket when both variants and both buckets exist', async () => {
    mockCard({
      id: 'x-1',
      variants_detailed: [
        { type: 'holo', size: 'standard' },
        { type: 'holo', size: 'standard', stamp: STAMP_1ST },
      ],
      pricing: { tcgplayer: tcgplayer({ holofoil: 40, '1st-edition-holofoil': 900 }) },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    const plain = variants.find((v) => v.stamp === '')!
    const first = variants.find((v) => v.stamp === '1st-edition')!
    expect(plain.tcgplayer!.valueMinor).toBe(4000n)
    expect(first.tcgplayer!.valueMinor).toBe(90000n)
  })

  it('maps the non-holo "1st-edition" bucket to a normal first-edition variant only', async () => {
    mockCard({
      id: 'x-1',
      variants_detailed: [{ type: 'normal', size: 'standard', stamp: STAMP_1ST }],
      pricing: { tcgplayer: tcgplayer({ '1st-edition': 12 }) },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.tcgplayer!.valueMinor).toBe(1200n)
  })

  it('treats two holo products on one embedded variant as ambiguous, not as "the first one"', async () => {
    mockCard({
      id: 'x-1',
      variants_detailed: [
        {
          type: 'holo',
          size: 'standard',
          pricing: {
            tcgplayer: tcgplayer({ holofoil: 40, 'unlimited-holofoil': 55 }),
          },
        },
      ],
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.tcgplayer).toBeNull()
  })

  it('still prices an embedded variant that has exactly one matching bucket', async () => {
    mockCard({
      id: 'x-1',
      variants_detailed: [
        {
          type: 'holo',
          size: 'standard',
          pricing: { tcgplayer: tcgplayer({ holofoil: 40, normal: 1 }) },
        },
      ],
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.tcgplayer!.valueMinor).toBe(4000n)
  })
})

describe('a number that cannot be a price is absent (constructed)', () => {
  it('drops a negative Cardmarket and TCGplayer value instead of passing it to the database', async () => {
    mockCard({
      id: 'x-1',
      variants: { normal: true },
      pricing: {
        cardmarket: { updated: '2026-10-08T10:00:00.000Z', trend: -3, avg30: null },
        tcgplayer: tcgplayer({ normal: -0.5 }),
      },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.cardmarket).toBeNull()
    expect(variants[0]!.tcgplayer).toBeNull()
  })

  it('falls through a negative trend to the next honest field of the chain', async () => {
    mockCard({
      id: 'x-1',
      variants: { normal: true },
      pricing: { cardmarket: { updated: '2026-10-08T10:00:00.000Z', trend: -3, avg30: 2.5 } },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.cardmarket).toMatchObject({ priceKind: 'cm_avg30', valueMinor: 250n })
  })

  it('keeps a genuine zero', async () => {
    mockCard({
      id: 'x-1',
      variants: { normal: true },
      pricing: { cardmarket: { updated: '2026-10-08T10:00:00.000Z', trend: 0 } },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.cardmarket).toMatchObject({ priceKind: 'cm_trend', valueMinor: 0n })
  })

  it('refuses a price whose record names another currency than the provider is mapped to', async () => {
    mockCard({
      id: 'x-1',
      variants: { normal: true },
      pricing: {
        cardmarket: { updated: '2026-10-08T10:00:00.000Z', unit: 'GBP', trend: 5 },
        tcgplayer: tcgplayer({ normal: 5 }, { unit: 'EUR' }),
      },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.cardmarket).toBeNull()
    expect(variants[0]!.tcgplayer).toBeNull()
  })

  it('accepts the expected unit in any case and a record without a unit', async () => {
    mockCard({
      id: 'x-1',
      variants: { normal: true },
      pricing: {
        cardmarket: { updated: '2026-10-08T10:00:00.000Z', unit: 'eur', trend: 5 },
        tcgplayer: tcgplayer({ normal: 7 }, { unit: undefined }),
      },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.cardmarket!.valueMinor).toBe(500n)
    expect(variants[0]!.tcgplayer!.valueMinor).toBe(700n)
  })
})

describe('provider timestamps that would break or poison the write (constructed)', () => {
  const NOW = Date.parse('2026-10-09T12:00:00.000Z')

  it.each([
    ['a non-existent calendar day that Date.parse silently rolls over', '2026-02-31T00:00:00.000Z'],
    ['free text', 'yesterday'],
    ['a month 13', '2026-13-01'],
    ['a far-future instant that would pin the variant "fresh" forever', '2099-01-01T00:00:00.000Z'],
    ['an empty string', ''],
    ['a number', 20261008],
  ])('rejects %s', (_label, value) => {
    expect(normalizeProviderInstant(value, NOW)).toBeNull()
  })

  it.each([
    '2026-10-08T10:00:00.000Z',
    '2026-10-08',
    '2026-10-08T10:00:00Z',
    '2026-10-08T10:00:00+02:00',
    '2026-10-10T11:00:00.000Z', // a few hours ahead of now: clock skew, tolerated
  ])('accepts %s', (value) => {
    expect(normalizeProviderInstant(value, NOW)).toBe(value)
  })

  it('treats a malformed provider timestamp as unknown, keeping the (valid) price', async () => {
    mockCard({
      id: 'x-1',
      variants: { normal: true },
      pricing: { cardmarket: { updated: '2026-02-31T00:00:00.000Z', trend: 5 } },
    })
    const { variants } = await fetchCardPricing('en', 'x-1')
    expect(variants[0]!.cardmarket).toMatchObject({ valueMinor: 500n, providerUpdatedAt: null })
  })
})
