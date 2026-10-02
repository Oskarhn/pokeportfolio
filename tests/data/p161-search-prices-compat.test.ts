import { describe, expect, it, vi } from 'vitest'

/**
 * P161 — deployment-order compatibility of the `search-prices` response.
 *
 * P153 made ONE additive change: each result row gains `observations[]`. Deploy order and rollback
 * are only safe if BOTH skew directions hold, so both are pinned here against the real consumers:
 *
 *   old client  + NEW function  → the existing `searchPrices` consumer ignores the new field
 *   NEW client  + OLD function  → Price Check falls back to the single headline value and says so
 *                                 (also covered in tests/domain/price-check/raw-observations.test.ts)
 */

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../src/data/supabase-client', () => ({
  supabase: { functions: { invoke } },
}))

import { searchPrices } from '../../src/data/pricing'
import { fetchCardPriceResponse } from '../../src/data/price-check'
import { buildRawSection } from '../../src/domain/price-check/raw-section'
import type { VariantIdentity } from '../../src/domain/price-check/types'

const VARIANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const HEADLINE = {
  cardVariantId: VARIANT,
  cardId: CARD,
  priceState: 'available',
  provider: 'tcgdex_cardmarket',
  priceKind: 'cm_trend',
  sourceCurrency: 'EUR',
  sourceValueMinor: 1234,
  valueNokMinor: '14240',
  providerUpdatedAt: '2026-09-20T00:00:00Z',
}

describe('old client + new function (extra `observations` field)', () => {
  it('the existing searchPrices consumer returns exactly what it returned before', async () => {
    invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        providerErrorCount: 0,
        results: [
          {
            ...HEADLINE,
            observations: [
              {
                provider: 'tcgdex_cardmarket',
                priceKind: 'cm_trend',
                sourceCurrency: 'EUR',
                valueMinor: '1234',
                providerUpdatedAt: '2026-09-20T00:00:00Z',
              },
              {
                provider: 'tcgdex_tcgplayer',
                priceKind: 'tp_market',
                sourceCurrency: 'USD',
                valueMinor: '999',
                providerUpdatedAt: null,
              },
            ],
          },
        ],
      },
      error: null,
    })
    const map = await searchPrices([CARD], true)
    expect([...map.values()]).toEqual([
      {
        cardVariantId: VARIANT,
        cardId: CARD,
        priceState: 'available',
        provider: 'tcgdex_cardmarket',
        sourceCurrency: 'EUR',
        sourceValueMinor: 1234n,
        valueNokMinor: 14240n,
        providerUpdatedAt: '2026-09-20T00:00:00Z',
      },
    ])
  })
})

describe('new client + old function (no `observations` field)', () => {
  const variant: VariantIdentity = {
    variantId: VARIANT,
    finish: 'normal',
    stamp: '',
    subtype: '',
    size: 'standard',
    isActive: true,
  }

  it('Price Check shows the single headline value, marks the response partial, and invents nothing', async () => {
    invoke.mockResolvedValueOnce({
      data: { ok: true, providerErrorCount: 0, results: [HEADLINE] },
      error: null,
    })
    const response = await fetchCardPriceResponse(CARD, { invoke })
    const { section, headlineOnly } = buildRawSection(response, variant)
    expect(section.observations).toHaveLength(1)
    expect(section.observations[0]).toMatchObject({
      provider: 'tcgdex_cardmarket',
      price: { minorUnits: 1234n, currency: 'EUR' },
    })
    // Only ONE provider is visible: the section must not claim to be the complete picture.
    expect(headlineOnly).toBe(true)
  })

  it('an old function that reports a missing price stays "no price", never zero', async () => {
    invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        providerErrorCount: 0,
        results: [
          {
            ...HEADLINE,
            priceState: 'missing',
            provider: null,
            priceKind: null,
            sourceCurrency: null,
            sourceValueMinor: null,
            valueNokMinor: null,
            providerUpdatedAt: null,
          },
        ],
      },
      error: null,
    })
    const response = await fetchCardPriceResponse(CARD, { invoke })
    const { section } = buildRawSection(response, variant)
    expect(section.observations).toEqual([])
    expect(section).toMatchObject({ status: 'unavailable', unavailable: 'no_variant_price' })
  })
})
