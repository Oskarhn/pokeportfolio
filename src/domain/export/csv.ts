/**
 * RFC 4180 CSV writing and spreadsheet-formula-injection defence (M13).
 *
 * ONE canonical writer — every exporter builds its files through this module and hand-joins
 * nothing. Files are UTF-8 WITH BOM (Excel + Japanese card names make the BOM non-negotiable),
 * CRLF line endings, always a header row, minimal quoting (quote only fields containing comma,
 * quote, CR or LF), doubled quotes inside quoted fields, terminating CRLF.
 *
 * Injection policy (OWASP CSV Injection / WSTG 4.7.21 / CWE-1236): a cell is written according
 * to the DECLARED KIND OF ITS COLUMN ({@link buildTypedCsvText}), never according to what a call
 * site remembered to do. Free-text (`text`) columns get a `'` prefix when the first character a
 * spreadsheet would not skip — after any leading whitespace, control or invisible characters — is
 * a formula trigger (=, +, -, @ or the full-width ＝＋－＠), and also when the very first
 * character is a tab, CR or LF. Canonical kinds (id, date, timestamp, enum, integer, decimal,
 * money, rate, boolean) are written verbatim ONLY when the value has that kind's canonical
 * shape; a value that does not is treated as free text and sanitized (fail closed).
 *
 * A cell that parses wholly as a number is a value to spreadsheets, so numeric columns are never
 * prefixed — that keeps legitimate negative amounts (a -123.45 realized result) signed and
 * numeric — while attacker-controlled text such as "-1+2" or "-5" in a TEXT column is prefixed
 * even when it looks numeric. The prefix is a presentation convention of the CSV only: the JSON
 * backup and the database keep the raw text. No claim is made that every spreadsheet product or
 * version is safe; the residual risk is recorded in docs/SECURITY.md.
 */
import { getCurrencyMeta, isSupportedCurrencyCode } from '../currency'

/** UTF-8 byte-order mark, prepended once per file so Excel detects the encoding. */
export const CSV_BOM = '\uFEFF'

/** ASCII =, +, -, @ and their full-width forms (U+FF1D, U+FF0B, U+FF0D, U+FF20). */
const FORMULA_TRIGGERS: ReadonlySet<number> = new Set([
  0x3d, 0x2b, 0x2d, 0x40, 0xff1d, 0xff0b, 0xff0d, 0xff20,
])

/** Tab, LF, CR: dangerous as the very first character even without a trigger after them. */
const BREAK_FIRST_CHARS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d])

/**
 * Characters a spreadsheet import may skip before deciding that a cell is a formula: every
 * Unicode White_Space, separator (Z*), control (Cc: NUL, tab, CR, LF, VT, FF, C1) and format (Cf:
 * soft hyphen, zero-width and bidi marks, word joiner, invisible operators, BOM/ZWNBSP)
 * character. Deliberately a category, not a hand-picked list: prefixing a cell that did not
 * need it costs one visible apostrophe, while missing one costs a formula.
 */
const IGNORABLE_LEADING_CHAR = /[\p{White_Space}\p{Z}\p{Cc}\p{Cf}]/u

/** Quotes a single CSV field per RFC 4180. Structural only — no injection logic here. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** A full CSV record: fields joined with commas. */
export function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',')
}

/**
 * Builds one complete CSV file body: header row, then data rows, CRLF-separated and
 * CRLF-terminated, with the UTF-8 BOM prefix. Pure — returns a JS string.
 */
export function buildCsvText(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [csvRow(header), ...rows.map(csvRow)]
  return CSV_BOM + lines.join('\r\n') + '\r\n'
}

/**
 * Prefixes a free-text cell with `'` when a spreadsheet could read it as a formula: its first
 * character is a tab/CR/LF, or the first character after any leading whitespace, control or
 * invisible characters is a formula trigger. Idempotent — the prefix itself is not a trigger.
 * Apply to TEXT only; canonical numeric cells must never pass through here or legitimate
 * negatives would become text (see {@link buildTypedCsvText}, which decides per column kind).
 */
export function sanitizeCsvFreeText(value: string): string {
  let atStart = true
  for (const symbol of value) {
    const codePoint = symbol.codePointAt(0) ?? 0
    if (atStart && BREAK_FIRST_CHARS.has(codePoint)) return `'${value}`
    atStart = false
    if (FORMULA_TRIGGERS.has(codePoint)) return `'${value}`
    if (!IGNORABLE_LEADING_CHAR.test(symbol)) return value
  }
  return value
}

/** Free-text cell: null → empty field, otherwise sanitized then structurally escaped downstream. */
export function csvFreeText(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : sanitizeCsvFreeText(value)
}

/**
 * What a CSV column contains. The kind — not the call site — decides how a cell is written:
 *
 * - `text` free text of any origin (user, provider, catalog): always sanitized.
 * - `id` / `date` / `timestamp` / `enum` / `boolean` / `integer` / `decimal` / `money` / `rate`
 *   canonical values: written verbatim only if they match their canonical shape, else sanitized
 *   as text. `money` is an exact major-unit decimal rendered from integer minor units; `decimal`
 *   is a non-money number (a grade); `rate` is a non-money stored numeric (an FX rate).
 */
