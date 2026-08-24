import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CSV_BOM,
  buildCsvText,
  csvBoolean,
  csvField,
  csvFreeText,
  csvMoney,
  formatMinorUnitsAsDecimal,
  sanitizeCsvFreeText,
} from '../../src/domain/export/csv'
import { parseCsvBody, parseCsvRecord } from './export-fixtures'

describe('RFC 4180 writer', () => {
  function csvRowOf(fields: readonly string[]): string {
    return buildCsvText(['h'], [fields]).split('\r\n')[1] ?? ''
  }

  it('quotes only fields that need it', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField('cr\rlf')).toBe('"cr\rlf"')
  })

  it('round-trips arbitrary hostile strings through an independent reader (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (value) => {
        const record = parseCsvRecord(csvRowOf([value]))
        return record[0] === value
      }),
      { numRuns: 500 },
    )
    // Multi-field records with commas/quotes/newlines interleaved.
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 6 }),
        (values) => {
          const parsed = parseCsvBody(buildCsvText(['h'], [values]))
          return JSON.stringify(parsed[1]) === JSON.stringify(values)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('emits BOM + CRLF + header + terminating CRLF', () => {
    const text = buildCsvText(['A', 'B'], [['1', '2']])
    expect(text.startsWith(CSV_BOM)).toBe(true)
    const bare = text.slice(1)
    expect(bare).toBe('A,B\r\n1,2\r\n')
  })

  it('produces a header-only body for an empty dataset', () => {
    const text = buildCsvText(['A'], [])
    expect(text.slice(1)).toBe('A\r\n')
  })
})

describe('spreadsheet formula injection defence', () => {
  it.each(['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠'])(
    'prefixes a cell beginning with %s',
    (trigger) => {
      expect(sanitizeCsvFreeText(`${trigger}cmd`)).toBe(`'${trigger}cmd`)
    },
  )

  it('leaves ordinary text and non-leading triggers untouched', () => {
    expect(sanitizeCsvFreeText('Charizard holo')).toBe('Charizard holo')
    expect(sanitizeCsvFreeText('sum = 1+1')).toBe('sum = 1+1')
    expect(sanitizeCsvFreeText('a\tb')).toBe('a\tb')
    expect(sanitizeCsvFreeText('')).toBe('')
  })

  it('sanitizes free-text columns only via csvFreeText; null stays empty', () => {
    expect(csvFreeText('=cmd')).toBe("'=cmd")
    expect(csvFreeText(null)).toBe('')
    expect(csvFreeText(undefined)).toBe('')
  })

  it('NEVER corrupts legitimate numeric negatives — money cells bypass sanitization', () => {
    const realizedLoss = csvMoney('-123456', 'NOK')
    expect(realizedLoss).toBe('-1234.56')
    // The apostrophe would turn this into text in a spreadsheet — its absence is the point.
    expect(realizedLoss.startsWith("'")).toBe(false)
    // A free-text cell holding the same-looking string IS prefixed.
    expect(sanitizeCsvFreeText('-1234.56')).toBe("'-1234.56")
  })

  it('sanitization is idempotent', () => {
    expect(sanitizeCsvFreeText(sanitizeCsvFreeText('=x'))).toBe(sanitizeCsvFreeText('=x'))
  })
})

describe('money rendering (decimal strings per currency exponent)', () => {
  it('renders NOK/EUR-style exponents', () => {
    expect(formatMinorUnitsAsDecimal('57123', 'NOK')).toBe('571.23')
    expect(formatMinorUnitsAsDecimal('-455', 'EUR')).toBe('-4.55')
    expect(formatMinorUnitsAsDecimal('5', 'USD')).toBe('0.05')
  })

  it('keeps genuine zero as 0.00 — never blank', () => {
    expect(csvMoney('0', 'NOK')).toBe('0.00')
  })

  it('renders zero-exponent currencies without a decimal point (JPY)', () => {
    expect(formatMinorUnitsAsDecimal('5000', 'JPY')).toBe('5000')
    expect(formatMinorUnitsAsDecimal('-12', 'JPY')).toBe('-12')
  })

  it('is exact past Number.MAX_SAFE_INTEGER', () => {
    expect(formatMinorUnitsAsDecimal('9007199254740993', 'NOK')).toBe('90071992547409.93')
  })

  it('maps null/undefined to the empty field (absent ≠ zero)', () => {
    expect(csvMoney(null, 'NOK')).toBe('')
    expect(csvMoney(undefined, 'NOK')).toBe('')
  })

  it('falls back to the ISO default exponent of 2 for unknown ISO-shaped codes', () => {
    expect(formatMinorUnitsAsDecimal('100', 'XYZ')).toBe('1.00')
  })

  it('booleans render as lowercase true/false', () => {
    expect(csvBoolean(true)).toBe('true')
    expect(csvBoolean(false)).toBe('false')
  })
})
