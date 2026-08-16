import { describe, expect, it } from 'vitest'
import * as Money from '../../src/domain/money'
import { hasResolvableValue, resolveMarketValue } from '../../src/domain/market-value'

describe('resolveMarketValue — priority order (§6)', () => {
  it('a manual valuation always wins, even with a fresh snapshot present', () => {
    const result = resolveMarketValue({
      manualValue: Money.fromDecimalString('1200.00', 'NOK'),
      providerSnapshot: { value: Money.fromDecimalString('900.00', 'NOK'), ageDays: 1 },
    })
    expect(result).toEqual({ state: 'manual', value: Money.fromDecimalString('1200.00', 'NOK') })
  })

  it('a snapshot 3 days old or less is fresh', () => {
    const result = resolveMarketValue({
      manualValue: null,
      providerSnapshot: { value: Money.fromDecimalString('340.00', 'NOK'), ageDays: 3 },
    })
    expect(result.state).toBe('fresh')
  })

  it('a snapshot 4-30 days old is stale but still used (worked example E9)', () => {
    const result = resolveMarketValue({
      manualValue: null,
      providerSnapshot: { value: Money.fromDecimalString('340.00', 'NOK'), ageDays: 6 },
    })
    expect(result).toEqual({
      state: 'stale',
      value: Money.fromDecimalString('340.00', 'NOK'),
      ageDays: 6,
    })
    if (hasResolvableValue(result)) {
      expect(Money.toDecimalString(result.value)).toBe('340.00')
    }
  })

  it('a snapshot older than 30 days is missing — the value is never used or zeroed', () => {
    const result = resolveMarketValue({
      manualValue: null,
      providerSnapshot: { value: Money.fromDecimalString('340.00', 'NOK'), ageDays: 31 },
    })
    expect(result).toEqual({ state: 'missing' })
  })

  it('no snapshot at all is missing', () => {
    expect(resolveMarketValue({ manualValue: null, providerSnapshot: null })).toEqual({
      state: 'missing',
    })
  })

  it('a genuine zero-price observation is fresh with value zero — not missing (invariant F14)', () => {
    const result = resolveMarketValue({
      manualValue: null,
      providerSnapshot: { value: Money.fromDecimalString('0.00', 'NOK'), ageDays: 0 },
    })
    expect(result.state).toBe('fresh')
    expect(hasResolvableValue(result)).toBe(true)
    if (hasResolvableValue(result)) {
      expect(Money.isZero(result.value)).toBe(true)
    }
  })
})
