import { describe, expect, it } from 'vitest'
import * as Money from '../../src/domain/money'
import { effectiveUnitCostBasis, isKnown, type CostBasisState } from '../../src/domain/cost-basis'

describe('CostBasisState — invariant M2', () => {
  it('every non-known state carries no amount at all (enforced by the type, not a nullable field)', () => {
    const states: CostBasisState[] = [
      { kind: 'unallocated_opening' },
      { kind: 'not_paid' },
      { kind: 'unknown' },
      { kind: 'trade_in' },
    ]
    for (const state of states) {
      expect(isKnown(state)).toBe(false)
      expect(effectiveUnitCostBasis(state, [], 1n)).toBeNull()
    }
  })

  it('a known state carries an amount and nothing else', () => {
    const state: CostBasisState = {
      kind: 'known',
      unitCostBasis: Money.fromDecimalString('500.00', 'NOK'),
    }
    expect(isKnown(state)).toBe(true)
    expect(Money.toDecimalString(effectiveUnitCostBasis(state, [], 1n)!)).toBe('500.00')
  })
})

describe('effectiveUnitCostBasis — worked example E6 (grading)', () => {
  it('adds lot cost adjustments per unit, on top of the direct cost basis', () => {
    const state: CostBasisState = {
      kind: 'known',
      unitCostBasis: Money.fromDecimalString('500.00', 'NOK'),
    }
    const adjustments = [
      { kind: 'grading_fee' as const, amount: Money.fromDecimalString('400.00', 'NOK') },
      { kind: 'grading_shipping' as const, amount: Money.fromDecimalString('150.00', 'NOK') },
    ]
    const eucb = effectiveUnitCostBasis(state, adjustments, 1n)
    expect(Money.toDecimalString(eucb!)).toBe('1050.00')
  })

  it('an opening-origin lot never gains a cost basis from an adjustment', () => {
    const state: CostBasisState = { kind: 'unallocated_opening' }
    const adjustments = [
      { kind: 'grading_fee' as const, amount: Money.fromDecimalString('400.00', 'NOK') },
    ]
    expect(effectiveUnitCostBasis(state, adjustments, 1n)).toBeNull()
  })
})
