/**
 * ACTIVE pure-oracle tests: money exactness, NULL honesty, timestamp precision, Unicode and
 * deterministic ordering semantics for the M13 JSON backup (prompt sections 5/6/14).
 *
 * Every assertion here is a semantic statement about the REQUIRED behavior of any conforming
 * implementation, exercised through the oracle helpers. The implementation-gated suite later
 * checks real modules against the same table of cases.
 */
import { describe, expect, it } from 'vitest'

import {
  BEYOND_SAFE_INTEGER,
  NULL_HONESTY_CASES,
  TIMESTAMP_PRECISION_CASES,
  corruptViaJsonNumber,
  serializeMinorUnits,
  timestampPrecisionLoss,
  timestampWouldSurviveDateRoundTrip,
} from '../helpers/moneyOracle.ts'
import { NEGATIVE_LEGAL_MONEY_COLUMNS, mustExportTables } from '../helpers/inventory.ts'

describe('money serialization oracle', () => {
  it('carries minor units as decimal STRINGS so BigInt values survive any JSON parser', () => {
    // Ordinary magnitudes.
    expect(serializeMinorUnits(120_500n)).toBe('120500')
    expect(serializeMinorUnits(-12_050n)).toBe('-12050')
    // Genuine zero is data.
    expect(serializeMinorUnits(0n)).toBe('0')
    // Beyond double precision: string encoding is lossless where numbers are not.
    expect(serializeMinorUnits(BEYOND_SAFE_INTEGER)).toBe('9007199254740993')
  })

  it('demonstrates the corruption a number-encoded pipeline silently commits', () => {
    expect(corruptViaJsonNumber(BEYOND_SAFE_INTEGER)).toBe(9_007_199_254_740_992n)
    expect(corruptViaJsonNumber(BEYOND_SAFE_INTEGER)).not.toBe(BEYOND_SAFE_INTEGER)
  })

  it('permits negative values ONLY on sales-side columns (domain legality, not sanitization)', () => {
    const legal = NEGATIVE_LEGAL_MONEY_COLUMNS
    expect(legal.has('sales.net_proceeds_minor')).toBe(true)
    expect(legal.has('sale_lines.realized_result_nok_minor')).toBe(true)
    // ...and nowhere else:
    expect(legal.size).toBe(6)
  })

  it('keeps negative sale results verbatim in the required representation', () => {
    const caseRow = NULL_HONESTY_CASES.find((c) => c.storedSqlValue === 'NEGATIVE')
    expect(caseRow).toBeDefined()
    expect(caseRow?.requiredRepresentation).toBe('negative-number')
    // -12050 NOK on net_proceeds_minor is legitimate; serializeMinorUnits must not mangle it.
    expect(serializeMinorUnits(-12_050n)).toBe('-12050')
  })
})

describe('NULL honesty oracle (invariant M1)', () => {
  it('requires null to stay null and zero to stay zero — never interchanged', () => {
    for (const c of NULL_HONESTY_CASES) {
      if (c.storedSqlValue === 'NULL') {
        expect(c.requiredRepresentation, c.name).toBe('null')
      }
      if (c.storedSqlValue === '0') {
        expect(c.requiredRepresentation, c.name).toBe('zero')
      }
      if (c.storedSqlValue === 'NEGATIVE') {
        expect(c.requiredRepresentation, c.name).toBe('negative-number')
      }
    }
  })

  it('names the canonical absent-basis cases a restore author would discover missing', () => {
    const names = NULL_HONESTY_CASES.map((c) => c.columnExample)
    expect(names).toContain('acquisition_lots.unit_cost_basis_minor') // gift / unknown lots
    expect(names).toContain('sale_lines.cost_basis_at_sale_nok_minor') // unknown-basis disposal
  })
})

describe('timestamp precision oracle', () => {
  it('flags the microsecond case as REAL precision loss under a Date round-trip', () => {
    const micro = TIMESTAMP_PRECISION_CASES.find((c) => c.name === 'microseconds')
    expect(micro).toBeDefined()
    expect(timestampWouldSurviveDateRoundTrip(micro!.wire)).toBe(false)
    expect(timestampPrecisionLoss(micro!.wire)).toBe(true)
  })

  it('classifies whole-second reformatting (.000 suffix) as formatting, not data loss', () => {
    const whole = TIMESTAMP_PRECISION_CASES.find((c) => c.name === 'whole seconds')
    // A strict string comparison fails (toISOString appends .000) — but no information is lost.
    expect(timestampWouldSurviveDateRoundTrip(whole!.wire)).toBe(false)
    expect(timestampPrecisionLoss(whole!.wire)).toBe(false)
  })

  it('keeps the millisecond format byte-identical through a Date round-trip', () => {
    const millis = TIMESTAMP_PRECISION_CASES.find((c) => c.name === 'milliseconds')
    expect(timestampWouldSurviveDateRoundTrip(millis!.wire)).toBe(true)
    expect(timestampPrecisionLoss(millis!.wire)).toBe(false)
  })
})

describe('backup section contract (prompt section 5)', () => {
  it('requires EVERY MUST_EXPORT table as its own section - empty array, never omitted', () => {
    const tables = mustExportTables().map((s) => s.table)
    // A missing section is ambiguous with "user had none"; restore cannot take that risk.
    expect(tables.length).toBeGreaterThanOrEqual(18)
    expect(new Set(tables).size).toBe(tables.length)
  })
})

describe('Unicode survival oracle', () => {
  it('preserves Norwegian characters, Japanese card names and emoji byte-exactly through JSON', () => {
    const hostile = '\u00C6\u00D8\u00C5 \u30DD\u30B1\u30E2\u30F3 \u{1F3B4} "quoted"'
    const round = JSON.parse(JSON.stringify({ v: hostile })) as { v: string }
    expect(round.v).toBe(hostile)
  })
})
