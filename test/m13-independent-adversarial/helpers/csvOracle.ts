/**
 * Independent CSV oracle: an RFC 4180 writer/parser plus the injection-sanitizer semantics M13's
 * exporters are required to match. Written from OWASP CSV Injection / WSTG 4.7.21 / CWE-1236
 * guidance and PRODUCT_SPEC §4.12 — not from any implementation.
 *
 * The two rules that matter (prompt §7):
 *  1. Safety transformation applies to DANGEROUS TEXT ONLY. Free-text cells get a leading `'`
 *     when their first character is a formula trigger (= + - @ Tab CR LF and the full-width
 *     variants ＋ － ＠ ＝). Excel strips leading whitespace/tab/CR before formula evaluation,
 *     so those are triggers too.
 *  2. Canonical numeric/date/enum/id fields are LITERAL cells and are NEVER transformed.
 *     `-120.50` in a numeric column is a legitimate negative amount; prefixing it would corrupt
 *     exactly the financial analysis this export exists to serve. A cell that parses wholly as
 *     a number is evaluated as a value by spreadsheets, not as a formula.
 */

export type CsvCellKind = 'text' | 'literal'

/** First-character triggers for spreadsheet formula injection (ASCII + full-width). */
export const FORMULA_TRIGGER_PREFIXES: readonly string[] = [
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
  '\n',
  '＋', // U+FF0B FULLWIDTH PLUS SIGN
  '－', // U+FF0D FULLWIDTH HYPHEN-MINUS
  '＠', // U+FF20 FULLWIDTH COMMERCIAL AT
  '＝', // U+FF1D FULLWIDTH EQUALS SIGN
]

export function isFormulaTrigger(value: string): boolean {
  // startsWith over the whole trigger list is code-unit-safe: every trigger here is a single
  // UTF-16 unit at position 0.
  return FORMULA_TRIGGER_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/**
 * TEXT cell sanitizer: prepend a single ASCII apostrophe when the first surviving character is a
 * trigger. Idempotent in the sense that re-running it on already-prefixed output does not double
 * the prefix (`'` is not itself a trigger).
 */
export function sanitizeCsvTextCell(value: string): string {
  if (value.length > 0 && isFormulaTrigger(value)) {
    return `'${value}`
  }
  return value
}

/** Quote a field per RFC 4180: quotes only when required, `""` escaping inside quotes. */
function quoteField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replaceAll('"', '""')}"`
  }
  return field
}

export interface CsvWriterOptions {
  /**
   * Prepend a UTF-8 BOM. REQUIRED for user-facing CSV files here: Excel mis-decodes UTF-8
   * without one, which destroys Japanese card names (the collection is full of them).
   */
  readonly bom?: boolean
  /** Emit the header row as rows[0] when provided separately. */
  readonly header?: readonly string[]
}

/**
 * The ONE canonical writer every exporter must use (no exporter hand-joins strings). Records are
 * CRLF-terminated per RFC 4180 including the final record, so POSIX tools see a terminated last
 * line and byte-diffing exports stays stable.
 */
export function writeCsv(
  rows: readonly (readonly string[])[],
  options: CsvWriterOptions = {},
): string {
  const all = options.header ? [options.header, ...rows] : rows
  const body = all.map((row) => row.map(quoteField).join(',')).join('\r\n')
  const withTerminator = body.length > 0 ? `${body}\r\n` : ''
  return options.bom ? `\uFEFF${withTerminator}` : withTerminator
}

/** Compose sanitize + quote for one text cell. */
export function emitTextCell(value: string): string {
  return quoteField(sanitizeCsvTextCell(value))
}

/**
 * Compose NO sanitization + quote for one literal cell (number/date/enum/uuid). This function
 * existing separately is the point: `-120.50` must survive verbatim.
 */
export function emitLiteralCell(value: string): string {
  return quoteField(value)
}

/**
 * Join ALREADY-RENDERED cells (outputs of emitTextCell/emitLiteralCell) into one record line.
 * Exists so hand-assembled files never re-quote: quoting happens exactly once, either in
 * writeCsv on raw values or at cell level before this join — never both.
 */
export function joinRenderedRow(renderedCells: readonly string[]): string {
  return renderedCells.join(',')
}

// ── An independent reader, used ONLY by property tests to prove writer round-trip ─────────────

/**
 * Minimal strict RFC 4180 reader. Accepts optional BOM, CRLF or LF record separators, quoted
 * fields containing commas/newlines/doubled quotes. Throws on structurally invalid input rather
 * than guessing — a round-trip test against a lenient parser would prove nothing.
 */
export function parseCsv(text: string): string[][] {
  let input = text
  if (input.startsWith('\uFEFF')) {
    input = input.slice(1)
  }
  if (input.length === 0) return []

  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0

  while (i < input.length) {
    const ch = input[i] as string
    if (inQuotes) {
      if (ch === '"') {
        const next = input[i + 1]
        if (next === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r' && input[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      field = ''
      row = []
      i += 2
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      field = ''
      row = []
      i += 1
      continue
    }
    field += ch
    i += 1
  }

  if (inQuotes) {
    throw new Error('parseCsv: unterminated quoted field')
  }
  // Note: no blank-row filtering here. The writer always terminates the last record with CRLF,
  // which leaves field='' and row=[] — the trailing guard above correctly emits nothing extra.
  return rows
}
