import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))
const { lotUnitCostLabel } = await import('../../src/features/collection/lot-cost')

describe('lotUnitCostLabel names the currency the amount is in', () => {
  it('NOK lot', () => {
    expect(
      lotUnitCostLabel({
        costBasisCurrency: 'NOK',
        unitCostBasisMinor: 1250n,
        unitCostBasisNokMinor: 1250n,
      }),
    ).toBe('12,50 NOK / card')
  })

  it('EUR lot shows EUR and the frozen NOK conversion, never EUR cents as NOK', () => {
    const label = lotUnitCostLabel({
      costBasisCurrency: 'EUR',
      unitCostBasisMinor: 4500n,
      unitCostBasisNokMinor: 51930n,
    })
    expect(label).toContain('45.00 EUR')
    expect(label).toContain('519,30 NOK')
    expect(label).not.toBe('45,00 NOK / card')
  })

  it('JPY lot (no minor unit) is not divided by 100', () => {
    const label = lotUnitCostLabel({
      costBasisCurrency: 'JPY',
      unitCostBasisMinor: 10000n,
      unitCostBasisNokMinor: 60375n,
    })
    expect(label).toContain('10000 JPY')
    expect(label).toContain('603,75 NOK')
  })

  it('no recorded amount: null, so the caller prints the state text', () => {
    expect(
      lotUnitCostLabel({
        costBasisCurrency: null,
        unitCostBasisMinor: null,
        unitCostBasisNokMinor: null,
      }),
    ).toBeNull()
  })
})
