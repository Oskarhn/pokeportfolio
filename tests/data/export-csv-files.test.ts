import { describe, expect, it } from 'vitest'
import {
  EXPORT_CSV_FILENAMES,
  buildCsvSuite,
  projectionInputFromSnapshot,
} from '../../src/domain/export/csv-projections'
import { FIXTURE_IDS, fixtureSnapshot, parseCsvBody } from './export-fixtures'

function suite(): Record<string, string> {
  const files = buildCsvSuite(projectionInputFromSnapshot(fixtureSnapshot()))
  return Object.fromEntries(files.map((f) => [f.filename, f.text]))
}

function rows(text: string): string[][] {
  const parsed = parseCsvBody(text)
  const header = parsed[0]
  expect(header, 'header row must exist').toBeDefined()
  return parsed.slice(1)
}

describe('the CSV suite shape', () => {
  it('builds exactly the declared files, in canonical order', () => {
    const files = buildCsvSuite(projectionInputFromSnapshot(fixtureSnapshot()))
    expect(files.map((f) => f.filename)).toEqual([...EXPORT_CSV_FILENAMES])
  })

  it('every file starts with a UTF-8 BOM and ends with CRLF', () => {
    for (const file of buildCsvSuite(projectionInputFromSnapshot(fixtureSnapshot()))) {
      expect(file.text.charCodeAt(0)).toBe(0xfeff)
      expect(file.text.endsWith('\r\n')).toBe(true)
    }
  })
})

describe('holdings.csv', () => {
  it('shows live holdings only (tombstones excluded), with identity joined', () => {
    const data = rows(suite()['holdings.csv']!)
    const ids = data.map((r) => r[0])
    expect(ids).toContain(FIXTURE_IDS.holdingVariant)
    expect(ids).not.toContain(FIXTURE_IDS.holdingTombstoned)
    const variantRow = data.find((r) => r[0] === FIXTURE_IDS.holdingVariant)!
    expect(variantRow[1]).toBe('Alcremie ミラブリズム') // unicode survives
    expect(variantRow[4]).toBe('holo · basic')
    // Live quantity = Σ quantity_remaining over non-voided lots of the holding (2 − 1 sold).
    expect(variantRow[10]).toBe('1')
    expect(variantRow[12]).toBe('grail ＋bonus') // leading char safe → untouched
    expect(variantRow[13]).toBe('Binder 1, "core"')
  })

  it('resolves sealed identity from curated + user-created names', () => {
    const data = rows(suite()['holdings.csv']!)
    const sealedRow = data.find((r) => r[0] === FIXTURE_IDS.holdingSealedCurated)!
    expect(sealedRow[1]).toBe('Curated ETB (fixture)')
  })

  it('sanitizes formula-trigger free text in user-controlled cells', () => {
    const data = rows(suite()['holdings.csv']!)
    const manualRow = data.find((r) => r[0] === FIXTURE_IDS.holdingManual)!
    expect(manualRow[9]).toBe("'\tTABSTART") // cert number is free text
  })
})

describe('acquisition_lots.csv', () => {
  it('renders known cost as exact decimal with currency; unknown stays empty', () => {
    const data = rows(suite()['acquisition_lots.csv']!)
    const known = data.find((r) => r[0] === FIXTURE_IDS.lotKnown)!
    expect(known[8]).toBe('90071992547409.93') // >2^53 exact, never float-rounded
    expect(known[9]).toBe('NOK')
    expect(known[11]).toBe('0.00') // genuine zero residual — zero is data

    const gift = data.find((r) => r[0] === FIXTURE_IDS.lotNotPaid)!
    expect(gift[7]).toBe('not_paid')
    expect(gift[8]).toBe('') // unknown basis is empty, NEVER fake zero
    expect(gift[10]).toBe('')
  })

  it('joins storage location names and preserves multi-line notes via quoting', () => {
    const data = rows(suite()['acquisition_lots.csv']!)
    const known = data.find((r) => r[0] === FIXTURE_IDS.lotKnown)!
    expect(known[16]).toBe('Binder α')
    expect(known[20]).toBe('multi\nline note')
  })
})

describe('manual_valuations.csv', () => {
  it('exports the FULL history including superseded rows', () => {
    const data = rows(suite()['manual_valuations.csv']!)
    expect(data).toHaveLength(2)
    const superseded = data.find((r) => r[0] === FIXTURE_IDS.valuationSuperseded)!
    expect(superseded[9]).not.toBe('')
  })
})

