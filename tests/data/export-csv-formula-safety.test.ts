import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildTypedCsvText,
  CSV_BOM,
  isCanonicalCsvValue,
  renderCsvCell,
  sanitizeCsvFreeText,
  type CsvColumn,
  type CsvColumnKind,
} from '../../src/domain/export/csv'
import {
  buildCsvSuite,
  EXPORT_CSV_FILENAMES,
  EXPORT_CSV_SCHEMA,
  projectionInputFromSnapshot,
} from '../../src/domain/export/csv-projections'
import type { ExportSnapshot } from '../../src/domain/export/snapshot-types'
import { parseCsvRfc } from './csv-rfc-parser'
import { fixtureSnapshot } from './export-fixtures'

/**
 * P157 — the CSV formula-injection and structure contract, exercised through the REAL production
 * writer and the REAL projection builders (not a helper reimplemented for the test).
 *
 * Non-ASCII probes are built from explicit code points so the source stays unambiguous.
 */

const cp = (...points: number[]): string => String.fromCodePoint(...points)
const NBSP = cp(0xa0)
const ZWSP = cp(0x200b)
const FULLWIDTH_EQUALS = cp(0xff1d)
const FULLWIDTH_PLUS = cp(0xff0b)
const FULLWIDTH_MINUS = cp(0xff0d)
const FULLWIDTH_AT = cp(0xff20)

/** Payloads that MUST be neutralized when they sit in a free-text cell. */
const DANGEROUS_TEXT: readonly (readonly [label: string, value: string])[] = [
  ['equals', '=1+1'],
  ['plus', '+SUM(1,2)'],
  ['minus', '-1+2'],
  ['at', '@SUM(A1:A2)'],
  ['hyperlink', '=HYPERLINK("inert-marker","x")'],
  ['leading tab', '\t=1+1'],
  ['leading CR', '\r=1+1'],
  ['leading LF', '\n=1+1'],
  ['tab with no trigger', '\tplain'],
  ['leading space', ' =1+1'],
  ['several spaces', '   +1'],
  ['space tab space', ' \t =1+1'],
  ['NBSP', `${NBSP}=1+1`],
  ['zero-width space', `${ZWSP}=1+1`],
  ['control char', `${cp(0x01)}=1+1`],
  ['NUL', `${cp(0x00)}@x`],
  ['BOM char', `${cp(0xfeff)}+1`],
  ['line separator', `${cp(0x2028)}-1`],
  ['ideographic space', `${cp(0x3000)}@x`],
  ['soft hyphen', `${cp(0xad)}=1`],
  ['bidi mark', `${cp(0x202e)}=1`],
  ['full-width equals', `${FULLWIDTH_EQUALS}SUM(1)`],
  ['full-width plus', `${FULLWIDTH_PLUS}1`],
  ['full-width minus', `${FULLWIDTH_MINUS}1`],
  ['full-width at', `${FULLWIDTH_AT}x`],
  ['numeric-looking negative text', '-5'],
  ['numeric-looking negative decimal', '-123.45'],
  ['lone minus', '-'],
  ['lone plus', '+'],
]

/** Text that must pass through untouched — no cosmetic damage to legitimate data. */
const HARMLESS_TEXT: readonly string[] = [
  '',
  'Charizard',
  ' Charizard',
  'PSA 10',
  'a=1',
  '1+1',
  '5-3',
  'x\t=1',
  "'=1+1", // already starts with an apostrophe: the cell is literal text in every spreadsheet
  '#hash',
  '(=1)',
  '"quoted"',
  cp(0x30d4, 0x30ab, 0x30c1, 0x30e5, 0x30a6), // ピカチュウ
  'Flabébé',
  'Gengar & Mimikyu',
]

