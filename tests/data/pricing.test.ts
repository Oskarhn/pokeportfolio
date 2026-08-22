import { describe, expect, it } from 'vitest'
import { summarizeCardPricing, type CardPriceCandidate } from '../../src/domain/pricing-summary'

/**
 * M9.1 mandatory search-pricing test coverage (prompt §40-41) — the honest range/from-price matrix
 * a Search result tile renders from a batched search-prices response. Pure and deterministic: no
 * network, no database, matching this project's established `tests/data/` pattern.
 */

function candidate(
  cardId: string,
  priceState: 'available' | 'missing',
  valueNokMinor: number | null,
): CardPriceCandidate {
  return {
    cardId,
    priceState,
    valueNokMinor: valueNokMinor === null ? null : BigInt(valueNokMinor),
  }
}

describe('summarizeCardPricing', () => {
  it('one priced variant on a single-variant card: exact single value', () => {
    const summary = summarizeCardPricing([candidate('card-1', 'available', 15000)])
    expect(summary.get('card-1')).toEqual({
      variantCount: 1,
      pricedCount: 1,
      minValueNokMinor: 15000n,
      maxValueNokMinor: 15000n,
    })
  })

  it('several priced variants, full coverage: exact min/max range', () => {
    const summary = summarizeCardPricing([
      candidate('card-2', 'available', 12000),
      candidate('card-2', 'available', 22000),
      candidate('card-2', 'available', 17000),
    ])
    expect(summary.get('card-2')).toEqual({
      variantCount: 3,
      pricedCount: 3,
      minValueNokMinor: 12000n,
      maxValueNokMinor: 22000n,
    })
  })

  it('partial coverage: pricedCount is strictly less than variantCount', () => {
    const summary = summarizeCardPricing([
      candidate('card-3', 'available', 9000),
      candidate('card-3', 'missing', null),
      candidate('card-3', 'missing', null),
    ])
    expect(summary.get('card-3')).toEqual({
      variantCount: 3,
      pricedCount: 1,
      minValueNokMinor: 9000n,
      maxValueNokMinor: 9000n,
    })
  })

  it('all variants missing: pricedCount 0, no fabricated range', () => {
    const summary = summarizeCardPricing([
      candidate('card-4', 'missing', null),
      candidate('card-4', 'missing', null),
    ])
    expect(summary.get('card-4')).toEqual({
      variantCount: 2,
      pricedCount: 0,
      minValueNokMinor: null,
      maxValueNokMinor: null,
    })
  })

  it('a genuine zero price counts as priced, distinct from missing (F14)', () => {
    const summary = summarizeCardPricing([candidate('card-5', 'available', 0)])
    const s = summary.get('card-5')
    expect(s?.pricedCount).toBe(1)
    expect(s?.minValueNokMinor).toBe(0n)
    expect(s?.maxValueNokMinor).toBe(0n)
  })

  it('an ambiguous variant (available state but no resolvable NOK value) counts as unpriced', () => {
    // search-prices returns priceState:'available' with valueNokMinor:null only when no FX rate
    // is cached yet — summarizeCardPricing must treat that the same as missing, never as a priced
    // variant with an absent number.
    const summary = summarizeCardPricing([
      { cardId: 'card-6', priceState: 'available', valueNokMinor: null },
    ])
    expect(summary.get('card-6')).toEqual({
      variantCount: 1,
      pricedCount: 0,
      minValueNokMinor: null,
      maxValueNokMinor: null,
    })
  })

  it('a provider failure for one card never affects another card in the same batch', () => {
    // Simulates: card-7's provider fetch failed (no candidate rows for it at all — it is simply
    // absent from the batch results), card-8's succeeded normally.
    const summary = summarizeCardPricing([candidate('card-8', 'available', 5000)])
    expect(summary.has('card-7')).toBe(false)
    expect(summary.get('card-8')?.pricedCount).toBe(1)
  })

  it('multiple cards in one batch are grouped independently', () => {
    const summary = summarizeCardPricing([
      candidate('card-a', 'available', 1000),
      candidate('card-b', 'available', 2000),
      candidate('card-a', 'missing', null),
    ])
    expect(summary.get('card-a')).toEqual({
      variantCount: 2,
      pricedCount: 1,
      minValueNokMinor: 1000n,
      maxValueNokMinor: 1000n,
    })
    expect(summary.get('card-b')).toEqual({
      variantCount: 1,
      pricedCount: 1,
      minValueNokMinor: 2000n,
      maxValueNokMinor: 2000n,
    })
  })
})