describe('purchases.csv / purchase_lines.csv', () => {
  it('carries the frozen FX triple verbatim and neutralizes injection attempts in notes', () => {
    const data = rows(suite()['purchases.csv']!)
    const eur = data.find((r) => r[0] === FIXTURE_IDS.purchaseEur)!
    expect(eur[10]).toBe('11.54000000') // rate text verbatim — rates are not money
    expect(eur[15]).toBe("'=SUM(A1:A9)")
    const nok = data.find((r) => r[0] === FIXTURE_IDS.purchaseNok)!
    expect(nok[2]).toBe("'-Local Store") // leading '-' is a formula trigger → prefixed
    expect(nok[8]).toBe('999.00')
  })

  it('allocates verbatim per line (never recomputed)', () => {
    const data = rows(suite()['purchase_lines.csv']!)
    const card = data.find((r) => r[0] === FIXTURE_IDS.lineCard)!
    expect(card[17]).toBe('949.50')
    const accessory = data.find((r) => r[0] === FIXTURE_IDS.lineAccessory)!
    expect(accessory[5]).toBe("'+TOPLOADER bundle\t")
  })
})

describe('sales.csv / sale_lines.csv / lot_disposals.csv', () => {
  it('keeps negative realized results numeric and unknown results empty', () => {
    const lines = rows(suite()['sale_lines.csv']!)
    const costed = lines.find((r) => r[0] === FIXTURE_IDS.saleLineCosted)!
    expect(costed[16]).toBe('2674.56') // frozen basis, exact
    expect(costed[17]).toBe('-1234.56') // legitimate negative stays numeric
    const uncosted = lines.find((r) => r[0] === FIXTURE_IDS.saleLineUncosted)!
    expect(uncosted[16]).toBe('') // unknown basis — empty, never fake zero
    expect(uncosted[17]).toBe('')
  })

  it('marks voided sales and voided disposals with their timestamps', () => {
    const sales = rows(suite()['sales.csv']!)
    const voided = sales.find((r) => r[0] === FIXTURE_IDS.saleVoided)!
    expect(voided[15]).toBe('2026-04-03T08:00:00+00:00')
    const disposals = rows(suite()['lot_disposals.csv']!)
    const voidedDisposal = disposals.find((r) => r[0] === FIXTURE_IDS.disposalVoided)!
    expect(voidedDisposal[8]).toBe('2026-04-03T08:00:00+00:00')
  })

  it('omits idempotency keys from CSV (they remain in the JSON backup)', () => {
    const salesCsv = suite()['sales.csv']!
    expect(salesCsv).not.toContain('11111111-2222-4333-8444-555555555555')
  })
})

describe('lot_cost_adjustments.csv / custom_collections.csv', () => {
  it('exports adjustments with explicit currency columns', () => {
    const data = rows(suite()['lot_cost_adjustments.csv']!)
    expect(data).toHaveLength(1)
    expect(data[0]![4]).toBe('30.00')
    expect(data[0]![5]).toBe('NOK')
  })

  it('lists member holding ids on the collection row', () => {
    const data = rows(suite()['custom_collections.csv']!)
    expect(data[0]![5]).toBe(FIXTURE_IDS.holdingVariant)
  })
})

describe('empty dataset', () => {
  it('produces header-only files without any fabricated values', () => {
    const empty = fixtureSnapshot()
    const arrayKeys = [
      'holdings',
      'acquisition_lots',
      'manual_valuations',
      'purchases',
      'purchase_lines',
      'sales',
      'sale_lines',
      'lot_disposals',
      'lot_cost_adjustments',
      'custom_collections',
      'custom_collection_members',
      'tags',
      'holding_tags',
    ] as const
    for (const key of arrayKeys) {
      ;(empty as unknown as Record<string, unknown>)[key] = []
    }
    ;(
      empty.identity_manifest as { card_variants: unknown[]; curated_sealed_products: unknown[] }
    ).card_variants = []
    ;(
      empty.identity_manifest as { card_variants: unknown[]; curated_sealed_products: unknown[] }
    ).curated_sealed_products = []
    const files = buildCsvSuite(projectionInputFromSnapshot(empty))
    for (const file of files) {
      expect(parseCsvBody(file.text)).toHaveLength(1) // header only
    }
  })
})
