/**
 * §4 RESIDUAL ORACLE — pure, runs everywhere, implementation-independent.
 *
 * The residual-consumption rule (FINANCIAL_MODEL §4.3, DATA_MODEL §5.7/§5.6,
 * DECISIONS D-060) is the exactness backbone of opening accounting: the sum of
 * every frozen disposal cost must reproduce a lot's attributable cost EXACTLY,
 * no minor unit lost, none invented, deterministic regardless of how the opens
 * split across time.
 */
import { describe, expect, it } from 'vitest'

import {
  RESIDUAL_ORACLE_CASE,
  expectedFrozenCosts,
  expectedFrozenCostsWithAdjustments,
  unitBasisAndResidual,
} from '../helpers/oracle'

const CASE = RESIDUAL_ORACLE_CASE

describe('residual oracle — the exact hard-coded case', () => {
  it('derives unit 9998 with a +1 residual for 3 units / 29995 øre', () => {
    expect(unitBasisAndResidual(CASE.lot)).toEqual({
      unit: CASE.unitCostBasisNokMinor,
      residual: CASE.residualNokMinor,
    })
  })

  it('open 2 first → 19996; open final 1 → 9999; sum 29995 exactly', () => {
    const frozen = expectedFrozenCosts(CASE.lot, [2, 1])
    expect(frozen[0]).toBe(CASE.openTwoFirst_firstOpeningFrozen)
    expect(frozen[1]).toBe(CASE.openTwoFirst_finalOpeningFrozen)
    expect(frozen[0]! + frozen[1]!).toBe(CASE.combinedTotalNokMinor)
  })

  it('the inverse order (1 then 2) also sums to 29995 — order independence', () => {
    const frozen = expectedFrozenCosts(CASE.lot, [1, 2])
    // Neither partial disposal exhausts until the very last unit: both freeze
    // bare per-unit amounts and the FINAL one carries unit + residual.
    expect(frozen[0]! + frozen[1]!).toBe(CASE.combinedTotalNokMinor)
    expect(frozen[1]).toBe(CASE.unitCostBasisNokMinor * 2 + CASE.residualNokMinor)
  })

  it.each(CASE.rejectedFrozenValues)(
    'rejects the broken-residual value %i for the first (open-2) opening',
    (rejected) => {
      const [firstOpening] = expectedFrozenCosts(CASE.lot, [2, 1])
      expect(firstOpening).not.toBe(rejected)
    },
  )

  it('the residual is consumed EXACTLY once when the lot is exhausted', () => {
    const frozen = expectedFrozenCosts(CASE.lot, [1, 1, 1])
    // Only the exhausting disposal carries unit + residual; every partial one
    // freezes the bare per-unit amount.
    expect(frozen[0]).toBe(CASE.unitCostBasisNokMinor)
    expect(frozen[1]).toBe(CASE.unitCostBasisNokMinor)
    expect(frozen[2]).toBe(CASE.unitCostBasisNokMinor + CASE.residualNokMinor)
    expect(
      frozen.filter((v) => v === CASE.unitCostBasisNokMinor + CASE.residualNokMinor),
    ).toHaveLength(1)
    expect(frozen.reduce((a, b) => a + b, 0)).toBe(CASE.combinedTotalNokMinor)
  })
})

describe('residual oracle — exactness over every split of the awkward lot', () => {
  const lot = CASE.lot

  function compositions(total: number): number[][] {
    if (total === 0) return [[]]
    const results: number[][] = []
    for (let first = 1; first <= total; first++) {
      for (const rest of compositions(total - first)) results.push([first, ...rest])
    }
    return results
  }

  it('every ordered composition of 3 units freezes exactly 29995 in total', () => {
    for (const split of compositions(lot.quantity)) {
      const frozen = expectedFrozenCosts(lot, split)
      const sum = frozen.reduce((a, b) => a + b, 0)
      expect(sum, `split ${split.join('+')}`).toBe(lot.attributableCostNokMinor)
      // No intermediate state may over-consume either.
      let running = 0
      for (const value of frozen) {
        running += value
        expect(running).toBeLessThanOrEqual(lot.attributableCostNokMinor)
      }
    }
  })

  it('every ordered composition of quantities 1..9 sums exactly, for indivisible totals', () => {
    for (const quantity of [1, 2, 4, 5, 7, 8, 9]) {
      for (const total of [
        quantity * 100 + 1,
        quantity * 3333 + quantity - 1,
        quantity * 9999 + 7,
      ]) {
        const testLot = { quantity, attributableCostNokMinor: total }
        for (const split of compositions(quantity)) {
          const sum = expectedFrozenCosts(testLot, split).reduce((a, b) => a + b, 0)
          expect(sum, `qty ${quantity}, cost ${total}, split ${split.join('+')}`).toBe(total)
        }
      }
    }
  })
})

describe('residual oracle — lot_cost_adjustments division (DATA_MODEL §5.6)', () => {
  it('adjustment residual joins the exhausting disposal only', () => {
    // Lot qty 5 @ 1000 each (5000 total), adjustments total 7 → adj_per_unit 1,
    // adj_residual 2. Split disposals 2 + 3: only the second exhausts.
    const frozen = expectedFrozenCostsWithAdjustments(
      { quantity: 5, attributableCostNokMinor: 5000 },
      7,
      [2, 3],
    )
    expect(frozen[0]).toBe((1000 + 1) * 2) // no residual on a partial disposal
    expect(frozen[1]).toBe((1000 + 1) * 3 + 2) // unit+adj residual on exhaustion
    expect(frozen.reduce((a, b) => a + b, 0)).toBe(5000 + 7)
  })

  it('mixed disposal kinds on one lot still reconcile to the full cost', () => {
    // A lot partially sold then partially opened must obey the same rule; the
    // oracle is kind-agnostic by construction (the DB suite asserts the rows).
    const frozen = expectedFrozenCostsWithAdjustments(
      { quantity: 4, attributableCostNokMinor: 13333 },
      10,
      [1, 2, 1],
    )
    expect(frozen.reduce((a, b) => a + b, 0)).toBe(13343)
  })
})

describe('residual oracle — unknown basis stays unknown through any split', () => {
  it('a NULL-basis lot contributes NULL, never zero, to every disposal', () => {
    // Represented here as an explicit refusal: the arithmetic helpers only
    // accept known lots. An unknown-basis lot has NO per-unit figure to floor;
    // the DB suite asserts the stored rows keep cost NULL end-to-end.
    expect(() =>
      expectedFrozenCosts({ quantity: 3, attributableCostNokMinor: Number.NaN }, [1]),
    ).toThrow()
    expect(() => expectedFrozenCosts({ quantity: 0, attributableCostNokMinor: 100 }, [1])).toThrow()
    expect(() =>
      expectedFrozenCosts({ quantity: 3, attributableCostNokMinor: 29995 }, [4]),
    ).toThrow(/over-open/)
  })
})
