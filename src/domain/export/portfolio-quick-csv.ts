/**
 * The Portfolio "Quick CSV" (M7.1 §46-47): the CURRENT filtered Portfolio view as one
 * spreadsheet-friendly file. A report, not a backup and not the M13 suite — one row per holding,
 * with the resolved current value in NOK when (and only when) one exists.
 *
 * It goes through the same writer as the M13 suite (csv.ts): UTF-8 BOM, CRLF, RFC 4180 quoting,
 * kind-driven formula sanitization. Money is rendered from the exact integer minor units the
 * server returned — never `Number(minor) / 100` — so a value past 2^53 is written digit for
 * digit, and an absent value is an empty cell, never `0.00`.
 *
 * Schema v2 (P157). v1 was the released M7.1 file; what changed, and why, is in
 * docs/DATA_MODEL.md "Export schemas": the mislabelled `Cost basis state` column is now
 * `Value status` (its only content is a value-state note, never a cost basis), and the file gained
 * a BOM, a terminating CRLF and formula/CR-safe cells.
 */
import { buildTypedCsvText, csvMoney, type CsvColumn } from './csv'

export const QUICK_PORTFOLIO_CSV_SCHEMA_VERSION = 2

export const QUICK_PORTFOLIO_CSV_COLUMNS = [
  { header: 'Card name', kind: 'text' },
  { header: 'Set', kind: 'text' },
  { header: 'Collector number', kind: 'text' },
  { header: 'Quantity', kind: 'integer' },
  { header: 'Condition', kind: 'text' },
  { header: 'Variant', kind: 'text' },
  { header: 'Grade', kind: 'decimal' },
  { header: 'Storage', kind: 'text' },
  { header: 'Value status', kind: 'text' },
  { header: 'Current value (NOK)', kind: 'money' },
] as const satisfies readonly CsvColumn[]

/** One Portfolio holding, already resolved to display strings by the data layer. */
export interface QuickPortfolioRow {
  readonly cardName: string
  readonly setName: string
  readonly collectorNumber: string
  readonly quantity: number
  readonly condition: string
  readonly variant: string
  readonly grade: number | null
  readonly storage: string
  /** A short state note; empty when there is nothing to say. Never a cost basis. */
  readonly valueStatus: string
  /** Holding value in NOK minor units (ører), exact. `null` = no resolvable value, not zero. */
  readonly valueNokMinor: bigint | null
}

export function buildQuickPortfolioCsv(rows: readonly QuickPortfolioRow[]): string {
  return buildTypedCsvText(
    QUICK_PORTFOLIO_CSV_COLUMNS,
    rows.map((row) => [
      row.cardName,
      row.setName,
      row.collectorNumber,
      String(row.quantity),
      row.condition,
      row.variant,
      row.grade === null ? null : String(row.grade),
      row.storage,
      row.valueStatus,
      row.valueNokMinor === null ? null : csvMoney(row.valueNokMinor.toString(), 'NOK'),
    ]),
  )
}
