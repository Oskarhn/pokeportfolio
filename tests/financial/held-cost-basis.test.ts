import { describe, expect, it } from 'vitest'
import { heldCostBasisNok } from '../../src/domain/cost-basis'

/**
 * P199: Holding Detail's cost line used `unit_cost_basis_minor` (the lot's ORIGINAL currency) as if it
 * were NOK, summed it over `quantity_remaining` and dropped the lot residual. A 45.00 EUR card bought at
 * 11.54 showed "45,00 NOK"; three lots in three currencies were added together as one number.
 * The cost of the copies still held is the frozen NOK basis: remaining x unit_nok + the lot's residual
 * while any unit is left (FINANCIAL_MODEL.md section 4.3, D-199).
 */
describe('heldCostBasisNok', () => {
  it('uses the frozen NOK basis, not the original-currency amount', () => {
    // 1 x 45.00 EUR at 11.54: original 4500 EUR cents, frozen NOK 51930
    const r = heldCostBasisNok([
      { quantityRemaining: 1, unitCostBasisNokMinor: 51930n, residualNokMinor: 0n },
    ])
    expect(r.totalNokMinor).toBe(51930n)
    expect(r.knownLotCount).toBe(1)
  })

  it('keeps the residual while units remain, so the lot sums to its attributable cost', () => {
    // 3 x 333 + 1 = 1000
    expect(
      heldCostBasisNok([
        { quantityRemaining: 3, unitCostBasisNokMinor: 333n, residualNokMinor: 1n },
      ]).totalNokMinor,
    ).toBe(1000n)
    // one unit sold: the residual stays on the lot until the exhausting sale
    expect(
      heldCostBasisNok([
        { quantityRemaining: 2, unitCostBasisNokMinor: 333n, residualNokMinor: 1n },
      ]).totalNokMinor,
    ).toBe(667n)
  })

  it('counts a lot with no recorded cost as unknown, never as zero', () => {
    const r = heldCostBasisNok([
      { quantityRemaining: 2, unitCostBasisNokMinor: 500n, residualNokMinor: 0n },
      { quantityRemaining: 4, unitCostBasisNokMinor: null, residualNokMinor: 0n },
    ])
    expect(r).toEqual({ totalNokMinor: 1000n, knownLotCount: 1, heldLotCount: 2 })
  })

  it('ignores lots with nothing left and is exact above 2^53', () => {
    const big = 9_007_199_254_740_993n
    const r = heldCostBasisNok([
      { quantityRemaining: 0, unitCostBasisNokMinor: 100n, residualNokMinor: 5n },
      { quantityRemaining: 2, unitCostBasisNokMinor: big, residualNokMinor: 0n },
    ])
    expect(r.totalNokMinor).toBe(big * 2n)
    expect(r.heldLotCount).toBe(1)
  })

  it('no held lots: nothing known, total zero with zero known lots (caller shows "no recorded cost")', () => {
    expect(heldCostBasisNok([])).toEqual({ totalNokMinor: 0n, knownLotCount: 0, heldLotCount: 0 })
  })
})
