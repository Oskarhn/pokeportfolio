/**
 * P117 §3 — money PARSER fuzz (P114's suite only fuzzed display formatting, never the parse
 * boundary). Targets `parseDecimalToBigInt` (src/domain/decimal.ts, the exact bigint parser every
 * money constructor routes through), `fromDecimalString` (src/domain/money.ts), and
 * `parseNokInput` (src/ui/money-format.ts, the one UI-layer normalization: comma OR dot as the
 * decimal separator, nothing else).
 *
 * The contract under test is "no silent reinterpretation": a string is either read as EXACTLY the
 * decimal it denotes, or rejected with InvalidMoneyInputError -- never coerced, truncated, or
 * partially parsed. Not part of `pnpm test`; run via `pnpm test:soak`.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { parseDecimalToBigInt } from '../../src/domain/decimal'
import { fromDecimalString } from '../../src/domain/money'
import { parseNokInput } from '../../src/ui/money-format'
import { InvalidMoneyInputError } from '../../src/domain/errors'

/** A string of exactly `minLength`-`maxLength` ASCII digits (leading zeros allowed), built from
 *  `fc.array`/`fc.integer` rather than `fc.stringMatching` -- regex-driven string generation is
 *  dramatically slower at these volumes and buys nothing here over composing primitives. */
function digitsArb(minLength: number, maxLength: number) {
  return fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength, maxLength })
    .map((digits) => digits.join(''))
}

/** Canonical valid decimal strings: optional sign, digits (with possible leading zeros), optional
 *  fraction of length <= fractionDigits. Mirrors exactly what DECIMAL_PATTERN accepts. */
function validDecimalArb(fractionDigits: number) {
  return fc
    .record({
      negative: fc.boolean(),
      whole: digitsArb(1, 25),
      fractionLength: fc.integer({ min: 0, max: fractionDigits }),
      fractionDigits: digitsArb(0, fractionDigits),
    })
    .map(({ negative, whole, fractionLength, fractionDigits: fd }) => {
      const fraction = fd.slice(0, fractionLength)
      const text = fraction.length > 0 ? `${whole}.${fraction}` : whole
      return { text: negative ? `-${text}` : text, negative, whole, fraction }
    })
}

describe('parseDecimalToBigInt soak — valid canonical decimals parse exactly', () => {
  it('150k cases across fractionDigits 0-8: result matches hand-computed scaled magnitude', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 8 })
          .chain((fractionDigits) =>
            fc.tuple(fc.constant(fractionDigits), validDecimalArb(fractionDigits)),
          ),
        ([fractionDigits, { text, negative, whole, fraction }]) => {
          runs++
          const result = parseDecimalToBigInt(text, fractionDigits)
          const paddedFraction = fraction.padEnd(fractionDigits, '0')
          const expectedMagnitude = BigInt(whole + paddedFraction)
          const expected =
            negative && expectedMagnitude !== 0n ? -expectedMagnitude : expectedMagnitude
          expect(result).toBe(expected)
        },
      ),
      { numRuns: 150_000 },
    )
    expect(runs).toBe(150_000)
  })

  it('extreme magnitude: whole part up to 200 digits round-trips exactly, 20k cases', () => {
    let runs = 0
    fc.assert(
      fc.property(digitsArb(1, 200), fc.integer({ min: 0, max: 8 }), (whole, fractionDigits) => {
        runs++
        const result = parseDecimalToBigInt(whole, fractionDigits)
        expect(result).toBe(BigInt(whole) * 10n ** BigInt(fractionDigits))
      }),
      { numRuns: 20_000 },
    )
    expect(runs).toBe(20_000)
  })

  it('extreme precision beyond the allowed fractionDigits always throws, never truncates -- 30k cases', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        digitsArb(1, 30),
        digitsArb(1, 30),
        (fractionDigits, whole, fraction) => {
          fc.pre(fraction.length > fractionDigits)
          runs++
          expect(() => parseDecimalToBigInt(`${whole}.${fraction}`, fractionDigits)).toThrow(
            InvalidMoneyInputError,
          )
        },
      ),
      { numRuns: 30_000 },
    )
    expect(runs).toBe(30_000)
  })
})

// Whitespace/line-terminator-class fragments (Unicode Zs category, plus CR/LF) are exactly what
// JS String.prototype.trim() strips from the ENDS of a string -- spliced at 'start' or 'end' they
// would be silently trimmed away, leaving the underlying valid decimal untouched (correct
// behaviour, not poison). They only poison the parse when they land in the MIDDLE, where trim()
// cannot reach them.
const TRIMMABLE_WHITESPACE_FRAGMENTS = [
  ' ', // interior space (U+0020)
  ' ', // non-breaking space (U+00A0) -- a common paste artifact from spreadsheet/locale copy
  ' ', // narrow no-break space (U+202F) -- French/some European grouping
  ' ', // thin space (U+2009)
  '\r\n',
]

