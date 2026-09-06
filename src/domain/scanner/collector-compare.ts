/**
 * Collector-number comparison between an observed scan and a canonical `cards.local_id`
 * (P67 §9). Both sides run through the same parser, so canonical shapes like "001/165"
 * (local ids that literally carry a total) and "TG01" behave identically to observed ones.
 *
 * Evidence levels, strongest first:
 * - `exact`   — prefix, numeric value and suffix all agree (zero-padding insensitive: "001"
 *               equals "1", because sets differ in how they pad).
 * - `folded`  — agrees only after the conservative OCR letter→digit fold applied to the FULL id
 *               string. Folding the full string (not per-segment) matters: "II2" literally
 *               parses as prefix "II" + digit 2, and only a whole-string fold recovers "112".
 *               Deliberately WEAKER than exact: the fold can collide two distinct ids
 *               ("S01"/"501"), so it may support a candidate but never certify one alone.
 * - `numeric` — numeric portion agrees but prefix or suffix differs. The same number appears
 *              across many sets; weak evidence on its own.
 */
import { parseCollectorNumber } from './collector-number'
import type { ParsedCollectorNumber } from './types'

export type CollectorNumberEvidence = 'exact' | 'folded' | 'numeric' | 'none'

const OCR_LETTER_FOR_DIGIT: Record<string, string> = { O: '0', I: '1', L: '1', S: '5' }

/** Conservative whole-id OCR fold — mirrors the parser's own second-chance pass. */
function foldFullId(parsed: ParsedCollectorNumber): string {
  const joined = `${parsed.prefix}${parsed.numericText}${parsed.suffix}`
  return joined.replace(/[OILS]/g, (ch) => OCR_LETTER_FOR_DIGIT[ch] ?? ch)
}

export function compareCollectorNumber(
  observed: ParsedCollectorNumber | null,
  candidateLocalId: string,
): CollectorNumberEvidence {
  if (!observed) return 'none'
  const candidate = parseCollectorNumber(candidateLocalId)
  if (!candidate) return 'none'

  if (
    observed.prefix === candidate.prefix &&
    observed.numeric === candidate.numeric &&
    observed.suffix === candidate.suffix
  ) {
    return 'exact'
  }
  if (foldFullId(observed) === foldFullId(candidate)) {
    return 'folded'
  }
  if (observed.numeric === candidate.numeric) return 'numeric'
  return 'none'
}
