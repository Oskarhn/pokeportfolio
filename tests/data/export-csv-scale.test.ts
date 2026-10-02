import { describe, expect, it } from 'vitest'
import {
  buildCsvSuite,
  EXPORT_CSV_SCHEMA,
  projectionInputFromSnapshot,
  type ExportCsvFilename,
} from '../../src/domain/export/csv-projections'
import type { ExportSnapshot } from '../../src/domain/export/snapshot-types'
import { parseCsvRfc } from './csv-rfc-parser'
import { fixtureSnapshot } from './export-fixtures'

/**
 * P157 — scale behaviour of the pure CSV pipeline. Wall time and heap growth here are Node
 * process figures for the serialization step ONLY; they say nothing about browser heap, the
 * network fetch, or Blob/file delivery, and are reported (not fabricated as browser numbers).
 * The budgets are deliberately generous: they exist to catch an accidental quadratic step, not
 * to certify a device.
 */

function scaledSnapshot(rows: number): ExportSnapshot {
  const base = structuredClone(fixtureSnapshot())
  const seedHolding = base.holdings[0]
  const seedLot = base.acquisition_lots[0]
  const seedSale = base.sales[0]
  const seedSaleLine = base.sale_lines[0]
  if (!seedHolding || !seedLot || !seedSale || !seedSaleLine) throw new Error('fixture shape')
  const hex = (n: number) => n.toString(16).padStart(12, '0')
  const holdings = []
  const lots = []
  const sales = []
  const saleLines = []
  for (let i = 0; i < rows; i++) {
    const holdingId = `a0000000-0000-4000-8000-${hex(i)}`
    const lotId = `b0000000-0000-4000-8000-${hex(i)}`
    const saleId = `c0000000-0000-4000-8000-${hex(i)}`
    holdings.push({
      ...seedHolding,
      id: holdingId,
      notes: i % 7 === 0 ? `=note ${String(i)}, with "quote"\r\nline` : `note ${String(i)}`,
    })
    lots.push({ ...seedLot, id: lotId, holding_id: holdingId })
    sales.push({ ...seedSale, id: saleId })
    saleLines.push({
      ...seedSaleLine,
      id: `d0000000-0000-4000-8000-${hex(i)}`,
      sale_id: saleId,
      lot_id: lotId,
    })
  }
  return { ...base, holdings, acquisition_lots: lots, sales, sale_lines: saleLines }
}

describe('CSV suite at scale (serialization only)', () => {
  it('empty portfolio: every file is a valid header-only CSV', () => {
    const files = buildCsvSuite(projectionInputFromSnapshot(scaledSnapshot(0)))
    for (const file of files) {
      const parsed = parseCsvRfc(file.text)
      const name = file.filename as ExportCsvFilename
      expect(parsed.records[0]).toEqual(EXPORT_CSV_SCHEMA[name].map((c) => c.header))
    }
    expect(parseCsvRfc(files[0]?.text ?? '').records).toHaveLength(1)
  })

  it('a single row round-trips', () => {
    const holdings = buildCsvSuite(projectionInputFromSnapshot(scaledSnapshot(1)))[0]
    expect(parseCsvRfc(holdings?.text ?? '').records).toHaveLength(2)
  })

  it.each([10_000, 100_000])(
    '%i rows: structure intact, time and size reported',
    (rows) => {
      const snapshot = scaledSnapshot(rows)
      const heapBefore = process.memoryUsage().heapUsed
      const started = performance.now()
      const files = buildCsvSuite(projectionInputFromSnapshot(snapshot))
      const elapsedMs = performance.now() - started
      const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024
      const bytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.text), 0)
      console.info(
        `[p157-scale] rows=${String(rows)} files=${String(files.length)} ` +
          `serialize_ms=${elapsedMs.toFixed(0)} output_mb=${(bytes / 1024 / 1024).toFixed(1)} ` +
          `node_heap_growth_mb=${heapGrowthMb.toFixed(0)} (Node serialization only)`,
      )
      // Structure: one record per row in the row-count-driven files, every record full width.
      for (const name of [
        'holdings.csv',
        'acquisition_lots.csv',
        'sales.csv',
        'sale_lines.csv',
      ] as const) {
        const file = files.find((f) => f.filename === name)
        const parsed = parseCsvRfc(file?.text ?? '')
        expect(parsed.records, name).toHaveLength(rows + 1)
        expect(parsed.records.every((r) => r.length === EXPORT_CSV_SCHEMA[name].length)).toBe(true)
      }
      // A quadratic step would blow far past this; a healthy run is a few seconds at 100k rows.
      expect(elapsedMs).toBeLessThan(rows === 10_000 ? 5_000 : 45_000)
    },
    120_000,
  )
})