// Non-whitespace poisons: never stripped by trim(), so these poison the parse at any position.
// EXCLUDES comma -- see COMMA_POISON below for why comma needs separate handling.
const EDGE_SAFE_POISON_FRAGMENTS = [
  '​', // zero-width space (U+200B, Unicode category Cf -- NOT Zs, so trim() leaves it alone)
  'e5', // scientific notation
  'E-3',
  '+', // extra sign
  '..', // doubled decimal point
  '_', // numeric-literal-style separator (valid in JS source, not in this format)
  '０', // fullwidth digit '0' -- visually a digit, not matched by \d
  '٠', // Arabic-indic digit zero -- also not matched by \d (ASCII-only pattern)
  'abc',
  '‍', // zero-width joiner (U+200D, also Cf)
]

interface FragmentAndPosition {
  readonly fragment: string
  readonly position: 'start' | 'middle' | 'end'
  /** True for a Zs/whitespace-class fragment, which trim() only strips from the string's OUTER
   *  edges -- placing one at 'middle' is only genuine interior poison (unreachable by trim) when
   *  the base text is at least 2 characters long, since a 1-character base has no position that
   *  is strictly between two characters. The consuming property must `fc.pre()` on that before
   *  splicing; see below. */
  readonly trimmable: boolean
}

function fragmentAndPositionArb(includeComma: boolean): fc.Arbitrary<FragmentAndPosition> {
  const edgeSafe = includeComma ? [',', ...EDGE_SAFE_POISON_FRAGMENTS] : EDGE_SAFE_POISON_FRAGMENTS
  return fc.oneof(
    fc
      .constantFrom(...TRIMMABLE_WHITESPACE_FRAGMENTS)
      .map((fragment): FragmentAndPosition => ({ fragment, position: 'middle', trimmable: true })),
    fc
      .record({
        fragment: fc.constantFrom(...edgeSafe),
        position: fc.constantFrom<'start' | 'middle' | 'end'>('start', 'middle', 'end'),
      })
      .map((r): FragmentAndPosition => ({ ...r, trimmable: false })),
  )
}

/** Splices `fragment` into `text` at `position`. For 'middle', a 1-character `text` has no
 *  position strictly between two characters -- the caller must have already excluded that case
 *  for trimmable fragments (see `FragmentAndPosition.trimmable`) via `fc.pre`. */
function splice(text: string, fragment: string, position: 'start' | 'middle' | 'end'): string {
  if (position === 'start') return `${fragment}${text}`
  if (position === 'end') return `${text}${fragment}`
  const mid = Math.floor(text.length / 2)
  return `${text.slice(0, mid)}${fragment}${text.slice(mid)}`
}

/** True when splicing `fragment` into a string of this length at 'middle' is guaranteed to land
 *  strictly between two characters (i.e. genuinely unreachable by `trim()`'s edge-only stripping),
 *  regardless of `Math.floor`'s exact split point. */
function isGenuineInteriorSplice(textLength: number): boolean {
  return textLength >= 2
}

describe('parseDecimalToBigInt soak — poisoned near-valid strings are always rejected, never reinterpreted', () => {
  it('120k cases: every poisoned variant throws InvalidMoneyInputError', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 8 })
          .chain((fractionDigits) =>
            fc.tuple(
              fc.constant(fractionDigits),
              validDecimalArb(fractionDigits),
              fragmentAndPositionArb(true),
            ),
          ),
        ([fractionDigits, base, fp]) => {
          // A 1-character base has no position strictly between two characters -- a trimmable
          // fragment spliced there is indistinguishable from the edge (trim() removes it, and the
          // result is the original valid decimal, not poison). See isGenuineInteriorSplice.
          fc.pre(!fp.trimmable || isGenuineInteriorSplice(base.text.length))
          runs++
          const poisoned = splice(base.text, fp.fragment, fp.position)
          expect(() => parseDecimalToBigInt(poisoned, fractionDigits)).toThrow(
            InvalidMoneyInputError,
          )
        },
      ),
      { numRuns: 120_000 },
    )
    expect(runs).toBe(120_000)
  })
})

