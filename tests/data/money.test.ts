import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  LEDGER_MINOR_MAX,
  LEDGER_MINOR_MIN,
  MoneyTransportError,
  moneyArg,
  normalizeDecimalText,
  optionalMoneyArg,
  parseMinorUnits,
  parseNullableMinorUnits,
  serializeMinorUnits,
  serializeOptionalMinorUnits,
} from '../../src/data/money'

describe('money boundary mapping (pure round-trip)', () => {
  it('parses a decimal string to an exact bigint', () => {
    expect(parseMinorUnits('69900')).toBe(69_900n)
  })

  it('round-trips a value beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const huge = '9007199254740993' // 2^53 + 1 — not exactly representable as a JS number
    expect(parseMinorUnits(huge)).toBe(9_007_199_254_740_993n)
    expect(serializeMinorUnits(parseMinorUnits(huge))).toBe(huge)
  })

  it('serializes a bigint to its decimal string form', () => {
    expect(serializeMinorUnits(69_900n)).toBe('69900')
  })
})

/** The values a transport bug would corrupt first: zero, the sign, the edge of the safe range,
 *  powers of two and ten, and both ends of bigint. */
const SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const EDGE_VALUES: bigint[] = [
  0n,
  1n,
  -1n,
  SAFE - 1n,
  SAFE,
  SAFE + 1n,
  SAFE + 2n,
  -SAFE,
  -SAFE - 1n,
  -SAFE - 2n,
  2n ** 53n,
  2n ** 58n,
  2n ** 58n + 3n,
  -(2n ** 58n),
  10n ** 15n,
  10n ** 16n + 1n,
  10n ** 18n,
  LEDGER_MINOR_MAX,
  LEDGER_MINOR_MIN,
  LEDGER_MINOR_MAX - 1n,
  LEDGER_MINOR_MIN + 1n,
]

