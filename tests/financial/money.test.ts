import { describe, expect, it } from 'vitest'
import * as Money from '../../src/domain/money'
import { CurrencyMismatchError, InvalidMoneyInputError } from '../../src/domain/errors'

describe('Money — creation boundaries', () => {
  it('parses a plain decimal string into exact minor units', () => {
    expect(Money.fromDecimalString('699.00', 'NOK')).toEqual({
      minorUnits: 69900n,
      currency: 'NOK',
    })
  })

  it('parses a negative decimal string', () => {
    expect(Money.fromDecimalString('-45.50', 'EUR')).toEqual({
      minorUnits: -4550n,
      currency: 'EUR',
    })
  })

  it('zero-pads a short fractional part', () => {
    expect(Money.fromDecimalString('5', 'NOK')).toEqual({ minorUnits: 500n, currency: 'NOK' })
    expect(Money.fromDecimalString('5.5', 'NOK')).toEqual({ minorUnits: 550n, currency: 'NOK' })
  })

  it('rejects more precision than the currency supports, rather than truncating', () => {
    expect(() => Money.fromDecimalString('5.001', 'NOK')).toThrow(InvalidMoneyInputError)
  })

  it('rejects a malformed decimal string', () => {
    expect(() => Money.fromDecimalString('not-a-number', 'NOK')).toThrow(InvalidMoneyInputError)
  })

  it('accepts a safe-integer count of minor units', () => {
    expect(Money.fromSafeIntegerMinorUnits(69900, 'NOK')).toEqual({
      minorUnits: 69900n,
      currency: 'NOK',
    })
  })

  it('rejects an unsafe integer', () => {
    expect(() => Money.fromSafeIntegerMinorUnits(Number.MAX_SAFE_INTEGER + 1, 'NOK')).toThrow(
      InvalidMoneyInputError,
    )
  })
})

describe('Money — arithmetic', () => {
  it('adds amounts in the same currency', () => {
    const a = Money.fromDecimalString('5.00', 'NOK')
    const b = Money.fromDecimalString('2.50', 'NOK')
    expect(Money.toDecimalString(Money.add(a, b))).toBe('7.50')
  })

  it('rejects addition across currencies', () => {
    const nok = Money.fromDecimalString('5.00', 'NOK')
    const eur = Money.fromDecimalString('5.00', 'EUR')
    expect(() => Money.add(nok, eur)).toThrow(CurrencyMismatchError)
  })

  it('rejects subtraction across currencies', () => {
    const nok = Money.fromDecimalString('5.00', 'NOK')
    const eur = Money.fromDecimalString('5.00', 'EUR')
    expect(() => Money.subtract(nok, eur)).toThrow(CurrencyMismatchError)
  })

  it('rejects comparison across currencies', () => {
    const nok = Money.fromDecimalString('5.00', 'NOK')
    const eur = Money.fromDecimalString('5.00', 'EUR')
    expect(() => Money.compare(nok, eur)).toThrow(CurrencyMismatchError)
  })

  it('sums a list of amounts, defaulting to zero', () => {
    const amounts = ['1.00', '2.00', '3.00'].map((v) => Money.fromDecimalString(v, 'NOK'))
    expect(Money.toDecimalString(Money.sum('NOK', amounts))).toBe('6.00')
    expect(Money.toDecimalString(Money.sum('NOK', []))).toBe('0.00')
  })

  it('multiplies by an exact integer quantity', () => {
    const unit = Money.fromDecimalString('3.33', 'NOK')
    expect(Money.toDecimalString(Money.multiplyByQuantity(unit, 3n))).toBe('9.99')
  })

  it('negate, isZero, isNegative', () => {
    const five = Money.fromDecimalString('5.00', 'NOK')
    expect(Money.isNegative(Money.negate(five))).toBe(true)
    expect(Money.isZero(Money.subtract(five, five))).toBe(true)
  })

  it('compares amounts in the same currency', () => {
    const a = Money.fromDecimalString('5.00', 'NOK')
    const b = Money.fromDecimalString('7.00', 'NOK')
    expect(Money.compare(a, b)).toBe(-1)
    expect(Money.compare(b, a)).toBe(1)
    expect(Money.compare(a, a)).toBe(0)
  })
})

describe('Money — formatting is separate from arithmetic', () => {
  it('round-trips through decimal string parsing and formatting', () => {
    for (const value of ['0.00', '699.00', '-45.50', '123456789.99']) {
      expect(Money.toDecimalString(Money.fromDecimalString(value, 'NOK'))).toBe(value)
    }
  })
})