describe('parseDecimalToBigInt soak — arbitrary unicode fuzz never crashes with a non-domain error', () => {
  it('120k fully-arbitrary unicode strings: either a clean InvalidMoneyInputError or an exact valid parse, never any other exception type', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.integer({ min: 0, max: 8 }),
        (raw, fractionDigits) => {
          runs++
          try {
            const result = parseDecimalToBigInt(raw, fractionDigits)
            // If it succeeded, the trimmed input must be exactly ASCII sign+digits(.digits) -- no
            // other character class can survive to a successful parse.
            expect(/^-?[0-9]+(\.[0-9]+)?$/.test(raw.trim())).toBe(true)
            expect(typeof result).toBe('bigint')
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidMoneyInputError)
          }
        },
      ),
      { numRuns: 120_000 },
    )
    expect(runs).toBe(120_000)
  })
})

describe('fromDecimalString soak — currency-scoped parsing, 60k cases across all currencies', () => {
  const currencies: Array<[string, number]> = [
    ['NOK', 2],
    ['EUR', 2],
    ['USD', 2],
    ['GBP', 2],
    ['JPY', 0],
  ]

  it('valid decimals round-trip to the correct minorUnits per currency exponent', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...currencies),
        fc
          .integer({ min: 0, max: 2 })
          .chain((fd) => fc.tuple(fc.constant(fd), validDecimalArb(fd))),
        ([currency, exponent], [fractionDigits, { text }]) => {
          fc.pre(fractionDigits <= exponent)
          runs++
          const money = fromDecimalString(text, currency as never)
          expect(money.currency).toBe(currency)
          expect(money.minorUnits).toBe(parseDecimalToBigInt(text, exponent))
        },
      ),
      { numRuns: 60_000 },
    )
    expect(runs).toBe(60_000)
  })
})

describe('parseNokInput soak — comma-or-dot UI normalization, never silently reinterpreted', () => {
  it('60k cases: comma and dot variants of the same amount parse identically', () => {
    let runs = 0
    fc.assert(
      fc.property(validDecimalArb(2), fc.boolean(), fc.boolean(), (decimal, useComma, pad) => {
        runs++
        const raw = useComma ? decimal.text.replace('.', ',') : decimal.text
        const padded = pad ? `  ${raw}  ` : raw
        const result = parseNokInput(padded)
        expect(result).toBe(parseDecimalToBigInt(decimal.text, 2))
      }),
      { numRuns: 60_000 },
    )
    expect(runs).toBe(60_000)
  })

  it('40k cases: poisoned input (excluding plain comma, which is the valid alternate separator) always throws, never guesses a value', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.record({ base: validDecimalArb(2), fp: fragmentAndPositionArb(false) }),
        ({ base, fp }) => {
          fc.pre(!fp.trimmable || isGenuineInteriorSplice(base.text.length))
          runs++
          const poisoned = splice(base.text, fp.fragment, fp.position)
          // parseNokInput only rewrites the FIRST comma to a dot -- none of these fragments
          // contain a comma, so that rewrite is a no-op and the string must still fail the
          // strict domain pattern afterward.
          expect(() => parseNokInput(poisoned)).toThrow(InvalidMoneyInputError)
        },
      ),
      { numRuns: 40_000 },
    )
    expect(runs).toBe(40_000)
  })

  it('40k cases: a SECOND comma (thousands-grouping-style input) always throws rather than guessing which comma is the decimal separator', () => {
    let runs = 0
    fc.assert(
      fc.property(
        validDecimalArb(2),
        digitsArb(1, 3),
        fc.constantFrom<'before' | 'after'>('before', 'after'),
        (decimal, group, where) => {
          // Requires a real fraction so `.replace('.', ',')` actually produces one comma here --
          // otherwise an integer-only `decimal` would leave only the grouping comma, i.e. a
          // single comma, which is the valid case tested above rather than this one.
          fc.pre(decimal.fraction.length > 0)
          runs++
          // e.g. "1,234,56" or "1,23,456" -- more than one comma is never a valid single amount,
          // and parseNokInput must not silently pick one comma as "the" decimal separator.
          const withCommaFraction = decimal.text.replace('.', ',')
          const raw =
            where === 'before' ? `${group},${withCommaFraction}` : `${withCommaFraction},${group}`
          expect(() => parseNokInput(raw)).toThrow(InvalidMoneyInputError)
        },
      ),
      { numRuns: 40_000 },
    )
    expect(runs).toBe(40_000)
  })

  it('empty and whitespace-only input never invents an amount', () => {
    fc.assert(
      fc.property(fc.constantFrom('', ' ', '\t', '\n', '   \t\n  ', ' '), (raw) => {
        expect(() => parseNokInput(raw)).toThrow(InvalidMoneyInputError)
      }),
      { numRuns: 20 },
    )
  })
})