describe('sanitizeCsvFreeText contract', () => {
  it.each(DANGEROUS_TEXT)('prefixes a single apostrophe: %s', (_label, value) => {
    expect(sanitizeCsvFreeText(value)).toBe(`'${value}`)
  })

  it.each(HARMLESS_TEXT)('leaves harmless text untouched: %j', (value) => {
    expect(sanitizeCsvFreeText(value)).toBe(value)
  })

  it('is idempotent — a repeated export never double-prefixes', () => {
    for (const [, value] of DANGEROUS_TEXT) {
      const once = sanitizeCsvFreeText(value)
      expect(sanitizeCsvFreeText(once)).toBe(once)
    }
  })

  it('treats every Unicode whitespace, separator, control and format character as skippable', () => {
    const skippable = /[\p{White_Space}\p{Z}\p{Cc}\p{Cf}]/u
    let checked = 0
    for (let point = 0; point <= 0xffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue // lone surrogates
      const char = String.fromCodePoint(point)
      if (!skippable.test(char)) continue
      if (point === 0x09 || point === 0x0a || point === 0x0d) continue // covered as break chars
      checked++
      expect(sanitizeCsvFreeText(`${char}=1+1`), `U+${point.toString(16)}`).toBe(`'${char}=1+1`)
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('never lets a formula through: after the optional prefix no trigger leads (property)', () => {
    const alphabet = fc.constantFrom(
      '=',
      '+',
      '-',
      '@',
      ' ',
      '\t',
      '\r',
      '\n',
      NBSP,
      ZWSP,
      cp(0x01),
      cp(0xfeff),
      FULLWIDTH_EQUALS,
      "'",
      'a',
      '1',
      ',',
      '"',
    )
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 8 }), (chars) => {
        const value = chars.join('')
        const out = sanitizeCsvFreeText(value)
        // Either untouched or exactly one apostrophe added — never anything else.
        expect(out === value || out === `'${value}`).toBe(true)
        // If untouched, its first non-skippable character is not a trigger and it does not begin
        // with a tab/CR/LF.
        if (out === value) {
          const first = Array.from(value).find(
            (c) => !/[\p{White_Space}\p{Z}\p{Cc}\p{Cf}]/u.test(c),
          )
          expect(first === undefined || !'=+-@'.includes(first)).toBe(true)
          expect(['\t', '\r', '\n'].includes(value.charAt(0))).toBe(false)
        }
      }),
      { numRuns: 2000 },
    )
  })
})