describe('parseMinorUnits', () => {
  it.each(EDGE_VALUES)('reads the canonical text of %s exactly', (value) => {
    expect(parseMinorUnits(value.toString())).toBe(value)
  })

  it('accepts a number only when it is a safe integer', () => {
    expect(parseMinorUnits(0)).toBe(0n)
    expect(parseMinorUnits(-1)).toBe(-1n)
    expect(parseMinorUnits(Number.MAX_SAFE_INTEGER)).toBe(SAFE)
    expect(parseMinorUnits(-Number.MAX_SAFE_INTEGER)).toBe(-SAFE)
  })

  it.each([
    Number.MAX_SAFE_INTEGER + 1, // 2^53: exactly representable but indistinguishable from 2^53 + 1
    Number.MAX_SAFE_INTEGER + 2,
    -(Number.MAX_SAFE_INTEGER + 1),
    2 ** 58,
    1e21,
    1.5,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('refuses the number %s instead of converting it with BigInt()', (value) => {
    expect(() => parseMinorUnits(value)).toThrow(MoneyTransportError)
  })

  it('does not "recover" a rounded value: BigInt(2^53 + 1 as number) is the wrong amount', () => {
    // The trap this function exists to close: the number below is what JSON.parse hands over for
    // the wire literal 9007199254740993, and BigInt() of it keeps the wrong digits.
    const rounded = JSON.parse('9007199254740993') as number
    expect(BigInt(rounded)).not.toBe(9_007_199_254_740_993n)
    expect(() => parseMinorUnits(rounded)).toThrow(MoneyTransportError)
  })

  it.each([
    '', // BigInt('') === 0n — an empty string must never become a known zero
    ' ',
    ' 12',
    '12 ',
    '+5',
    '-0',
    '007',
    '00',
    '1e3',
    '1E3',
    '5.0',
    '5.',
    '.5',
    '0x10',
    '0b11',
    '0o7',
    '1_000',
    '--1',
    '-',
    '9007199254740993n',
    'NaN',
    'null',
    'Infinity',
    '１２３', // full-width digits
    '12\n',
  ])('rejects the non-canonical text %j', (text) => {
    expect(() => parseMinorUnits(text)).toThrow(MoneyTransportError)
  })

  it('reads an aggregate beyond the bigint range exactly (numeric sums are not capped)', () => {
    const beyond = (LEDGER_MINOR_MAX + 1n) * 3n
    expect(parseMinorUnits(beyond.toString())).toBe(beyond)
    expect(parseMinorUnits((-beyond).toString())).toBe(-beyond)
  })

  it('rejects non-string, non-number input', () => {
    expect(() => parseMinorUnits(null as unknown as string)).toThrow(MoneyTransportError)
    expect(() => parseMinorUnits(undefined as unknown as string)).toThrow(MoneyTransportError)
    expect(() => parseMinorUnits(5n as unknown as string)).toThrow(MoneyTransportError)
    expect(() => parseMinorUnits({} as unknown as string)).toThrow(MoneyTransportError)
  })
})

describe('NULL is unknown and 0 is a known zero (FINANCIAL_MODEL.md §1.1)', () => {
  it('null and undefined stay null; a stored zero stays 0n', () => {
    expect(parseNullableMinorUnits(null)).toBeNull()
    expect(parseNullableMinorUnits(undefined)).toBeNull()
    expect(parseNullableMinorUnits('0')).toBe(0n)
    expect(parseNullableMinorUnits(0)).toBe(0n)
  })

  it('the empty string is refused, never read as "no value" and never as zero', () => {
    expect(() => parseNullableMinorUnits('')).toThrow(MoneyTransportError)
  })

  it('an omitted optional argument stays omitted; an explicit zero is sent as "0"', () => {
    expect(serializeOptionalMinorUnits(undefined)).toBeUndefined()
    expect(serializeOptionalMinorUnits(0n)).toBe('0')
    expect(optionalMoneyArg(undefined)).toBeUndefined()
    expect(optionalMoneyArg(0n)).toBe('0')
  })
})

describe('serializeMinorUnits', () => {
  it.each(EDGE_VALUES)('writes %s as canonical decimal text', (value) => {
    const text = serializeMinorUnits(value)
    expect(text).toBe(value.toString())
    expect(text).toMatch(/^(?:0|-?[1-9][0-9]*)$/)
    expect(text).not.toMatch(/[eE.+ ]/)
  })

  it('refuses amounts the ledger cannot hold, on both sides, instead of sending them', () => {
    expect(() => serializeMinorUnits(LEDGER_MINOR_MAX + 1n)).toThrow(MoneyTransportError)
    expect(() => serializeMinorUnits(LEDGER_MINOR_MIN - 1n)).toThrow(MoneyTransportError)
    expect(() => serializeMinorUnits(10n ** 30n)).toThrow(/supported money range/)
  })

  it('refuses anything that is not a bigint — there is no number overload', () => {
    expect(() => serializeMinorUnits(5 as unknown as bigint)).toThrow(MoneyTransportError)
    expect(() => serializeMinorUnits('5' as unknown as bigint)).toThrow(MoneyTransportError)
    expect(() => serializeMinorUnits(null as unknown as bigint)).toThrow(MoneyTransportError)
  })

  it('moneyArg is a string at runtime even though the generated type says number', () => {
    const value: unknown = moneyArg(9_007_199_254_740_993n)
    expect(typeof value).toBe('string')
    expect(value).toBe('9007199254740993')
    // ... and survives JSON exactly, which is the whole point.
    expect(JSON.stringify({ p_value_minor: moneyArg(2n ** 58n + 3n) })).toBe(
      '{"p_value_minor":"288230376151711747"}',
    )
  })
})

describe('property: the wire round trip is the identity across the whole signed ledger range', () => {
  const ledgerBigint = fc.oneof(
    { weight: 6, arbitrary: fc.bigInt({ min: LEDGER_MINOR_MIN, max: LEDGER_MINOR_MAX }) },
    { weight: 3, arbitrary: fc.bigInt({ min: -(2n ** 60n), max: 2n ** 60n }) },
    {
      weight: 3,
      arbitrary: fc.integer({ min: -3, max: 3 }).map((delta) => SAFE + BigInt(delta)),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.integer({ min: 0, max: 62 }), fc.integer({ min: -2, max: 2 }), fc.boolean())
        .map(([power, delta, negative]) => {
          const value = 2n ** BigInt(power) + BigInt(delta)
          return negative ? -value : value
        }),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.integer({ min: 0, max: 18 }), fc.integer({ min: -2, max: 2 }))
        .map(([power, delta]) => 10n ** BigInt(power) + BigInt(delta)),
    },
    { weight: 1, arbitrary: fc.constantFrom(...EDGE_VALUES) },
  )

  it('serialize -> JSON -> parse === original, for every generated amount', () => {
    fc.assert(
      fc.property(ledgerBigint, (value) => {
        const wire = JSON.stringify({ a: serializeMinorUnits(value) })
        const back = (JSON.parse(wire) as { a: string }).a
        expect(parseMinorUnits(back)).toBe(value)
        expect(back).not.toMatch(/[eE.+ ]/)
      }),
      { numRuns: 4000 },
    )
  })

  it('a value above 2^53 never survives the number path, and never passes the parser', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: SAFE + 1n, max: LEDGER_MINOR_MAX }),
        fc.boolean(),
        (magnitude, negative) => {
          const value = negative ? -magnitude : magnitude
          const asNumber = Number(value)
          // Either the double is a different integer, or it is 2^53 (ambiguous): both are refused.
          expect(() => parseMinorUnits(asNumber)).toThrow(MoneyTransportError)
          // ... while the text of the same value is read back exactly.
          expect(parseMinorUnits(value.toString())).toBe(value)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('an edited text is a different value: no digit is ever silently dropped or added', () => {
    fc.assert(
      fc.property(ledgerBigint, (value) => {
        const text = value.toString()
        const digits = text.startsWith('-') ? text.slice(1) : text
        if (digits === '0') return
        expect(parseMinorUnits(text)).not.toBe(parseMinorUnits(`${text}0`))
        if (digits.length > 1) {
          expect(parseMinorUnits(text)).not.toBe(parseMinorUnits(text.slice(0, -1)))
        }
      }),
      { numRuns: 1000 },
    )
  })

  it('a signed unsafe value keeps its sign through the wire (never clamped to zero or made absolute)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: SAFE + 1n, max: LEDGER_MINOR_MAX }), (magnitude) => {
        const negative = parseMinorUnits(serializeMinorUnits(-magnitude))
        expect(negative).toBe(-magnitude)
        expect(negative < 0n).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('normalizeDecimalText (numeric rates read as text)', () => {
  it.each([
    ['11.50000000', '11.5'],
    ['1.00000000', '1'],
    ['0.06037500', '0.060375'],
    ['0.00000001', '0.00000001'],
    ['1234567890.12345678', '1234567890.12345678'], // 18 significant digits: a double cannot hold it
    ['7', '7'],
    ['-0.5', '-0.5'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDecimalText(input)).toBe(expected)
  })

  it.each(['', '1e5', '1,5', ' 1', '.5', '5.', 'abc'])('rejects %j', (bad) => {
    expect(() => normalizeDecimalText(bad)).toThrow(MoneyTransportError)
  })
})
