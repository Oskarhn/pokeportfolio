import { describe, expect, it } from 'vitest'
import * as Money from '../../src/domain/money'
import { convert } from '../../src/domain/fx'

describe('fx.convert — worked example E10', () => {
  it('converts a EUR purchase total to NOK at the rate for that date', () => {
    // 45.00 EUR card + 4.50 EUR shipping = 49.50 EUR, rate 11.54000000.
    const totalEur = Money.fromDecimalString('49.50', 'EUR')
    const nok = convert(totalEur, '11.54000000', 'NOK')
    expect(Money.toDecimalString(nok)).toBe('571.23')
  })

  it('is a pure computation — the same inputs always produce the same output', () => {
    const amount = Money.fromDecimalString('100.00', 'EUR')
    const first = convert(amount, '9.87654321', 'NOK')
    const second = convert(amount, '9.87654321', 'NOK')
    expect(Money.equals(first, second)).toBe(true)
  })

  it('rounds half-up to the target minor unit', () => {
    // 1 EUR at rate 1.005 -> 1.005 NOK, half-up to 1.01.
    const amount = Money.fromDecimalString('1.00', 'EUR')
    const nok = convert(amount, '1.00500000', 'NOK')
    expect(Money.toDecimalString(nok)).toBe('1.01')
  })
})
