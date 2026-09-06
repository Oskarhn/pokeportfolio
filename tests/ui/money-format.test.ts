import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { formatCurrencyMinor, formatNokMinor } from '../../src/ui/money-format'
import { fromMinorUnits, toDecimalString } from '../../src/domain/money'

/**
 * P114: formatNokMinor/formatCurrencyMinor previously routed the exact minor-unit amount through
 * `Number(decimalString)` before handing it to Intl.NumberFormat. That silently loses precision
 * once the magnitude passes Number.MAX_SAFE_INTEGER — exactly the magnitude the backup-export
 * tests (tests/data/export-backup-envelope.test.ts) prove must survive untouched. These tests pin
 * the fix: formatting must reproduce every digit of toDecimalString's exact output, at any
 * magnitude, with no float roundtrip.
 */

/** Normalizes any digit-bearing string (a formatted display string or a toDecimalString output)
 *  to its bare signed integer-of-digits form, ignoring locale grouping/separator glyphs — so a
 *  formatted string and its exact decimal source can be compared for digit-for-digit equality
 *  regardless of presentation (grouping spaces, comma vs. dot, minus-sign glyph). */
function digitsOnly(value: string): string {
  // The minus sign can precede a currency symbol ("€-0.01") rather than lead the string, so this
  // looks for the sign glyph anywhere, not just at position 0.
  const negative = /-|−/.test(value)
  const digits = value.replace(/[^\d]/g, '').replace(/^0+/, '') || '0'
  return (negative && digits !== '0' ? '-' : '') + digits
}

const decimalDigitsOnly = digitsOnly

describe('formatNokMinor — exact at every magnitude (P114 regression)', () => {
  it('renders the known-bad case (9007199254740993 minor units) with the exact last digit', () => {
    // Previously rendered "90 071 992 547 409,94" — one øre high — due to the Number() roundtrip.
    const formatted = formatNokMinor(9007199254740993n)
    expect(formatted.endsWith(',93')).toBe(true)
    expect(formatted).not.toContain(',94')
  })

  it('matches toDecimalString exactly across safe-integer, boundary and beyond-safe magnitudes', () => {
    const cases = [
      0n,
      1n,
      -1n,
      100n,
      123456789n,
      BigInt(Number.MAX_SAFE_INTEGER) - 1n,
      BigInt(Number.MAX_SAFE_INTEGER),
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      9007199254740993n,
      -9007199254740993n,
      123456789012345678901234567890n,
    ]
    for (const minorUnits of cases) {
      const money = fromMinorUnits(minorUnits, 'NOK')
      const exact = toDecimalString(money)
      const formatted = formatNokMinor(minorUnits)
      expect(digitsOnly(formatted)).toBe(decimalDigitsOnly(exact))
    }
  })

  it('property: for any bigint minor-unit amount, formatting never drifts from the exact decimal', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (minorUnits) => {
        const exact = toDecimalString(fromMinorUnits(minorUnits, 'NOK'))
        const formatted = formatNokMinor(minorUnits)
        expect(digitsOnly(formatted)).toBe(decimalDigitsOnly(exact))
      }),
      { numRuns: 2000 },
    )
  })

  it('keeps the existing nb-NO grouping/decimal-comma presentation for ordinary amounts', () => {
    expect(formatNokMinor(69900n)).toBe('699,00')
    expect(formatNokMinor(123456700n)).toContain(',00')
    expect(formatNokMinor(-50n)).toContain('50')
    expect(formatNokMinor(-50n).startsWith('-') || /−/.test(formatNokMinor(-50n))).toBe(true)
  })
})

describe('formatCurrencyMinor — exact at every magnitude (P114 regression)', () => {
  it('is exact for EUR/USD/GBP beyond Number.MAX_SAFE_INTEGER', () => {
    for (const currency of ['EUR', 'USD', 'GBP'] as const) {
      const minorUnits = 9007199254740993n
      const exact = toDecimalString(fromMinorUnits(minorUnits, currency))
      const formatted = formatCurrencyMinor(minorUnits, currency)
      expect(digitsOnly(formatted)).toBe(decimalDigitsOnly(exact))
    }
  })

  it('JPY (zero-exponent currency) renders with no fraction, exactly, at any magnitude', () => {
    const minorUnits = 9007199254740993n
    const formatted = formatCurrencyMinor(minorUnits, 'JPY')
    expect(formatted).not.toContain('.')
    expect(digitsOnly(formatted)).toBe('9007199254740993')
  })

  it('property: exact across currencies and magnitudes', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        fc.constantFrom('NOK', 'EUR', 'USD', 'GBP', 'JPY' as const),
        (minorUnits, currency) => {
          const exact = toDecimalString(fromMinorUnits(minorUnits, currency))
          const formatted = formatCurrencyMinor(minorUnits, currency)
          expect(digitsOnly(formatted)).toBe(decimalDigitsOnly(exact))
        },
      ),
      { numRuns: 2000 },
    )
  })
})
