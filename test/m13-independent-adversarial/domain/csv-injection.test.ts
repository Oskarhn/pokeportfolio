/**
 * ACTIVE pure-oracle tests: CSV injection safety and RFC 4180 emission (prompt section 7).
 *
 * The matrix encodes the REQUIRED behavior of any conforming exporter:
 *   - dangerous TEXT cells get a leading apostrophe (every trigger prefix, full-width included)
 *   - LITERAL cells (numbers, dates, enums, ids) are NEVER transformed — `-120.50` survives
 *   - quoting/escaping follows RFC 4180 exactly and round-trips through an independent reader
 *
 * A property test drives arbitrary hostile strings through writer+reader to prove structural
 * losslessness; fast-check is already a devDependency of this repository.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  emitLiteralCell,
  emitTextCell,
  FORMULA_TRIGGER_PREFIXES,
  joinRenderedRow,
  parseCsv,
  sanitizeCsvTextCell,
  writeCsv,
} from '../helpers/csvOracle.ts'
import { NEGATIVE_LEGAL_MONEY_COLUMNS } from '../helpers/inventory.ts'

const INJECTION_PAYLOADS: readonly { raw: string; label: string }[] = [
  { raw: '=SUM(A1:A2)', label: 'formula' },
  { raw: "+cmd|' /C calc", label: 'plus DDE' },
  { raw: '-calc', label: 'minus' },
  { raw: '@foo', label: 'macro' },
  { raw: '\tTAB9', label: 'leading tab (Excel strips before evaluation)' },
  { raw: '\rCR-payload', label: 'leading CR' },
  { raw: '＝HYPERLINK("https://evil.example")', label: 'full-width equals' },
  { raw: '＋2+2', label: 'full-width plus' },
  { raw: '－1', label: 'full-width minus' },
  { raw: '＠x', label: 'full-width at' },
]

describe('CSV injection sanitizer oracle', () => {
  it('prefixes a lone apostrophe to EVERY dangerous TEXT cell', () => {
    for (const { raw, label } of INJECTION_PAYLOADS) {
      expect(sanitizeCsvTextCell(raw), label).toBe(`'${raw}`)
      expect(isFormulaSafe(emitTextCell(raw)), label).toBe(true)
    }
  })

  it('leaves harmless text untouched (no cosmetic damage)', () => {
    for (const safe of ['Charizard', 'Binder A', '\u00C6\u00D8\u00C5 notes', 'PSA 10', '']) {
      expect(sanitizeCsvTextCell(safe)).toBe(safe)
    }
  })

  it('is idempotent: re-sanitizing output does not double-prefix', () => {
    const once = sanitizeCsvTextCell('=1+1')
    expect(sanitizeCsvTextCell(once)).toBe(once)
  })
})

/** A rendered cell is formula-safe when no trigger prefix survives at position 0. */
function isFormulaSafe(rendered: string): boolean {
  const body = rendered.startsWith('"') ? rendered.slice(1) : rendered
  return !FORMULA_TRIGGER_PREFIXES.some((prefix) => body.startsWith(prefix))
}

describe('literal cells are never sanitized (negative money survival)', () => {
  it('emits -120.50 as a parseable numeric, NOT as an apostrophized string', () => {
    // The realized-loss case: sales-side columns may legally be negative.
    const negativeMinor = '-12050'
    expect(NEGATIVE_LEGAL_MONEY_COLUMNS.has('sales.net_proceeds_minor')).toBe(true)
    const cell = emitLiteralCell('-120.50')
    expect(cell).toBe('-120.50')
    expect(cell.startsWith("'")).toBe(false)
    expect(negativeMinor.startsWith('-')).toBe(true)
  })

  it('keeps dates, enums and uuids verbatim too', () => {
    expect(emitLiteralCell('2026-08-24')).toBe('2026-08-24')
    expect(emitLiteralCell('NM')).toBe('NM')
    expect(emitLiteralCell('c0000000-0000-0000-0000-0000000a4001')).toBe(
      'c0000000-0000-0000-0000-0000000a4001',
    )
  })
})

describe('RFC 4180 writer oracle', () => {
  it('quotes fields containing commas, quotes and newlines; escapes quotes by doubling', () => {
    const csv = writeCsv([
      ['name', 'notes'],
      ['Charizard, Base Set', 'said "grail" then\nleft on a new line'],
    ])
    const parsed = parseCsv(csv)
    expect(parsed).toEqual([
      ['name', 'notes'],
      ['Charizard, Base Set', 'said "grail" then\nleft on a new line'],
    ])
  })

  it('terminates records with CRLF including the last one', () => {
    const csv = writeCsv([['a', 'b']])
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv).not.toContain('\n\r')
  })

  it('prepends a UTF-8 BOM when asked (Excel + Japanese card names)', () => {
    const csv = writeCsv([['\u30DD\u30B1\u30E2\u30F3']], { bom: true })
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(parseCsv(csv)[0]?.[0]).toBe('\u30DD\u30B1\u30E2\u30F3')
  })

  it('round-trips arbitrary hostile strings through an independent reader (property)', () => {
    const hostileText = fc
      .string({ minLength: 0, maxLength: 60 })
      .filter((s) => !s.includes('\u0000'))
    const rowsArb = fc
      .array(fc.tuple(hostileText, hostileText), { minLength: 1, maxLength: 20 })
      .map((tuples) => tuples.map(([a, b]) => [a, b] as [string, string]))

    // Structural losslessness of the canonical writer over RAW values.
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const parsed = parseCsv(writeCsv(rows))
        return (
          parsed.length === rows.length &&
          parsed.every((row, i) => {
            const original = rows[i] as string[]
            return row.length === original.length && row.every((cell, j) => cell === original[j])
          })
        )
      }),
      { numRuns: 300 },
    )

    // Sanitization composes exactly once when cells are pre-rendered then joined.
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const file = rows.map((r) => joinRenderedRow(r.map(emitTextCell))).join('\r\n') + '\r\n'
        const parsed = parseCsv(file)
        return (
          parsed.length === rows.length &&
          parsed.every((row, i) => {
            const original = rows[i] as [string, string]
            return (
              row.length === 2 &&
              row[0] === sanitizeCsvTextCell(original[0]) &&
              row[1] === sanitizeCsvTextCell(original[1])
            )
          })
        )
      }),
      { numRuns: 300 },
    )
  })

  it('property: literal-cell round-trip never mutates values (money/date safety)', () => {
    const literal = fc.oneof(
      fc.integer({ min: -9_999_999_999_999, max: 9_999_999_999_999 }).map(String),
      fc.constantFrom('-120.50', '0.00', '11.52345678'),
      fc.date({ noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)),
    )
    fc.assert(
      fc.property(literal, (value) => {
        const rendered = writeCsv([[emitLiteralCell(value)]])
        const back = parseCsv(rendered)[0]?.[0]
        return back === value
      }),
      { numRuns: 200 },
    )
  })
})
