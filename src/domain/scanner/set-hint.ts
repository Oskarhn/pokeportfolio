/**
 * Set-hint comparison (P67 §10). The scanner V1 text engine receives at most a weak textual set
 * hint — a name fragment OCR'd from the card frame. The printed expansion symbol is an IMAGE
 * and is deliberately NOT converted to text anywhere here.
 *
 * Set evidence is supporting weight only: it can disambiguate between printings and complete a
 * HIGH-confidence composition, but no tier is reachable on set evidence alone (enforced by the
 * engine's weight table, tested).
 */
import { boundedDamerauLevenshtein } from './edit-distance'
import { normalizeCardText } from './normalize'

export type SetHintEvidence = 'exact' | 'close' | 'none'

const MIN_RATIO = 0.66
/** A set fragment shorter than this ("SV", "Base") matches too much — treated as absent. */
const MIN_HINT_LENGTH = 4

export function compareSetHint(hintRaw: string | null, candidateSetName: string): SetHintEvidence {
  const hint = hintRaw === null ? '' : normalizeCardText(hintRaw)
  if (hint.length < MIN_HINT_LENGTH) return 'none'
  const setName = normalizeCardText(candidateSetName)
  if (setName === '') return 'none'
  if (hint === setName) return 'exact'

  // OCR rarely reads the full set name; containment either direction is real evidence
  // ("Surging Spa" ⊂ "Surging Sparks").
  if (hint.includes(setName) || setName.includes(hint)) return 'close'

  const distance = boundedDamerauLevenshtein(hint, setName, tolerance(hint, setName))
  if (
    distance <= tolerance(hint, setName) &&
    1 - distance / Math.max(hint.length, setName.length) >= MIN_RATIO
  ) {
    return 'close'
  }
  return 'none'
}

function tolerance(a: string, b: string): number {
  const min = Math.min(a.length, b.length)
  if (min <= 6) return 1
  if (min <= 11) return 2
  return 3
}
