import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { csvMoney, isCanonicalCsvValue } from '../../src/domain/export/csv'
import {
  buildCsvSuite,
  buildPurchaseLinesCsv,
  buildSaleLinesCsv,
  EXPORT_CSV_FILENAMES,
  EXPORT_CSV_SCHEMA,
  EXPORT_CSV_SCHEMA_VERSION,
  projectionInputFromSnapshot,
} from '../../src/domain/export/csv-projections'
import { minorUnits } from '../../src/domain/export/backup-format'
import { parseCsvRfc } from './csv-rfc-parser'
import { fixtureSnapshot } from './export-fixtures'

/**
 * P157 — money exactness at the CSV boundary and the versioned column schema.
 *
 * The expected values here are computed WITHOUT the production formatter: hand-verified literals
 * plus a reconstruction oracle (digits of the cell → BigInt → must equal the integer minor units
 * that went in), so a formatter that rounds, floats or mis-places the decimal point cannot agree
 * with itself.
 */

const EXPONENT: Record<string, number> = { NOK: 2, EUR: 2, USD: 2, GBP: 2, JPY: 0 }

/** Reads a rendered money cell back into integer minor units, exactly. */
function reconstruct(cell: string, exponent: number): bigint {
  const negative = cell.startsWith('-')
  const body = negative ? cell.slice(1) : cell
  const [whole = '', fraction = ''] = body.split('.')
  expect(fraction).toHaveLength(exponent) // exponent-aware: 2 decimals, or none for JPY
  const magnitude =
    BigInt(whole) * 10n ** BigInt(exponent) + (fraction === '' ? 0n : BigInt(fraction))
  return negative ? -magnitude : magnitude
}

