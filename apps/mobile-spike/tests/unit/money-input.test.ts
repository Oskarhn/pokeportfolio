import { InvalidMoneyInputError } from '@shared/domain/errors'
import {
  parseNullableMoneyInput,
  parseOptionalChargeInput,
  requireKnownAmount,
} from '../../src/write/money-input'

/**
 * P175's native money-input boundary. Mirrors the mutation campaign's money-input assertions
 * (mutations #1, #7, #10 in output_175.txt): blank never becomes 0, unknown cost stays unknown,
 * clearing a manual valuation is never the same request as setting it to zero.
 */
describe('parseNullableMoneyInput', () => {
  it('blank and whitespace-only input is null, never 0n', () => {
    expect(parseNullableMoneyInput('', 'NOK')).toBeNull()
    expect(parseNullableMoneyInput('   ', 'NOK')).toBeNull()
    expect(parseNullableMoneyInput('\t\n', 'NOK')).toBeNull()
  })

  it('an explicit zero is a known 0n, not null', () => {
    expect(parseNullableMoneyInput('0', 'NOK')).toBe(0n)
    expect(parseNullableMoneyInput('0.00', 'NOK')).toBe(0n)
  })

  it('accepts both comma and dot as the decimal separator', () => {
    expect(parseNullableMoneyInput('100,50', 'NOK')).toBe(10050n)
    expect(parseNullableMoneyInput('100.50', 'NOK')).toBe(10050n)
  })

  it('JPY has no fractional minor units', () => {
    expect(parseNullableMoneyInput('1500', 'JPY')).toBe(1500n)
    expect(() => parseNullableMoneyInput('1500.5', 'JPY')).toThrow()
  })

  it('is exact above Number.MAX_SAFE_INTEGER (no Number() in the path)', () => {
    // 2^53 + 1 = 9007199254740993, in kroner with 2 decimals.
    const parsed = parseNullableMoneyInput('90071992547409.93', 'NOK')
    expect(parsed).toBe(9007199254740993n)
    expect(typeof parsed).toBe('bigint')
  })

  it('rejects surplus fractional digits rather than rounding them away', () => {
    expect(() => parseNullableMoneyInput('1.005', 'NOK')).toThrow()
  })
})

describe('requireKnownAmount', () => {
  it('refuses blank with the given message', () => {
    expect(() => requireKnownAmount('', 'NOK', 'Enter a price')).toThrow(InvalidMoneyInputError)
    expect(() => requireKnownAmount('', 'NOK', 'Enter a price')).toThrow('Enter a price')
  })

  it('accepts an explicit zero as known', () => {
    expect(requireKnownAmount('0', 'NOK', 'Enter a price')).toBe(0n)
  })
})

describe('parseOptionalChargeInput', () => {
  it('blank becomes 0n by name (the only parser that does this)', () => {
    expect(parseOptionalChargeInput('', 'NOK')).toBe(0n)
  })

  it('an explicit amount still parses exactly', () => {
    expect(parseOptionalChargeInput('12.34', 'NOK')).toBe(1234n)
  })
})
