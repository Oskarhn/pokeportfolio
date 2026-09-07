/**
 * P117 §4 — money round-trip soak, every supported currency: minorUnits -> exact string
 * representation -> back to minorUnits, with zero precision loss at any magnitude (including past
 * Number.MAX_SAFE_INTEGER, the exact class of bug P114 fixed on the *display* side -- this file
 * checks the *domain* round-trip, which never went through Number() to begin with, plus the
 * NOK-specific UI round-trip that does pass through display formatting). Not part of `pnpm test`;
 * run via `pnpm test:soak`.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fromMinorUnits, toDecimalString, equals, fromDecimalString } from '../../src/domain/money'
import { formatNokMinor, parseNokInput } from '../../src/ui/money-format'
import type { CurrencyCode } from '../../src/domain/currency'

const CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

describe('domain round-trip: fromMinorUnits -> toDecimalString -> fromDecimalString, per currency', () => {
  it('120k cases per currency (600k total): exact minorUnits recovered at any magnitude, incl. negatives', () => {
    let runs = 0
    for (const currency of CURRENCIES) {
      fc.assert(
        fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (minorUnits) => {
          runs++
          const money = fromMinorUnits(minorUnits, currency)
          const decimal = toDecimalString(money)
          const recovered = fromDecimalString(decimal, currency)
          expect(recovered.minorUnits).toBe(minorUnits)
          expect(equals(recovered, money)).toBe(true)
        }),
        { numRuns: 120_000 },
      )
    }
    expect(runs).toBe(120_000 * CURRENCIES.length)
  })

  it('boundary magnitudes around Number.MAX_SAFE_INTEGER round-trip exactly for every currency', () => {
    const boundaries = [
      0n,
      1n,
      -1n,
      BigInt(Number.MAX_SAFE_INTEGER) - 1n,
      BigInt(Number.MAX_SAFE_INTEGER),
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      9007199254740993n,
      -9007199254740993n,
      10n ** 40n, // far beyond any realistic amount, but the round-trip must still hold exactly
      -(10n ** 40n),
    ]
    for (const currency of CURRENCIES) {
      for (const minorUnits of boundaries) {
        const money = fromMinorUnits(minorUnits, currency)
        const recovered = fromDecimalString(toDecimalString(money), currency)
        expect(recovered.minorUnits).toBe(minorUnits)
      }
    }
  })
})

describe('UI round-trip: fromMinorUnits -> formatNokMinor -> parseNokInput, NOK', () => {
  // formatNokMinor and parseNokInput are deliberately NOT a general round-trip pair --
  // money-format.ts's own module comment: formatNokMinor is for "an already-settled amount back
  // for nb-NO display" (grouping separators included), while parseNokInput normalizes "what a
  // person actually types" (never grouped). Once the whole-kroner part reaches 4 digits (>= 1000
  // kr = 100000 ore), Intl.NumberFormat('nb-NO') inserts a thousands-group separator that
  // parseNokInput's strict domain-layer parser correctly refuses to re-read (no silent
  // reinterpretation of a display artifact as a digit) -- that is not a bug, so this soak keeps to
  // the range where formatNokMinor never groups, which is the range this round-trip is actually a
  // real contract for.
  // Restricted to non-negative amounts, matching every real caller of parseNokInput in this app
  // (unit cost basis, manual valuation, total paid, threshold -- src/features/**/*.tsx): all
  // user-facing amount fields are non-negative-only in practice. See the dedicated test below for
  // the negative case, which does NOT round-trip and is disclosed rather than silently avoided.
  it('100k cases, non-negative amounts under 1000.00 kr (no group separator): exact minor-unit amount survives the full display round-trip', () => {
    let runs = 0
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 99999n }), (minorUnits) => {
        runs++
        const formatted = formatNokMinor(minorUnits)
        const recovered = parseNokInput(formatted)
        expect(recovered).toBe(minorUnits)
      }),
      { numRuns: 100_000 },
    )
    expect(runs).toBe(100_000)
  })

  it('P117 disclosed gap: a formatted NEGATIVE amount does NOT round-trip through parseNokInput', () => {
    // formatNokMinor renders the negative sign using the locale's own minus glyph
    // (Intl.NumberFormat('nb-NO').formatToParts(-1) -- U+2212 REAL MINUS SIGN on this ICU, not
    // ASCII '-'/U+002D), while parseNokInput's underlying domain parser only accepts ASCII
    // hyphen-minus. No current UI call site ever feeds a formatted value back into parseNokInput
    // (every caller reads fresh keyboard input, which types U+002D), so this is not reachable
    // through the shipped app today -- but it is a real asymmetry between the two functions,
    // pinned here rather than silently left unnoticed.
    const formatted = formatNokMinor(-50n)
    expect(formatted).not.toMatch(/^-/) // confirms the glyph is NOT plain ASCII hyphen
    expect(() => parseNokInput(formatted)).toThrow()
  })
})
