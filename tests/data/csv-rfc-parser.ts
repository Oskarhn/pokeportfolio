/**
 * An independent RFC 4180 reader for the export test suites. Unlike `parseCsvBody` in
 * export-fixtures.ts it understands CRLF and LF INSIDE quoted fields, which is exactly what the
 * "no free-text value can shift a row or a column" invariants need. Written separately from the
 * writer under test so the two implementations cross-check each other.
 *
 * Dialect: comma delimiter, double-quote quoting with "" escaping. Record terminators OUTSIDE
 * quotes are modelled the way spreadsheets treat them: CRLF, a bare CR and a bare LF all end a
 * record (Excel was observed splitting a row on a bare CR). A writer that leaves a CR or LF
 * unquoted therefore shows up as extra records, which is exactly the row-shift defect under test.
 */

export interface ParsedCsv {
  /** Records without the UTF-8 BOM, header first. */
  readonly records: string[][]
  readonly hadBom: boolean
  readonly endsWithCrlf: boolean
}

export function parseCsvRfc(text: string): ParsedCsv {
  const hadBom = text.codePointAt(0) === 0xfeff
  const body = hadBom ? text.slice(1) : text
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let fieldOpen = false // a field has started (so a trailing empty field is still emitted)

  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i)
    if (inQuotes) {
      if (char === '"') {
        if (body.charAt(i + 1) === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '' && !fieldOpen) {
      inQuotes = true
      fieldOpen = true
      continue
    }
    if (char === ',') {
      record.push(field)
      field = ''
      fieldOpen = false
      continue
    }
    if (char === '\r' || char === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      fieldOpen = false
      if (char === '\r' && body.charAt(i + 1) === '\n') i++
      continue
    }
    field += char
    fieldOpen = true
  }
  if (inQuotes) throw new Error('CSV ended inside a quoted field')
  const endsWithCrlf = body.endsWith('\r\n')
  if (field !== '' || record.length > 0 || fieldOpen) {
    record.push(field)
    records.push(record)
  }
  return { records, hadBom, endsWithCrlf }
}