describe('typed CSV writer (buildTypedCsvText)', () => {
  const columns: readonly CsvColumn[] = [
    { header: 'Text', kind: 'text' },
    { header: 'Amount', kind: 'money' },
    { header: 'Id', kind: 'id' },
    { header: 'Day', kind: 'date' },
    { header: 'Count', kind: 'integer' },
  ]

  function cells(values: readonly (string | null)[]): string[] {
    const parsed = parseCsvRfc(buildTypedCsvText(columns, [values])).records
    return parsed[1] ?? []
  }

  it('keeps a legitimate negative money cell signed and numeric', () => {
    expect(cells(['x', '-123.45', 'a-1', '2026-01-01', '3'])[1]).toBe('-123.45')
  })

  it('prefixes attacker text that merely LOOKS numeric when it sits in a text column', () => {
    expect(cells(['-123.45', '1.00', 'a-1', '2026-01-01', '3'])[0]).toBe("'-123.45")
  })

  it('fails closed: a non-canonical value in a canonical column is treated as text', () => {
    expect(cells(['x', '=1+1', 'a-1', '2026-01-01', '3'])[1]).toBe("'=1+1")
    expect(cells(['x', '-1+2', 'a-1', '2026-01-01', '3'])[1]).toBe("'-1+2")
    expect(cells(['x', '1.00', '=cmd', '2026-01-01', '3'])[2]).toBe("'=cmd")
    expect(cells(['x', '1.00', 'a-1', ' =1+1', '3'])[3]).toBe("' =1+1")
    expect(cells(['x', '1.00', 'a-1', '2026-01-01', '-3+1'])[4]).toBe("'-3+1")
  })

  it('renders absent as empty and a genuine zero as 0.00 — the two never merge', () => {
    const row = cells(['x', null, 'a-1', '2026-01-01', '0'])
    expect(row[1]).toBe('')
    expect(cells(['x', '0.00', 'a-1', '2026-01-01', '0'])[1]).toBe('0.00')
  })

  it('emits BOM, CRLF and a terminating CRLF; header-only for zero rows', () => {
    const empty = buildTypedCsvText(columns, [])
    expect(empty.startsWith(CSV_BOM)).toBe(true)
    expect(empty.slice(1)).toBe('Text,Amount,Id,Day,Count\r\n')
  })

  it('throws on a row whose width differs from the declared schema', () => {
    expect(() => buildTypedCsvText(columns, [['a', '1.00', 'id']])).toThrow(/declares 5 columns/)
    expect(() =>
      buildTypedCsvText(columns, [['a', '1.00', 'id', '2026-01-01', '1', 'extra']]),
    ).toThrow(/has 6 cells/)
  })

  it('cannot shift a row or column: hostile text round-trips through an independent reader', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 12 }),
        (values) => {
          const text = buildTypedCsvText(
            [{ header: 'Text', kind: 'text' }],
            values.map((v) => [v]),
          )
          const parsed = parseCsvRfc(text)
          // header + one record per value, every record exactly one field, no phantom rows
          expect(parsed.records).toHaveLength(values.length + 1)
          expect(parsed.records.every((r) => r.length === 1)).toBe(true)
          expect(parsed.records.slice(1).map((r) => r[0])).toEqual(
            values.map((v) => sanitizeCsvFreeText(v)),
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('quotes comma, semicolon, tab, quote, CR and LF without shifting cells', () => {
    const nasty = ['a,b', 'a;b', 'a\tb', 'say "hi"', 'l1\nl2', 'l1\r\nl2', 'cr\rmid', ',,,', '""']
    const parsed = parseCsvRfc(
      buildTypedCsvText(
        [
          { header: 'A', kind: 'text' },
          { header: 'B', kind: 'text' },
        ],
        nasty.map((v) => [v, 'tail']),
      ),
    )
    expect(parsed.records).toHaveLength(nasty.length + 1)
    for (const [i, value] of nasty.entries()) {
      expect(parsed.records[i + 1]).toEqual([sanitizeCsvFreeText(value), 'tail'])
    }
  })

  it('handles very long free text without truncation or structure damage', () => {
    const long = `=${'x,"y"\n'.repeat(20000)}`
    const parsed = parseCsvRfc(buildTypedCsvText([{ header: 'A', kind: 'text' }], [[long]]))
    expect(parsed.records).toHaveLength(2)
    expect(parsed.records[1]?.[0]).toBe(`'${long}`)
  })

  it('a value equal to a header name stays a data cell', () => {
    const parsed = parseCsvRfc(
      buildTypedCsvText(
        [
          { header: 'Card', kind: 'text' },
          { header: 'Notes', kind: 'text' },
        ],
        [
          ['Card', 'Notes'],
          ['Card,Notes', 'Card\r\nNotes'],
        ],
      ),
    )
    expect(parsed.records[0]).toEqual(['Card', 'Notes'])
    expect(parsed.records[1]).toEqual(['Card', 'Notes'])
    expect(parsed.records[2]).toEqual(['Card,Notes', 'Card\r\nNotes'])
    expect(parsed.records).toHaveLength(3)
  })

  it('sanitizes header labels through the same text rule (no formula-shaped column names)', () => {
    const parsed = parseCsvRfc(buildTypedCsvText([{ header: '=evil', kind: 'text' }], []))
    expect(parsed.records[0]).toEqual(["'=evil"])
  })
})

// ---------------------------------------------------------------------------
// The production projections, driven with hostile data in every text-bearing source field
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>

function setAll(rows: readonly object[], keys: readonly string[], value: string): void {
  for (const row of rows) for (const key of keys) (row as Loose)[key] = value
}

/** Every free-text source the exporter reads, set to `payload` (user- AND provider-controlled). */
function hostileSnapshot(payload: string): ExportSnapshot {
  const snapshot = structuredClone(fixtureSnapshot())
  setAll(snapshot.holdings, ['notes', 'cert_number'], payload)
  setAll(snapshot.tags, ['name'], payload)
  setAll(snapshot.custom_collections, ['name', 'description', 'color'], payload)
  setAll(snapshot.storage_locations, ['name'], payload)
  setAll(snapshot.retailers, ['name'], payload)
  setAll(snapshot.manual_card_definitions, ['name', 'set_name', 'collector_number'], payload)
  setAll(snapshot.sealed_products, ['name'], payload)
  setAll(snapshot.purchases, ['notes'], payload)
  setAll(snapshot.purchase_lines, ['description'], payload)
  setAll(snapshot.sales, ['marketplace', 'notes'], payload)
  setAll(snapshot.manual_valuations, ['note'], payload)
  setAll(snapshot.lot_cost_adjustments, ['note'], payload)
  setAll(snapshot.acquisition_lots, ['notes'], payload)
  setAll(snapshot.openings, ['notes'], payload)
  setAll(
    snapshot.identity_manifest.card_variants,
    ['card_name', 'set_name', 'card_local_id', 'stamp', 'subtype', 'finish'],
    payload,
  )
  setAll(snapshot.identity_manifest.curated_sealed_products, ['name'], payload)
  return snapshot
}

const NUMERIC_KINDS: ReadonlySet<CsvColumnKind> = new Set(['integer', 'decimal', 'money', 'rate'])
const SKIPPABLE = /[\p{White_Space}\p{Z}\p{Cc}\p{Cf}]/u
const TRIGGERS = [
  '=',
  '+',
  '-',
  '@',
  FULLWIDTH_EQUALS,
  FULLWIDTH_PLUS,
  FULLWIDTH_MINUS,
  FULLWIDTH_AT,
]

/** Independent of the production check: would a spreadsheet plausibly evaluate this cell? */
function looksLikeFormula(cell: string, kind: CsvColumnKind): boolean {
  if (NUMERIC_KINDS.has(kind) && isCanonicalCsvValue(kind, cell)) return false
  if (['\t', '\r', '\n'].includes(cell.charAt(0))) return true
  const first = Array.from(cell).find((c) => !SKIPPABLE.test(c))
  return first !== undefined && TRIGGERS.includes(first)
}

interface SuiteViolation {
  file: string
  column: string
  value: string
}

function auditSuite(snapshot: ExportSnapshot): {
  violations: SuiteViolation[]
  cellsChecked: number
} {
  const files = buildCsvSuite(projectionInputFromSnapshot(snapshot))
  const violations: SuiteViolation[] = []
  let cellsChecked = 0
  for (const file of files) {
    const name = file.filename as (typeof EXPORT_CSV_FILENAMES)[number]
    const schema = EXPORT_CSV_SCHEMA[name]
    const parsed = parseCsvRfc(file.text)
    // Structure first: header equals the declared schema and no record is the wrong width.
    expect(parsed.records[0], name).toEqual(schema.map((c) => c.header))
    for (const record of parsed.records) expect(record, name).toHaveLength(schema.length)
    for (const record of parsed.records.slice(1)) {
      record.forEach((cell, index) => {
        const column = schema[index]
        if (!column) return
        cellsChecked++
        if (looksLikeFormula(cell, column.kind)) {
          violations.push({ file: name, column: column.header, value: cell })
        }
      })
    }
  }
  return { violations, cellsChecked }
}

describe('production CSV suite under hostile free text', () => {
  it.each(DANGEROUS_TEXT)('no cell of any file can be a formula: %s', (_label, payload) => {
    const { violations, cellsChecked } = auditSuite(hostileSnapshot(payload))
    expect(cellsChecked).toBeGreaterThan(100)
    expect(violations).toEqual([])
  })

  it('every text column actually received the payload, sanitized (the probe is not vacuous)', () => {
    const files = buildCsvSuite(projectionInputFromSnapshot(hostileSnapshot('=1+1')))
    let sanitizedCells = 0
    for (const file of files) {
      const name = file.filename as (typeof EXPORT_CSV_FILENAMES)[number]
      const schema = EXPORT_CSV_SCHEMA[name]
      for (const record of parseCsvRfc(file.text).records.slice(1)) {
        record.forEach((cell, index) => {
          if (cell === "'=1+1" && schema[index]?.kind === 'text') sanitizedCells++
        })
      }
    }
    expect(sanitizedCells).toBeGreaterThan(20)
  })

  it('defense in depth: hostile values in id/enum/date/rate columns are neutralized too', () => {
    const snapshot = structuredClone(fixtureSnapshot())
    const payload = '=1+1'
    setAll(snapshot.holdings, ['holding_kind', 'condition', 'grader'], payload)
    setAll(snapshot.acquisition_lots, ['origin', 'cost_basis_state', 'sealed_intent'], payload)
    setAll(snapshot.purchases, ['fx_source', 'origin', 'fx_rate_to_nok', 'fx_rate_date'], payload)
    setAll(snapshot.sales, ['fx_source', 'fx_rate_to_nok', 'sold_on'], payload)
    setAll(snapshot.purchase_lines, ['line_type', 'spend_class', 'condition'], payload)
    setAll(snapshot.lot_disposals, ['kind', 'disposed_on'], payload)
    const { violations } = auditSuite(snapshot)
    expect(violations).toEqual([])
  })

  it('a card, note or set literally named like a header cannot become a header or shift cells', () => {
    const headerNames = Object.values(EXPORT_CSV_SCHEMA)
      .flat()
      .map((c) => c.header)
    const payload = `${headerNames.join(',')}\r\n${headerNames.join(',')}`
    const { violations } = auditSuite(hostileSnapshot(payload))
    expect(violations).toEqual([])
  })

  it('all 11 files keep BOM, CRLF framing and one record per row for hostile input', () => {
    const files = buildCsvSuite(projectionInputFromSnapshot(hostileSnapshot('a,"b"\r\n=c')))
    expect(files.map((f) => f.filename)).toEqual([...EXPORT_CSV_FILENAMES])
    for (const file of files) {
      const parsed = parseCsvRfc(file.text)
      expect(parsed.hadBom, file.filename).toBe(true)
      expect(parsed.endsWithCrlf, file.filename).toBe(true)
    }
  })

  it('renderCsvCell never returns a formula for any kind (property)', () => {
    const kinds: CsvColumnKind[] = [
      'text',
      'id',
      'date',
      'timestamp',
      'enum',
      'boolean',
      'integer',
      'decimal',
      'money',
      'rate',
    ]
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.string({ maxLength: 12 }), (kind, value) => {
        const out = renderCsvCell(kind, value)
        expect(looksLikeFormula(out, kind)).toBe(false)
      }),
      { numRuns: 3000 },
    )
  })
})
