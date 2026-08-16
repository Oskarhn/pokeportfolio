/**
 * Worked examples from FINANCIAL_MODEL.md §8, reproduced exactly using the
 * real domain functions — not hand-summed in the test. If a formula changes,
 * the document and this file change together (docs/TESTING.md §2.1).
 *
 * Only E1, E3 and E7 are in scope for M2 (see docs/ROADMAP.md, M2 gate).
 * The remaining worked examples involve openings, trades and provider
 * ingestion, which need infrastructure this milestone deliberately does not
 * build yet; they are exercised once that infrastructure exists.
 */
import { describe, expect, it } from 'vitest'
import * as Money from '../../src/domain/money'
import { allocateMoney } from '../../src/domain/allocation'
import {
  grossPurchaseOutflow,
  collectibleSpend,
  hobbySpend,
  type AttributedPurchaseLine,
} from '../../src/domain/spending'
import { directCostBasisOfInventory, type CostedLot } from '../../src/domain/cost-basis'
import {
  summarizeInventoryValue,
  directCostBasisOfKnownLots,
  unrealizedResultOnCostedInventory,
  type InventoryLot,
} from '../../src/domain/inventory'
import {
  netSalesProceeds,
  realizedResultOnCostedDisposals,
  type SaleLine,
} from '../../src/domain/sales'
import { totalTrackedEconomicPosition } from '../../src/domain/position'
import { resolveMarketValue } from '../../src/domain/market-value'

const nok = (v: string) => Money.fromDecimalString(v, 'NOK')
const dec = (m: Money.Money) => Money.toDecimalString(m)

describe('E1 — direct single purchase', () => {
  const lines: AttributedPurchaseLine[] = [
    { spendClass: 'collectible', attributableCost: nok('500.00') },
  ]

  const lot: InventoryLot = {
    quantityRemaining: 1n,
    costBasisState: { kind: 'known', unitCostBasis: nok('500.00') },
    effectiveUnitCostBasis: nok('500.00'),
    marketValue: resolveMarketValue({
      manualValue: null,
      providerSnapshot: { value: nok('700.00'), ageDays: 0 },
    }),
  }

  it('reproduces every figure in the worked example table', () => {
    const gpo = grossPurchaseOutflow('NOK', lines)
    const cs = collectibleSpend('NOK', lines)
    const hs = hobbySpend('NOK', lines)
    const { cmv, acmv, umv } = summarizeInventoryValue('NOK', [lot])
    const dcb = directCostBasisOfKnownLots('NOK', [lot])
    const urc = unrealizedResultOnCostedInventory(acmv, dcb)
    const nsp = netSalesProceeds('NOK', [])
    const ttep = totalTrackedEconomicPosition(cmv, nsp, cs)

    expect(dec(gpo)).toBe('500.00')
    expect(dec(cs)).toBe('500.00')
    expect(dec(hs)).toBe('0.00')
    expect(dec(cmv)).toBe('700.00')
    expect(dec(acmv)).toBe('700.00')
    expect(dec(umv)).toBe('0.00')
    expect(dec(dcb)).toBe('500.00')
    expect(dec(urc)).toBe('200.00')
    expect(dec(nsp)).toBe('0.00')
    expect(dec(ttep)).toBe('200.00')
    // TTEP = URC when every item is costed and nothing has been sold.
    expect(dec(ttep)).toBe(dec(urc))
  })
})

describe('E3 — mixed receipt with shipping', () => {
  it('allocates shipping pro rata and keeps GPO = CS + HS exact (invariant F1)', () => {
    const lineTotals = [nok('700.00'), nok('500.00'), nok('100.00')] // ETB, card, sleeves
    const shipping = nok('100.00')
    const allocatedShipping = allocateMoney(
      shipping,
      lineTotals.map((l) => l.minorUnits),
    )

    const lines: AttributedPurchaseLine[] = [
      {
        spendClass: 'collectible',
        attributableCost: Money.add(lineTotals[0]!, allocatedShipping[0]!),
      }, // ETB
      {
        spendClass: 'collectible',
        attributableCost: Money.add(lineTotals[1]!, allocatedShipping[1]!),
      }, // card
      { spendClass: 'hobby', attributableCost: Money.add(lineTotals[2]!, allocatedShipping[2]!) }, // sleeves
    ]

    expect(dec(lines[0]!.attributableCost)).toBe('753.85')
    expect(dec(lines[1]!.attributableCost)).toBe('538.46')
    expect(dec(lines[2]!.attributableCost)).toBe('107.69')

    const gpo = grossPurchaseOutflow('NOK', lines)
    const cs = collectibleSpend('NOK', lines)
    const hs = hobbySpend('NOK', lines)

    expect(dec(gpo)).toBe('1400.00')
    expect(dec(cs)).toBe('1292.31')
    expect(dec(hs)).toBe('107.69')
    expect(Money.equals(gpo, Money.add(cs, hs))).toBe(true) // F1
  })
})

describe('E7 — partial sale from a multi-unit lot', () => {
  const lotsBefore: CostedLot[] = [
    { quantityRemaining: 1n, effectiveUnitCostBasis: nok('100.00') }, // L1
    { quantityRemaining: 1n, effectiveUnitCostBasis: nok('150.00') }, // L2
    { quantityRemaining: 1n, effectiveUnitCostBasis: nok('200.00') }, // L3
    { quantityRemaining: 2n, effectiveUnitCostBasis: nok('180.00') }, // L4, qty 2
  ]

  it('DCB before the sale is the sum of every lot', () => {
    expect(dec(directCostBasisOfInventory('NOK', lotsBefore))).toBe('810.00')
  })

  it('reproduces the sale of one unit from L1 and one unit from L4', () => {
    const saleLines: SaleLine[] = [
      { costBasisAtSale: nok('100.00'), allocatedNetProceeds: nok('225.00') }, // L1
      { costBasisAtSale: nok('180.00'), allocatedNetProceeds: nok('225.00') }, // L4
    ]

    const nsp = netSalesProceeds('NOK', saleLines)
    const rrc = realizedResultOnCostedDisposals('NOK', saleLines)

    expect(dec(nsp)).toBe('450.00')
    expect(dec(rrc)).toBe('170.00')

    const lotsAfter: CostedLot[] = [
      { quantityRemaining: 1n, effectiveUnitCostBasis: nok('150.00') }, // L2
      { quantityRemaining: 1n, effectiveUnitCostBasis: nok('200.00') }, // L3
      { quantityRemaining: 1n, effectiveUnitCostBasis: nok('180.00') }, // L4, 1 unit left
    ]
    expect(dec(directCostBasisOfInventory('NOK', lotsAfter))).toBe('530.00')
  })
})
