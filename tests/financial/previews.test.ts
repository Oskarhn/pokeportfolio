import { describe, expect, it } from 'vitest'
import { previewPurchase } from '../../src/domain/allocation'
import { previewSale } from '../../src/domain/sales'
import { valueChange } from '../../src/domain/dashboard'

/**
 * P209 (F): the form previews are pure domain functions. The worked examples are the ones the
 * model documents (FINANCIAL_MODEL.md E-series), so a component can only ever format them.
 * tests/db/p209_preview_parity.test.ts proves the same functions equal the stored rows.
 */

describe('previewSale', () => {
  it('220 gross, 20 fee, no shipping: net 200 (model example)', () => {
    const p = previewSale({
      lines: [{ unitGrossMinor: 220n, quantity: 1 }],
      feesMinor: 20n,
      shippingCostMinor: 0n,
      shippingChargedMinor: 0n,
    })
    expect(p.grossMinor).toBe(220n)
    expect(p.netMinor).toBe(200n)
    expect(p.lineNet).toEqual([200n])
    expect(p.feesDeductionMinor).toBe(-20n)
  })

  it('charges are allocated by line gross with the largest remainder: line nets sum to the net', () => {
    const p = previewSale({
      lines: [
        { unitGrossMinor: 100n, quantity: 1 },
        { unitGrossMinor: 100n, quantity: 2 },
      ],
      feesMinor: 10n, // 300 gross: 3.33 / 6.67 -> 3 and 7
      shippingCostMinor: 5n,
      shippingChargedMinor: 2n,
    })
    expect(p.netMinor).toBe(300n - 10n - 5n + 2n)
    expect(p.lineNet.reduce((a, b) => a + b, 0n)).toBe(p.netMinor)
  })

  it('a negative net is a number, never clamped', () => {
    const p = previewSale({
      lines: [{ unitGrossMinor: 0n, quantity: 1 }],
      feesMinor: 5n,
      shippingCostMinor: 0n,
      shippingChargedMinor: 0n,
    })
    expect(p.netMinor).toBe(-5n)
  })

  it('keeps exactness past 2^53', () => {
    const big = 9_007_199_254_740_993n
    const p = previewSale({
      lines: [{ unitGrossMinor: big, quantity: 3 }],
      feesMinor: 1n,
      shippingCostMinor: 0n,
      shippingChargedMinor: 0n,
    })
    expect(p.netMinor).toBe(big * 3n - 1n)
  })
})

describe('previewPurchase', () => {
  it('3 x 333 + 1 shipping: the single line carries the whole shipping and the total is exact', () => {
    const p = previewPurchase({
      lines: [{ unitPriceMinor: 333n, quantity: 3 }],
      shippingMinor: 1n,
      customsMinor: 0n,
      discountMinor: 0n,
    })
    expect(p.attributable).toEqual([1000n])
    expect(p.totalMinor).toBe(1000n)
  })

  it('shipping, customs and discount allocate so the attributable costs sum to the total', () => {
    const p = previewPurchase({
      lines: [
        { unitPriceMinor: 700n, quantity: 1 },
        { unitPriceMinor: 300n, quantity: 2 },
        { unitPriceMinor: 1n, quantity: 1 },
      ],
      shippingMinor: 99n,
      customsMinor: 17n,
      discountMinor: 250n,
    })
    expect(p.attributable.reduce((a, b) => a + b, 0n)).toBe(p.totalMinor)
    expect(p.totalMinor).toBe(1301n + 99n + 17n - 250n)
  })

  it('refuses a discount larger than the whole receipt', () => {
    expect(() =>
      previewPurchase({
        lines: [{ unitPriceMinor: 100n, quantity: 1 }],
        shippingMinor: 0n,
        customsMinor: 0n,
        discountMinor: 101n,
      }),
    ).toThrow()
  })
})

describe('valueChange', () => {
  it('is an exact bigint difference with a display percentage', () => {
    expect(valueChange(10_000n, 12_500n)).toEqual({ changeMinor: 2_500n, pct: 25 })
    expect(valueChange(12_500n, 10_000n).changeMinor).toBe(-2_500n)
  })

  it('a zero base has no percentage (never 0% or infinity)', () => {
    expect(valueChange(0n, 500n)).toEqual({ changeMinor: 500n, pct: null })
  })

  it('keeps the difference exact beyond 2^53', () => {
    const base = 9_007_199_254_740_993n
    expect(valueChange(base, base + 7n).changeMinor).toBe(7n)
  })
})
