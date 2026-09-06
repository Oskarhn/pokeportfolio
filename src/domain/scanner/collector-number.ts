/**
 * Collector/local number parser (P67 §7) — built against how `cards.local_id` is REALLY stored,
 * not a guessed modern-English format. Real canonical shapes (DATA_MODEL.md §3.1): "4", "112",
 * "001/165" (some rows literally carry "/total"), "SV049", "TG12", "H31". Observed scan shapes
 * the parser must survive: "123/198", "001/078", "TG01/TG30" (right side is another local id,
 * NOT a total), "GG01/GG70", "SV0 01" (OCR split), "123 198" (slash lost), lowercase, junk.
 *
 * Conservative by construction: when structure cannot be recognized the parse FAILS (null) —
 * it never guesses a number out of noise.
 */
import type { ParsedCollectorNumber } from './types'

/** prefix + digits + suffix, nothing else. The strict shape of every real local id. */
const STRICT = /^([A-Z]*)([0-9]+)([A-Z]*)$/

/**
 * OCR letter→digit folding, applied ONLY inside collector-number comparison where both sides
 * are expected to be alphanumeric ids (P67 §6: context-sensitive, never global). Restricted to
 * the classic high-confidence confusions; deliberately NOT B→8/G→6/Z→2 etc., which produce
 * false positives far more often than they fix real scans.
 */
const OCR_LETTER_FOR_DIGIT: Record<string, string> = {
  O: '0',
  I: '1',
  L: '1',
  S: '5',
}

function foldOcrLetters(input: string): string {
  return input.replace(/[OILS]/g, (ch) => OCR_LETTER_FOR_DIGIT[ch] ?? ch)
}

/**
 * F-16/P88 §15 — well-justified OCR separator noise: a hyphen, period or middle-dot stray glyph
 * between the prefix and digit run on a tiny collector-number strip ("SWSH-001", "TG.01"). Never
 * a general "strip all punctuation" pass (that would silently repair genuine garbage) — only
 * these three specific characters, and only as a last-resort retry after both the literal and
 * OCR-folded shapes have already failed (fail-closed remains the default).
 */
const SEPARATOR_PATTERN = /[-.·]/g

function stripSeparators(token: string): string {
  return token.replace(SEPARATOR_PATTERN, '')
}

interface StrictParts {
  readonly prefix: string
  readonly numericText: string
  readonly suffix: string
}

function matchStrict(text: string): StrictParts | null {
  const match = STRICT.exec(text)
  if (!match) return null
  return { prefix: match[1] ?? '', numericText: match[2] ?? '', suffix: match[3] ?? '' }
}

function toParsed(parts: StrictParts, total: number | null, raw: string): ParsedCollectorNumber {
  return {
    prefix: parts.prefix,
    numeric: Number.parseInt(parts.numericText, 10),
    numericText: parts.numericText,
    suffix: parts.suffix,
    total,
    raw,
  }
}

/**
 * Parses one observed collector-number text. Returns null for anything without a recognizable
 * digit-bearing id structure.
 */
export function parseCollectorNumber(rawInput: string): ParsedCollectorNumber | null {
  const raw = rawInput.trim()
  if (raw === '') return null
  const upper = raw.toUpperCase()

  // Slash first: left side is the id, right side a candidate total.
  const slashIndex = upper.indexOf('/')
  if (slashIndex >= 0) {
    const left = upper.slice(0, slashIndex)
    const rightRaw = upper.slice(slashIndex + 1).replace(/\s+/g, '')
    // A total must START as pure digits ("123/198", tolerating trailing junk like "x2").
    // "TG01/TG30"'s right side is another local id — no total exists there, and inventing one
    // from "TG30" would be fabrication.
    const totalMatch = /^\d+/.exec(rightRaw)
    const total = totalMatch ? Number.parseInt(totalMatch[0], 10) : null
    const parts = parseLeftSide(left.replace(/\s+/g, ''))
    return parts ? toParsed(parts, total, raw) : null
  }

  // No slash. Whitespace groups mean either an OCR-split token or a lost slash.
  const groups = upper.split(/\s+/).filter((g) => g !== '')
  if (groups.length > 1) {
    const first = groups[0] ?? ''
    const last = groups[groups.length - 1] ?? ''
    // "123 198" / "4 102": two pure-digit groups → lost slash between number and total.
    // Requiring BOTH sides pure-digit keeps "SV0 01" away from this branch (it joins instead).
    if (groups.length === 2 && /^\d+$/.test(last) && /^\d+$/.test(first)) {
      const parts = matchStrict(first)
      if (parts) return toParsed(parts, Number.parseInt(last, 10), raw)
    }
    // Otherwise treat as one token with OCR-inserted spaces: "SV0 01" → "SV001".
    const joined = groups.join('')
    const parts = parseLeftSide(joined)
    return parts ? toParsed(parts, null, raw) : null
  }

  const parts = parseLeftSide(upper)
  return parts ? toParsed(parts, null, raw) : null
}

/** Attempts strict recognition, then one conservative OCR-folding pass, then (F-16) one
 *  conservative separator-stripping pass. Folding/stripping are allowed ONLY when the raw token
 *  already contains a digit: an id must have digits structurally, so folding "PIKACHU" into
 *  "P1KACHU" (or treating "RE" as a stray-separator id) would manufacture an id out of ordinary
 *  prose — fail closed instead. */
function parseLeftSide(token: string): StrictParts | null {
  if (token === '') return null
  const literal = matchStrict(token)
  if (literal) return literal
  if (!/\d/.test(token)) return null
  const folded = matchStrict(foldOcrLetters(token))
  if (folded) return folded
  // Note: comparing `stripped !== token` (rather than testing SEPARATOR_PATTERN first) avoids
  // relying on a stateful `.test()` call against a `g`-flagged regex, whose `lastIndex` would
  // otherwise leak across calls.
  const stripped = stripSeparators(token)
  if (stripped !== token && stripped !== '') {
    const strippedLiteral = matchStrict(stripped)
    if (strippedLiteral) return strippedLiteral
    const strippedFolded = matchStrict(foldOcrLetters(stripped))
    if (strippedFolded) return strippedFolded
  }
  return null
}
