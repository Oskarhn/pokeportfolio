/**
 * Structured collector-number parse result (P85 §8). Wraps `parseCollectorNumber`
 * (collector-number.ts) with a NORMALIZED canonical form and a PARSE_CONFIDENCE band, so a bare
 * structural parse success ("Z7", "X2" — one generic letter plus a digit or two, no total, no
 * recognized set-code shape) is never treated as equally trustworthy as a real printed id
 * ("049/197", "TG01/TG30"). This does not change matching — `engine.ts`'s own scoring is
 * untouched — it exists so the OCR ROI-candidate scorer (analyze.ts) and the debug panel can
 * tell "parses, and looks like a real id" apart from "parses, but could easily be noise."
 */
import { parseCollectorNumber } from './collector-number'
import type { ParsedCollectorNumber } from './types'

export type CollectorParseConfidence = 'high' | 'medium' | 'low' | 'none'

export interface CollectorNumberParseResult {
  readonly raw: string
  /** Canonical rebuilt form ("TG01/TG30" → "TG01/30" is never invented — total is only appended
   *  when the parser actually found one), null when nothing parsed. */
  readonly normalized: string | null
  readonly prefix: string | null
  readonly numericComponent: string | null
  readonly setTotal: number | null
  readonly suffix: string | null
  readonly confidence: CollectorParseConfidence
}

/** Real multi-letter set-code prefixes look like this in the catalog (DATA_MODEL.md §3.1 / P67
 *  §7): "TG", "GG", "SV", "SWSH". A single generic letter in front of a digit run is exactly the
 *  shape a stray OCR glyph produces, not a real prefix. */
const KNOWN_MULTI_LETTER_PREFIX = /^[A-Z]{2,4}$/

/** The one real single-letter prefix this catalog actually stores (Neo-era "Prime" reprints,
 *  DATA_MODEL.md §3.1 — "H31"). Any OTHER single letter (Z, X, ...) in front of a bare digit is
 *  treated as noise, never a fabricated new "known" prefix. */
const KNOWN_SINGLE_LETTER_PREFIX = new Set(['H'])

function normalizedForm(parsed: ParsedCollectorNumber): string {
  const base = `${parsed.prefix}${parsed.numericText}${parsed.suffix}`
  return parsed.total !== null ? `${base}/${String(parsed.total)}` : base
}

/** A bare (no prefix, no total) numeric id longer than this is rejected down to LOW rather than
 *  MEDIUM (P85 §7f real finding): this catalog's real vintage local ids without a total never
 *  reach 4 digits (`DATA_MODEL.md` §3.1's own examples top out at 3), while a bare 4+-digit run
 *  is exactly the shape of a printed COPYRIGHT YEAR — confirmed directly as a real OCR false
 *  positive (a PSM 6 multi-line read of a Base Set card's "© 1995" line structurally parsing as a
 *  plausible "collector number" before this guard existed). */
const MAX_BARE_NUMERIC_DIGITS = 3

/**
 * Structural plausibility, independent of raw OCR confidence (P85 §8/§10): a total ("X/Y") is the
 * strongest structural signal a printed id can carry — HIGH. A bare numeric id (no prefix, 1-3
 * digits) or a recognized multi-letter/known single-letter prefix is the ordinary real-catalog
 * shape — MEDIUM. Anything else that still structurally parses (a generic single letter plus one
 * or two digits, or a bare 4+-digit run with no total — a real, confirmed year-misread shape, see
 * `MAX_BARE_NUMERIC_DIGITS`) is exactly the shape of OCR noise landing on a stray glyph or an
 * adjacent unrelated printed fact ("Z7", "X2", "1995") — LOW, never promoted further without more
 * evidence.
 */
function structuralConfidence(parsed: ParsedCollectorNumber): CollectorParseConfidence {
  if (parsed.total !== null) return 'high'
  if (
    parsed.prefix === '' &&
    parsed.numericText.length >= 1 &&
    parsed.numericText.length <= MAX_BARE_NUMERIC_DIGITS
  ) {
    return 'medium'
  }
  if (KNOWN_MULTI_LETTER_PREFIX.test(parsed.prefix)) return 'medium'
  if (KNOWN_SINGLE_LETTER_PREFIX.has(parsed.prefix) && parsed.numericText.length <= 3) {
    return 'medium'
  }
  return 'low'
}

/** Parses one observed collector-number text into every field the debug panel and the OCR
 *  ROI-candidate scorer need. Never throws; a text that does not parse at all returns an honest
 *  all-null structural result with `confidence: 'none'` — absence of evidence, never a guess. */
export function parseCollectorNumberStructured(rawInput: string): CollectorNumberParseResult {
  const parsed = parseCollectorNumber(rawInput)
  if (parsed === null) {
    return {
      raw: rawInput,
      normalized: null,
      prefix: null,
      numericComponent: null,
      setTotal: null,
      suffix: null,
      confidence: 'none',
    }
  }
  return {
    raw: rawInput,
    normalized: normalizedForm(parsed),
    prefix: parsed.prefix,
    numericComponent: parsed.numericText,
    setTotal: parsed.total,
    suffix: parsed.suffix,
    confidence: structuralConfidence(parsed),
  }
}
