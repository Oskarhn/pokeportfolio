/**
 * Name and set-hint comparison (P67 §8, §10). Deterministic, length-aware fuzzy matching over
 * normalized text — no dependency, built on the bounded Damerau-Levenshtein primitive.
 *
 * The critical guard: edit RATIO alone must never make unrelated names score as close.
 * Short strings pass ratio thresholds trivially ("Mew"/"Meu" is a fine OCR miss, but
 * "Abra"/"Abomasnow"-style partial overlaps are not evidence), and two unrelated same-length
 * names can still share enough characters to look similar on paper. So closeness requires an
 * ABSOLUTE distance within a length-scaled tolerance AND a minimum similarity ratio; both
 * sides of every comparison are normalized identically first (normalize.ts).
 */
import { boundedDamerauLevenshtein } from './edit-distance'
import { normalizeCardText } from './normalize'

export type TextEvidence = 'exact' | 'close' | 'partial' | 'none'

/** Length-scaled absolute distance tolerance: one miss on short names, up to three on long. */
function tolerance(shorterLength: number): number {
  if (shorterLength <= 5) return 1
  if (shorterLength <= 9) return 2
  return 3
}

const MIN_RATIO = 0.66

/** Minimum normalized length for containment to count as evidence ("Pika" ⊂ "Pikachu" yes;
 *  two- and three-letter fragments inside long names are noise magnets, not signals). */
const MIN_CONTAINED_LENGTH = 4

export function compareNames(observedRaw: string | null, candidateRaw: string): TextEvidence {
  const observed = observedRaw === null ? '' : normalizeCardText(observedRaw)
  if (observed.length < 3) return 'none'
  const candidate = normalizeCardText(candidateRaw)
  if (candidate === '') return 'none'
  if (observed === candidate) return 'exact'

  const distance = boundedDamerauLevenshtein(observed, candidate, tolerance(observed.length) + 1)
  const maxLen = Math.max(observed.length, candidate.length)
  const ratio = 1 - distance / maxLen
  if (distance <= tolerance(Math.min(observed.length, candidate.length)) && ratio >= MIN_RATIO) {
    return 'close'
  }
  if (
    (observed.includes(candidate) || candidate.includes(observed)) &&
    Math.min(observed.length, candidate.length) >= MIN_CONTAINED_LENGTH
  ) {
    return 'partial'
  }
  return 'none'
}
