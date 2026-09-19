import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  parseNokInput,
  parseNullableMoneyInput,
  parseOptionalChargeInput,
  requireKnownAmount,
} from '../../src/ui/money-format'
import { fromMinorUnits, toDecimalString } from '../../src/domain/money'
import { InvalidMoneyInputError } from '../../src/domain/errors'
import type { CurrencyCode } from '../../src/domain/currency'

/**
 * P144 / P130-25 (docs/FINANCIAL_MODEL.md §1.1, D-135). A blank money field and a typed zero are
 * different financial facts: blank is "no amount entered" (unknown), "0" is a real known zero. The
 * shared parser must therefore answer `null` — never `0n` — for anything that is not a number, and
 * the forms decide deliberately what an absent amount means for their own field.
 */

const CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

describe('parseNullableMoneyInput — blank is unknown, zero is known', () => {
  it.each(['', ' ', '   ', '\t', '\n', ' \t\n ', '\u00a0', '\u202f', '\u00a0\u00a0'])(
    'a blank / whitespace-only input %j is null, never 0n',
    (raw) => {
      for (const currency of CURRENCIES) {
        expect(parseNullableMoneyInput(raw, currency)).toBeNull()
      }
    },
  )

  it('an explicit "0" is a known zero', () => {
    for (const currency of CURRENCIES) {
      expect(parseNullableMoneyInput('0', currency)).toBe(0n)
      expect(parseNullableMoneyInput(' 0 ', currency)).toBe(0n)
    }
  })

  it('"0.00" and "0,00" are a known zero for every exponent-2 currency', () => {
    for (const currency of ['NOK', 'EUR', 'USD', 'GBP'] as const) {
      expect(parseNullableMoneyInput('0.00', currency)).toBe(0n)
      expect(parseNullableMoneyInput('0,00', currency)).toBe(0n)
      expect(parseNullableMoneyInput('0.0', currency)).toBe(0n)
    }
  })

  it('a positive amount parses to the exact minor units, with either separator', () => {
    expect(parseNullableMoneyInput('12,50', 'NOK')).toBe(1250n)
    expect(parseNullableMoneyInput('12.50', 'EUR')).toBe(1250n)
    expect(parseNullableMoneyInput('12.5', 'USD')).toBe(1250n)
    expect(parseNullableMoneyInput('699', 'GBP')).toBe(69900n)
    expect(parseNullableMoneyInput('  0,05  ', 'NOK')).toBe(5n)
  })

  it('JPY (exponent 0): blank is null, "0" is known zero, whole yen are exact minor units', () => {
    expect(parseNullableMoneyInput('', 'JPY')).toBeNull()
    expect(parseNullableMoneyInput('   ', 'JPY')).toBeNull()
    expect(parseNullableMoneyInput('0', 'JPY')).toBe(0n)
    expect(parseNullableMoneyInput('1500', 'JPY')).toBe(1500n)
    // No fractional yen exists: surplus digits are refused, never rounded away.
    expect(() => parseNullableMoneyInput('1500.5', 'JPY')).toThrow()
  })

  it('refuses surplus fractional digits and malformed text instead of guessing', () => {
    expect(() => parseNullableMoneyInput('1.234', 'NOK')).toThrow()
    expect(() => parseNullableMoneyInput('abc', 'NOK')).toThrow()
    expect(() => parseNullableMoneyInput('1,000,5', 'NOK')).toThrow()
  })

  it('property: every non-negative amount round-trips exactly, and only blank text is null', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.constantFrom(...CURRENCIES),
        fc.constantFrom('', ' ', '\t', '\u00a0'),
        (minorUnits, currency, pad) => {
          const text = toDecimalString(fromMinorUnits(minorUnits, currency))
          expect(parseNullableMoneyInput(text, currency)).toBe(minorUnits)
          expect(parseNullableMoneyInput(`${pad}${text}${pad}`, currency)).toBe(minorUnits)
          expect(parseNullableMoneyInput(text.replace('.', ','), currency)).toBe(minorUnits)
          expect(parseNullableMoneyInput(pad, currency)).toBeNull()
        },
      ),
      { numRuns: 1000 },
    )
  })
})

describe('requireKnownAmount — a value the server needs to be known', () => {
  it('refuses a blank field with the caller’s message; accepts an explicit zero', () => {
    for (const blank of ['', '   ', '\u00a0']) {
      expect(() => requireKnownAmount(blank, 'NOK', 'Enter a unit price')).toThrow(
        InvalidMoneyInputError,
      )
      expect(() => requireKnownAmount(blank, 'NOK', 'Enter a unit price')).toThrow(
        'Enter a unit price',
      )
    }
    expect(requireKnownAmount('0', 'NOK', 'x')).toBe(0n)
    expect(requireKnownAmount('0,00', 'EUR', 'x')).toBe(0n)
    expect(requireKnownAmount('0', 'JPY', 'x')).toBe(0n)
    expect(requireKnownAmount('149,50', 'NOK', 'x')).toBe(14950n)
  })
})

describe('parseOptionalChargeInput — the one named place blank means zero', () => {
  it('blank shipping/customs/discount/fees means no such charge (0n); values parse normally', () => {
    expect(parseOptionalChargeInput('', 'NOK')).toBe(0n)
    expect(parseOptionalChargeInput('  ', 'JPY')).toBe(0n)
    expect(parseOptionalChargeInput('49', 'NOK')).toBe(4900n)
    expect(parseOptionalChargeInput('0', 'NOK')).toBe(0n)
    expect(() => parseOptionalChargeInput('x', 'NOK')).toThrow()
  })
})

describe('parseNokInput — unchanged contract for the flows that already required an amount', () => {
  it('blank throws (never 0n); "0" is a known zero', () => {
    expect(() => parseNokInput('')).toThrow(InvalidMoneyInputError)
    expect(() => parseNokInput('   ')).toThrow('Enter an amount')
    expect(parseNokInput('0')).toBe(0n)
    expect(parseNokInput('149,50')).toBe(14950n)
  })
})
