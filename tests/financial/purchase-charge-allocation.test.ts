import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  allocate,
  allocatePurchaseCharges,
  allocatePurchaseDiscount,
} from '../../src/domain/allocation'
import { AllocationError } from '../../src/domain/errors'

/**
 * P144 / P130-16 (docs/FINANCIAL_MODEL.md §4.1, D-135). A purchase discount that also consumes
 * shipping/customs used to be allocated by goods weight alone, which could push a line's
 * attributable cost negative for a receipt the total check accepts. These tests pin the two-tier
 * rule from three angles: named edge cases (each with its exact expected shares), the legacy formula
 * shown to fail on them, and generated receipts checked against the invariants the rule promises.
 *
 * All arithmetic here is bigint — there are no floats, so "NaN/Infinity" cannot arise; the
 * bounded-domain checks are about staying inside the signed 64-bit range the SQL twin works in.
 */

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n)

/** The pre-P144 discount allocation, kept only to show which receipts it broke. */
function legacyAttributable(
  lineTotals: bigint[],
  shipping: bigint,
  customs: bigint,
  discount: bigint,
): bigint[] {
  const ship = allocate(shipping, lineTotals)
  const cust = allocate(customs, lineTotals)
  const disc = allocate(discount, lineTotals)
  return lineTotals.map((t, i) => t + (ship[i] ?? 0n) + (cust[i] ?? 0n) - (disc[i] ?? 0n))
}

describe('allocatePurchaseCharges — named cases', () => {
  it('the reproduced P130-16 receipt: goods [1,2], shipping 1, customs 1, discount 5 (total 0)', () => {
    // The legacy formula leaves line 0 at 1 + 0 + 0 - 2 = -1.
    expect(legacyAttributable([1n, 2n], 1n, 1n, 5n)).toEqual([-1n, 1n])
    const result = allocatePurchaseCharges([1n, 2n], 1n, 1n, 5n)
    expect(result.discount).toEqual([1n, 4n]) // goods tier [1,2] + charge tier [0,2]
    expect(result.attributable).toEqual([0n, 0n])
  })

  it('all-zero goods: shipping 3 + customs 7 fully discounted (legacy left [1, -1])', () => {
    expect(legacyAttributable([0n, 0n], 3n, 7n, 10n)).toEqual([1n, -1n])
    const result = allocatePurchaseCharges([0n, 0n], 3n, 7n, 10n)
    expect(result.discount).toEqual([6n, 4n])
    expect(result.attributable).toEqual([0n, 0n])
  })

  it('a single line takes the whole discount', () => {
    const result = allocatePurchaseCharges([500n], 100n, 50n, 650n)
    expect(result.discount).toEqual([650n])
    expect(result.attributable).toEqual([0n])
  })

  it('multiple equal lines split evenly, remainder to the lowest index', () => {
    const result = allocatePurchaseCharges([100n, 100n, 100n], 10n, 0n, 100n)
    expect(sum(result.discount)).toBe(100n)
    expect(result.discount).toEqual([34n, 33n, 33n])
  })

  it('uneven lines, discount within the goods: identical to the documented single-tier rule', () => {
    const totals = [700n, 500n, 100n]
    const result = allocatePurchaseCharges(totals, 1000n, 300n, 400n)
    expect(result.discount).toEqual(allocate(400n, totals))
  })

  it('a discount needing remainder-cent distribution keeps every cent', () => {
    // 10 across [7, 11, 13]: exact shares 2.26 / 3.55 / 4.19 floor to 2 / 3 / 4 (sum 9); the one
    // leftover unit goes to the largest remainder (line 1, 0.55).
    const result = allocatePurchaseCharges([7n, 11n, 13n], 0n, 0n, 10n)
    expect(result.discount).toEqual([2n, 4n, 4n])
    expect(sum(result.discount)).toBe(10n)
  })

  it('a zero-value line among priced lines carries no discount and no cost', () => {
    const result = allocatePurchaseCharges([0n, 300n, 700n], 100n, 0n, 1100n)
    expect(result.discount[0]).toBe(0n)
    expect(result.attributable[0]).toBe(0n)
    expect(result.attributable).toEqual([0n, 0n, 0n])
  })

  it('a large discount (whole receipt) drives every line to exactly zero', () => {
    const totals = [12345n, 67890n, 1n, 999n]
    const result = allocatePurchaseCharges(totals, 4321n, 987n, sum(totals) + 4321n + 987n)
    expect(result.attributable).toEqual([0n, 0n, 0n, 0n])
  })

  it('a foreign-currency (zero-exponent JPY) receipt is just integer minor units', () => {
    // 1 JPY = 1 minor unit: goods 3 + 5, shipping 1, discount 9 = whole receipt.
    const result = allocatePurchaseCharges([3n, 5n], 1n, 0n, 9n)
    expect(result.attributable).toEqual([0n, 0n])
    expect(sum(result.discount)).toBe(9n)
  })

  it('no discount changes nothing: attributable = line + shipping + customs', () => {
    const result = allocatePurchaseCharges([100n, 300n], 40n, 20n, 0n)
    expect(result.discount).toEqual([0n, 0n])
    expect(result.attributable).toEqual([115n, 345n])
  })

  it('refuses (never clips) a discount larger than subtotal + shipping + customs', () => {
    expect(() => allocatePurchaseCharges([1n, 2n], 1n, 1n, 6n)).toThrow(AllocationError)
    expect(() => allocatePurchaseCharges([1n, 2n], 1n, 1n, 6n)).toThrow(
      'Discount cannot exceed the purchase subtotal plus shipping and customs',
    )
  })

  it('refuses malformed input with a domain error', () => {
    expect(() => allocatePurchaseDiscount(1n, [], [], [])).toThrow(AllocationError)
    expect(() => allocatePurchaseDiscount(1n, [1n], [0n, 0n], [0n])).toThrow(AllocationError)
    expect(() => allocatePurchaseDiscount(-1n, [1n], [0n], [0n])).toThrow(AllocationError)
    expect(() => allocatePurchaseDiscount(0n, [-1n], [0n], [0n])).toThrow(AllocationError)
  })
})