describe('money cells are exact integer-minor-unit decimals', () => {
  it.each([
    ['0', 'NOK', '0.00'],
    ['1', 'NOK', '0.01'],
    ['-1', 'NOK', '-0.01'],
    ['12345', 'NOK', '123.45'],
    ['-12345', 'EUR', '-123.45'],
    ['9007199254740991', 'NOK', '90071992547409.91'], // 2^53 - 1
    ['9007199254740992', 'NOK', '90071992547409.92'], // 2^53
    ['9007199254740993', 'NOK', '90071992547409.93'], // 2^53 + 1 — the value a float cannot hold
    ['288230376151711744', 'USD', '2882303761517117.44'], // 2^58
    ['9223372036854775807', 'EUR', '92233720368547758.07'], // bigint max
    ['-9223372036854775808', 'NOK', '-92233720368547758.08'], // bigint min
    ['0', 'JPY', '0'],
    ['-500', 'JPY', '-500'],
    ['9007199254740993', 'JPY', '9007199254740993'],
    ['9223372036854775807', 'JPY', '9223372036854775807'],
  ])('%s %s → %s', (minor, currency, expected) => {
    expect(csvMoney(minor, currency)).toBe(expected)
  })

  it('every int64 value survives digit-for-digit in every supported currency (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
        fc.constantFrom('NOK', 'EUR', 'USD', 'GBP', 'JPY'),
        (minor, currency) => {
          const cell = csvMoney(minor.toString(), currency)
          expect(isCanonicalCsvValue('money', cell)).toBe(true)
          expect(reconstruct(cell, EXPONENT[currency] ?? -1)).toBe(minor)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('values around 2^53 and 2^58 are exact to the last digit, both signs (property)', () => {
    const anchors = [2n ** 53n, 2n ** 58n, 2n ** 62n]
    fc.assert(
      fc.property(
        fc.constantFrom(...anchors),
        fc.integer({ min: -1000, max: 1000 }),
        fc.boolean(),
        (anchor, delta, negative) => {
          const minor = (anchor + BigInt(delta)) * (negative ? -1n : 1n)
          expect(reconstruct(csvMoney(minor.toString(), 'NOK'), 2)).toBe(minor)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('refuses input that is not integer minor units instead of rounding it', () => {
    expect(() => csvMoney('90071992547409.93', 'NOK')).toThrow()
    expect(() => csvMoney('1e21', 'NOK')).toThrow()
    expect(() => csvMoney('NaN', 'NOK')).toThrow()
  })

  it('unknown is empty, known zero is 0.00 — never conflated', () => {
    expect(csvMoney(null, 'NOK')).toBe('')
    expect(csvMoney(undefined, 'NOK')).toBe('')
    expect(csvMoney('0', 'NOK')).toBe('0.00')
    expect(csvMoney('0', 'JPY')).toBe('0')
  })
})

describe('exactness and honesty through the real suite', () => {
  function cellsByHeader(file: string, text: string): Record<string, string>[] {
    const [header, ...rows] = parseCsvRfc(text).records
    if (!header) throw new Error(`${file} has no header`)
    return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])))
  }

  it('renders extreme, negative, zero and unknown amounts from a real snapshot', () => {
    const snapshot = structuredClone(fixtureSnapshot())
    const sale = snapshot.sales[0]
    const saleLines = snapshot.sale_lines
    if (!sale || saleLines.length < 2) throw new Error('fixture shape changed')
    // A loss-making, non-NOK sale: negative net proceeds in the sale currency.
    sale.currency = 'EUR'
    sale.net_proceeds_minor = minorUnits('-12345')
    sale.gross_minor = minorUnits('9007199254740993')
    sale.realized_result_nok_minor = minorUnits('-9223372036854775808')
    const [costed, uncosted] = saleLines
    if (!costed || !uncosted) throw new Error('fixture shape changed')
    costed.cost_basis_at_sale_nok_minor = minorUnits('0') // a known zero basis
    uncosted.cost_basis_at_sale_nok_minor = null // unknown basis
    uncosted.realized_result_nok_minor = null

    const input = projectionInputFromSnapshot(snapshot)
    const salesRow = cellsByHeader('sales.csv', buildCsvSuite(input)[5]?.text ?? '').find(
      (r) => r['Sale ID'] === sale.id,
    )
    expect(salesRow?.['Net proceeds']).toBe('-123.45')
    expect(salesRow?.['Gross']).toBe('90071992547409.93')
    expect(salesRow?.['Realized result NOK']).toBe('-92233720368547758.08')

    const lines = cellsByHeader('sale_lines.csv', buildSaleLinesCsv(input).text)
    expect(lines.find((r) => r['Line ID'] === costed.id)?.['Cost basis NOK']).toBe('0.00')
    expect(lines.find((r) => r['Line ID'] === uncosted.id)?.['Cost basis NOK']).toBe('')
    expect(lines.find((r) => r['Line ID'] === uncosted.id)?.['Realized result NOK']).toBe('')
  })

  it('a JPY purchase renders in whole yen with its currency in the same row (100x guard)', () => {
    const snapshot = structuredClone(fixtureSnapshot())
    const purchase = snapshot.purchases[0]
    const line = snapshot.purchase_lines.find((l) => l.purchase_id === purchase?.id)
    if (!purchase || !line) throw new Error('fixture shape changed')
    purchase.currency = 'JPY'
    line.unit_price_minor = minorUnits('500')
    line.line_total_minor = minorUnits('500')
    const rows = cellsByHeader(
      'purchase_lines.csv',
      buildPurchaseLinesCsv(projectionInputFromSnapshot(snapshot)).text,
    )
    const row = rows.find((r) => r['Line ID'] === line.id)
    expect(row?.['Unit price']).toBe('500') // 500 yen, not 5.00
    expect(row?.['Currency']).toBe('JPY')
  })

  it('purchase_lines and sale_lines carry the parent currency as their last column (schema v2)', () => {
    const input = projectionInputFromSnapshot(fixtureSnapshot())
    for (const [builder, schemaFile] of [
      [buildPurchaseLinesCsv, 'purchase_lines.csv'],
      [buildSaleLinesCsv, 'sale_lines.csv'],
    ] as const) {
      const columns = EXPORT_CSV_SCHEMA[schemaFile]
      expect(columns.at(-1)).toEqual({ header: 'Currency', kind: 'enum' })
      const parsed = parseCsvRfc(builder(input).text)
      expect(parsed.records.length).toBeGreaterThan(1)
      for (const record of parsed.records.slice(1)) {
        expect(record.at(-1)).toMatch(/^[A-Z]{3}$/)
      }
    }
  })
})

describe('the CSV schema is versioned and pinned', () => {
  it('has a version and covers exactly the declared files', () => {
    expect(EXPORT_CSV_SCHEMA_VERSION).toBe(2)
    expect(Object.keys(EXPORT_CSV_SCHEMA)).toEqual([...EXPORT_CSV_FILENAMES])
  })

  it('golden: every header and kind of every file (a change here must be deliberate)', () => {
    const golden = Object.fromEntries(
      Object.entries(EXPORT_CSV_SCHEMA).map(([file, columns]) => [
        file,
        columns.map((c) => `${c.header}:${c.kind}`).join(' | '),
      ]),
    )
    expect(golden).toMatchInlineSnapshot(`
      {
        "acquisition_lots.csv": "Lot ID:id | Holding ID:id | Card:text | Set:text | Number:text | Variant:text | Origin:enum | Cost basis state:enum | Unit cost:money | Currency:enum | Unit cost NOK:money | Residual:money | Residual NOK:money | Quantity:integer | Quantity remaining:integer | Sealed intent:enum | Storage location:text | Purchase line ID:id | Acquired on:date | Voided at:timestamp | Notes:text | Created at:timestamp",
        "custom_collections.csv": "Collection ID:id | Name:text | Description:text | Colour:text | Sort order:integer | Member holding IDs:text | Created at:timestamp",
        "holdings.csv": "Holding ID:id | Card:text | Set:text | Number:text | Variant:text | Kind:enum | Condition:enum | Grade:decimal | Grader:enum | Cert number:text | Live quantity:integer | Favourite:boolean | Tags:text | Collections:text | Notes:text | Created at:timestamp | Updated at:timestamp",
        "lot_cost_adjustments.csv": "Adjustment ID:id | Lot ID:id | Kind:enum | Occurred on:date | Amount:money | Currency:enum | Amount NOK:money | Note:text | Purchase line ID:id | Created at:timestamp",
        "lot_disposals.csv": "Disposal ID:id | Lot ID:id | Card:text | Kind:enum | Disposed on:date | Quantity:integer | Cost basis NOK:money | Sale line ID:id | Voided at:timestamp | Created at:timestamp",
        "manual_valuations.csv": "Valuation ID:id | Holding ID:id | Card:text | Set:text | Effective from:date | Value:money | Currency:enum | Value NOK:money | Note:text | Superseded at:timestamp | Created at:timestamp",
        "openings.csv": "Opening ID:id | Date:date | Product:text | Quantity:integer | Opening cost NOK:money | Cost source:enum | Tracking completeness:enum | Bulk remainder estimate NOK:money | Bulk remainder count:integer | Purchase provenance:enum | Reconciliation:enum | Voided at:timestamp | Notes:text | Created at:timestamp",
        "purchase_lines.csv": "Line ID:id | Purchase ID:id | Purchased on:date | Line type:enum | Spend class:enum | Description:text | Card:text | Set:text | Number:text | Variant:text | Condition:enum | Quantity:integer | Unit price:money | Line total:money | Allocated shipping:money | Allocated customs:money | Allocated discount:money | Attributable cost:money | Attributable cost NOK:money | Created at:timestamp | Currency:enum",
        "purchases.csv": "Purchase ID:id | Purchased on:date | Retailer:text | Currency:enum | Subtotal:money | Shipping:money | Customs:money | Discount:money | Total:money | Total NOK:money | FX rate to NOK:rate | FX rate date:date | FX source:enum | Origin:enum | Voided at:timestamp | Notes:text | Created at:timestamp | Updated at:timestamp",
        "sale_lines.csv": "Line ID:id | Sale ID:id | Sold on:date | Lot ID:id | Card:text | Set:text | Number:text | Variant:text | Quantity:integer | Unit gross:money | Line gross:money | Allocated fees:money | Allocated shipping:money | Allocated shipping charged:money | Net proceeds:money | Net proceeds NOK:money | Cost basis NOK:money | Realized result NOK:money | Created at:timestamp | Currency:enum",
        "sales.csv": "Sale ID:id | Sold on:date | Marketplace:text | Currency:enum | Gross:money | Fees:money | Shipping cost:money | Shipping charged:money | Net proceeds:money | Net proceeds NOK:money | Realized result NOK:money | Proceeds from uncosted NOK:money | FX rate to NOK:rate | FX rate date:date | FX source:enum | Voided at:timestamp | Notes:text | Created at:timestamp | Updated at:timestamp",
      }
    `)
  })

  it('every non-text cell the real exporter writes has its declared canonical shape', () => {
    // A mis-declared kind would silently fall back to text sanitization; this makes that loud.
    for (const file of buildCsvSuite(projectionInputFromSnapshot(fixtureSnapshot()))) {
      const name = file.filename as (typeof EXPORT_CSV_FILENAMES)[number]
      const schema = EXPORT_CSV_SCHEMA[name]
      for (const record of parseCsvRfc(file.text).records.slice(1)) {
        record.forEach((cell, index) => {
          const column = schema[index]
          if (!column || column.kind === 'text' || cell === '') return
          expect(
            isCanonicalCsvValue(column.kind, cell),
            `${name} › ${column.header} (${column.kind}) = ${JSON.stringify(cell)}`,
          ).toBe(true)
        })
      }
    }
  })

  it('column order is stable: file headers equal the declared schema for empty input too', () => {
    const empty = buildCsvSuite(
      projectionInputFromSnapshot({
        ...structuredClone(fixtureSnapshot()),
        holdings: [],
        acquisition_lots: [],
        manual_valuations: [],
        openings: [],
        purchases: [],
        purchase_lines: [],
        sales: [],
        sale_lines: [],
        lot_disposals: [],
        lot_cost_adjustments: [],
        custom_collections: [],
        custom_collection_members: [],
        tags: [],
        holding_tags: [],
      }),
    )
    for (const file of empty) {
      const name = file.filename as (typeof EXPORT_CSV_FILENAMES)[number]
      const parsed = parseCsvRfc(file.text)
      expect(parsed.records).toEqual([EXPORT_CSV_SCHEMA[name].map((c) => c.header)])
      expect(parsed.hadBom).toBe(true)
      expect(parsed.endsWithCrlf).toBe(true)
    }
  })
})