export type CsvColumnKind =
  | 'text'
  | 'id'
  | 'date'
  | 'timestamp'
  | 'enum'
  | 'boolean'
  | 'integer'
  | 'decimal'
  | 'money'
  | 'rate'

export interface CsvColumn {
  readonly header: string
  readonly kind: CsvColumnKind
}

/** A raw cell value: `null`/`undefined` mean "absent" and render as an empty field. */
export type CsvCellValue = string | null | undefined

const CANONICAL_SHAPE: Record<Exclude<CsvColumnKind, 'text'>, RegExp> = {
  id: /^[A-Za-z0-9][A-Za-z0-9-]*$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/,
  enum: /^[A-Za-z][A-Za-z0-9_]*$/,
  boolean: /^(?:true|false)$/,
  integer: /^-?\d+$/,
  decimal: /^-?\d+(?:\.\d+)?$/,
  money: /^-?\d+(?:\.\d+)?$/,
  rate: /^\d+(?:\.\d+)?$/,
}

/** Whether a value has the canonical shape of a non-text kind (text has no canonical shape). */
export function isCanonicalCsvValue(kind: CsvColumnKind, value: string): boolean {
  return kind !== 'text' && CANONICAL_SHAPE[kind].test(value)
}

/**
 * The single place a raw value becomes a CSV cell string (before RFC 4180 quoting). Absent →
 * empty; a canonical kind with a canonical value → verbatim; everything else → sanitized text.
 */
export function renderCsvCell(kind: CsvColumnKind, value: CsvCellValue): string {
  if (value === null || value === undefined) return ''
  return isCanonicalCsvValue(kind, value) ? value : sanitizeCsvFreeText(value)
}

/**
 * Builds one complete CSV file from declared columns and RAW row values. Every row must have
 * exactly one value per column — a short or long row would silently shift cells, so it throws.
 * Header labels are static code, but pass through the same text rule so no column can ever be
 * declared with a formula-shaped label. Same framing as {@link buildCsvText}: UTF-8 BOM, CRLF,
 * terminating CRLF.
 */
export function buildTypedCsvText(
  columns: readonly CsvColumn[],
  rows: readonly (readonly CsvCellValue[])[],
): string {
  const lines = [csvRow(columns.map((column) => sanitizeCsvFreeText(column.header)))]
  for (const [index, row] of rows.entries()) {
    if (row.length !== columns.length) {
      throw new Error(
        `CSV row ${String(index + 1)} has ${String(row.length)} cells; the schema declares ` +
          `${String(columns.length)} columns`,
      )
    }
    lines.push(csvRow(columns.map((column, i) => renderCsvCell(column.kind, row[i]))))
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n'
}

/**
 * Renders exact integer minor units as a plain decimal string using the currency's minor-unit
 * exponent ("57123" NOK → "571.23"; JPY exponent 0 → whole units, no decimal point). Unknown
 * ISO-shaped currency codes fall back to the ISO 4217 default exponent of 2 — the app's own
 * write paths restrict currencies to the supported table, so this fallback exists for external
 * robustness, not as a silent conversion.
 */
export function formatMinorUnitsAsDecimal(minor: string, currencyCode: string): string {
  const minorUnits = BigInt(minor) // exact — never goes through a float
  const exponent = isSupportedCurrencyCode(currencyCode)
    ? getCurrencyMeta(currencyCode).minorUnitExponent
    : 2
  return renderWithExponent(minorUnits, exponent)
}

function renderWithExponent(minorUnits: bigint, exponent: number): string {
  const negative = minorUnits < 0n
  const digits = (negative ? -minorUnits : minorUnits).toString().padStart(exponent + 1, '0')
  const splitAt = digits.length - exponent
  const sign = negative ? '-' : ''
  return exponent > 0
    ? `${sign}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`
    : `${sign}${digits}`
}

/** Money cell for a known-currency column: null → empty (absent, never fake 0); zero → "0.00". */
export function csvMoney(minor: string | null | undefined, currencyCode: string): string {
  if (minor === null || minor === undefined) return ''
  return formatMinorUnitsAsDecimal(minor, currencyCode)
}

/** Money cell where the currency travels in its own column of the same row. */
export function csvMoneyWithCurrency(
  minor: string | null,
  currency: string | null,
): { amount: string; currency: string } {
  return {
    amount: minor === null || currency === null ? '' : formatMinorUnitsAsDecimal(minor, currency),
    currency: currency ?? '',
  }
}

/**
 * FX rate cell: rates are NOT money (FINANCIAL_MODEL.md §1) — emitted verbatim as stored
 * numeric text, never reformatted, never converted.
 */
export function csvFxRate(rateText: string | null): string {
  return rateText ?? ''
}

export function csvBoolean(value: boolean): string {
  return value ? 'true' : 'false'
}