// A receipt: 1..8 lines, each a mix of zero-priced and priced lines, charges and a discount that is
// anywhere in [0, whole receipt]. Magnitudes reach 2^58 per line so the SQL twin's signed 64-bit
// domain is exercised without overflowing it (8 lines * 2^58 + charges < 2^63).
const lineTotal = fc.oneof(
  fc.constant(0n),
  fc.bigInt({ min: 0n, max: 1_000n }),
  fc.bigInt({ min: 0n, max: 10n ** 12n }),
  fc.bigInt({ min: 0n, max: 2n ** 58n }),
)
const charge = fc.oneof(
  fc.constant(0n),
  fc.bigInt({ min: 0n, max: 1_000n }),
  fc.bigInt({ min: 0n, max: 2n ** 58n }),
)

const receipt = fc
  .record({
    totals: fc.array(lineTotal, { minLength: 1, maxLength: 8 }),
    shipping: charge,
    customs: charge,
    fraction: fc.bigInt({ min: 0n, max: 1_000n }),
    extreme: fc.constantFrom('none', 'all', 'random'),
  })
  .map(({ totals, shipping, customs, fraction, extreme }) => {
    const gross = sum(totals) + shipping + customs
    const discount =
      extreme === 'all' ? gross : extreme === 'none' ? 0n : (gross * fraction) / 1000n
    return { totals, shipping, customs, discount }
  })

