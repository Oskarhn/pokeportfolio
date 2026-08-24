/**
 * RFC 4180 CSV writing and spreadsheet-formula-injection defence (M13).
 *
 * ONE canonical writer — every exporter builds its files through this module and hand-joins
 * nothing. Files are UTF-8 WITH BOM (Excel + Japanese card names make the BOM non-negotiable),
 * CRLF line endings, always a header row, minimal quoting (quote only fields containing comma,
 * quote, CR or LF), doubled quotes inside quoted fields, terminating CRLF.
 *
 * Injection policy (OWASP CSV Injection / WSTG 4.7.21 / CWE-1236): free-text user-controlled
 * cells get a `'` prefix when their FIRST character is a formula trigger (=, +, -, @, tab, CR,
 * LF or the full-width ＝＋－＠ equivalents). Canonical numeric/date/enum/id cells are NEVER
 * prefixed — a cell that parses wholly as a number is parsed as a value by spreadsheets, so
 * prefixing would corrupt exactly the legitimate negative amounts (-12 345 øre realized result)
 * this export exists to analyse. This narrowing of OWASP's blunt rule is deliberate and tested;
 * the residual risk (sanitization that survives every spreadsheet's save/reopen cycle does not
 * exist) is accepted for a self-export threat model with no attacker-controlled import path.
 */
import { getCurrencyMeta, isSupportedCurrencyCode } from '../currency'

/** UTF-8 byte-order mark, prepended once per file so Excel detects the encoding. */
export const CSV_BOM = '\uFEFF'

const FORMULA_TRIGGER_FIRST_CHARS = new Set([
  '=',
  '+',
  '-',
  '@',
  '	',
  '\r',
  '\n',
  '＝',
  '＋',
  '－',
  '＠',
])

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
 * Prefixes a free-text cell with `'` when its first character could be read as a formula by a
 * spreadsheet. Apply to USER-CONTROLLED TEXT columns only (names, notes, descriptions,
 * marketplaces, retailer names, cert numbers); canonical numeric/date/enum/id columns must not
 * pass through here or legitimate negatives would be corrupted into text.
 */
export function sanitizeCsvFreeText(value: string): string {
  const first = value.charAt(0)
  return FORMULA_TRIGGER_FIRST_CHARS.has(first) ? `'${value}` : value
}

/** Free-text cell: null → empty field, otherwise sanitized then structurally escaped downstream. */
export function csvFreeText(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : sanitizeCsvFreeText(value)
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