describe('allocatePurchaseCharges — properties over generated receipts', () => {
  it('conserves every cent: shipping, customs, discount and the receipt total', () => {
    fc.assert(
      fc.property(receipt, ({ totals, shipping, customs, discount }) => {
        const r = allocatePurchaseCharges(totals, shipping, customs, discount)
        expect(sum(r.shipping)).toBe(shipping)
        expect(sum(r.customs)).toBe(customs)
        expect(sum(r.discount)).toBe(discount)
        expect(sum(r.attributable)).toBe(sum(totals) + shipping + customs - discount)
      }),
      { numRuns: 2000 },
    )
  })

  it('never yields a negative attributable cost or a discount above the line’s gross', () => {
    fc.assert(
      fc.property(receipt, ({ totals, shipping, customs, discount }) => {
        const r = allocatePurchaseCharges(totals, shipping, customs, discount)
        r.attributable.forEach((a, i) => {
          expect(a).toBeGreaterThanOrEqual(0n)
          expect(r.discount[i]).toBeGreaterThanOrEqual(0n)
          expect(r.discount[i]!).toBeLessThanOrEqual(totals[i]! + r.shipping[i]! + r.customs[i]!)
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('is identical to the documented single-tier rule whenever the discount fits inside the goods', () => {
    fc.assert(
      fc.property(
        receipt.filter((r) => r.discount <= sum(r.totals)),
        ({ totals, shipping, customs, discount }) => {
          const r = allocatePurchaseCharges(totals, shipping, customs, discount)
          expect(r.discount).toEqual(allocate(discount, totals))
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('is deterministic: the same receipt always gives the same allocation', () => {
    fc.assert(
      fc.property(receipt, ({ totals, shipping, customs, discount }) => {
        expect(allocatePurchaseCharges(totals, shipping, customs, discount)).toEqual(
          allocatePurchaseCharges([...totals], shipping, customs, discount),
        )
      }),
      { numRuns: 500 },
    )
  })

  it('reordering lines moves shares only by tie-breaking: at most 1 unit per tier per line', () => {
    // Ties in the remainder ranking go to the lowest index, so the ORDER of lines decides who
    // receives a leftover cent among equal remainders — and nothing else. Reversing the receipt
    // must therefore change each line's shipping/customs by at most 1 and its discount by at most 2
    // (one unit per tier), and must leave every total unchanged.
    fc.assert(
      fc.property(receipt, ({ totals, shipping, customs, discount }) => {
        const forward = allocatePurchaseCharges(totals, shipping, customs, discount)
        const reversed = allocatePurchaseCharges([...totals].reverse(), shipping, customs, discount)
        const n = totals.length
        for (let i = 0; i < n; i++) {
          const j = n - 1 - i
          const abs = (x: bigint) => (x < 0n ? -x : x)
          expect(abs(forward.shipping[i]! - reversed.shipping[j]!)).toBeLessThanOrEqual(1n)
          expect(abs(forward.customs[i]! - reversed.customs[j]!)).toBeLessThanOrEqual(1n)
          expect(abs(forward.discount[i]! - reversed.discount[j]!)).toBeLessThanOrEqual(2n)
        }
        expect(sum(reversed.discount)).toBe(sum(forward.discount))
        expect(sum(reversed.attributable)).toBe(sum(forward.attributable))
      }),
      { numRuns: 1000 },
    )
  })

  it('bounds the rounding remainder: each tier is within 1 unit of the exact pro-rata share', () => {
    // For a discount within the goods (single tier), share_i is floor(D*w_i/W) or that plus one.
    fc.assert(
      fc.property(
        receipt.filter((r) => r.discount <= sum(r.totals) && sum(r.totals) > 0n),
        ({ totals, shipping, customs, discount }) => {
          const r = allocatePurchaseCharges(totals, shipping, customs, discount)
          const W = sum(totals)
          r.discount.forEach((share, i) => {
            const floor = (discount * totals[i]!) / W
            expect(share === floor || share === floor + 1n).toBe(true)
          })
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('refuses every discount above the whole receipt and never returns a partial allocation', () => {
    fc.assert(
      fc.property(
        receipt,
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        ({ totals, shipping, customs }, extra) => {
          const gross = sum(totals) + shipping + customs
          expect(() => allocatePurchaseCharges(totals, shipping, customs, gross + extra)).toThrow(
            AllocationError,
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('the legacy formula really did break on receipts this rule accepts (root-cause evidence)', () => {
    let legacyBroke = 0
    fc.assert(
      fc.property(receipt, ({ totals, shipping, customs, discount }) => {
        const legacy = legacyAttributable(totals, shipping, customs, discount)
        if (legacy.some((a) => a < 0n)) legacyBroke++
        // Whatever the legacy formula did, the two-tier rule accepts the receipt.
        expect(() => allocatePurchaseCharges(totals, shipping, customs, discount)).not.toThrow()
      }),
      { numRuns: 2000 },
    )
    expect(legacyBroke).toBeGreaterThan(0)
  })
})
