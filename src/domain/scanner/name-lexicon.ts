/**
 * Local name-lexicon fuzzy resolution (P85 §6). Turns one noisy OCR name reading into the closest
 * REAL card name from a small local list of unique catalog names — evidence, not identity.
 *
 * This is deliberately a SEPARATE concern from `name-similarity.ts`'s `compareNames`: that
 * function scores ONE candidate the catalog has ALREADY returned from a text search. This module
 * runs BEFORE any catalog query, so a badly garbled OCR string ("Shieidon") can still resolve to
 * a sane search term ("Shieldon") instead of a query that is guaranteed to return nothing useful.
 * It does not replace or re-score anything `engine.ts` already does — see
 * `docs/SCANNER_RESEARCH.md` §7f for why this ships as tested, available domain tooling rather
 * than wired into the default retrieval path this session (no real full-catalog lexicon was
 * generated — see `scripts/scanner-name-lexicon/build-lexicon.mjs`).
 *
 * Confidence requires BOTH a minimum absolute similarity AND a real margin over the runner-up —
 * the same "score alone proves nothing, margin proves it wasn't a coin flip" discipline
 * `engine.ts`'s own tier logic uses (`SCORING_TIERS.highMinMargin`). Garbage input ("3S oa |")
 * must never resolve with manufactured confidence just because SOME lexicon entry is the least
 * bad of a field of unrelated names.
 */
import { boundedDamerauLevenshtein } from './edit-distance'
import { normalizeCardText } from './normalize'

export interface LexiconMatch {
  readonly name: string
  readonly ratio: number
}

export interface LexiconResolution {
  readonly best: LexiconMatch | null
  readonly runnerUp: LexiconMatch | null
  readonly margin: number
  readonly confident: boolean
}

/** Observed text shorter than this cannot mean anything — same floor `compareNames` uses. */
const MIN_OBSERVED_LENGTH = 3

/** Minimum similarity ratio (1 - editDistance/maxLen) for the best match to be trustworthy alone. */
export const LEXICON_MIN_RATIO = 0.72

/** Minimum lead over the runner-up before "best" counts as a real resolution rather than a
 *  coin-flip among several similarly-bad candidates. */
export const LEXICON_MIN_MARGIN = 0.08

function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 0
  const distance = boundedDamerauLevenshtein(a, b, maxLen)
  return 1 - Math.min(distance, maxLen) / maxLen
}

/** Builds a deduplicated, normalized lexicon from raw catalog names. Pure; sorted so output is
 *  deterministic regardless of input order (real catalog reads have no guaranteed row order). */
export function buildNameLexicon(names: readonly string[]): string[] {
  const set = new Set<string>()
  for (const name of names) {
    const normalized = normalizeCardText(name)
    if (normalized.length >= MIN_OBSERVED_LENGTH) set.add(normalized)
  }
  return [...set].sort()
}

/** Ranks every lexicon entry against one observed OCR reading, best first. Empty when the
 *  observed text is too short or the lexicon is empty — never a guess out of nothing. */
export function rankLexiconMatches(
  observedRaw: string | null,
  lexicon: readonly string[],
): LexiconMatch[] {
  const observed = observedRaw === null ? '' : normalizeCardText(observedRaw)
  if (observed.length < MIN_OBSERVED_LENGTH || lexicon.length === 0) return []
  return lexicon
    .map((candidate) => ({ name: candidate, ratio: similarityRatio(observed, candidate) }))
    .sort((a, b) => b.ratio - a.ratio)
}

/**
 * Resolves one noisy OCR name reading against a local lexicon. Always returns the best/runner-up
 * pair (even when NOT confident) so a caller can inspect the margin for diagnostics — only
 * `confident` gates whether the resolution should actually be trusted for anything.
 */
export function resolveNameAgainstLexicon(
  observedRaw: string | null,
  lexicon: readonly string[],
): LexiconResolution {
  const ranked = rankLexiconMatches(observedRaw, lexicon)
  const best = ranked[0] ?? null
  const runnerUp = ranked[1] ?? null
  const margin = best !== null ? best.ratio - (runnerUp?.ratio ?? 0) : 0
  const confident = best !== null && best.ratio >= LEXICON_MIN_RATIO && margin >= LEXICON_MIN_MARGIN
  return { best, runnerUp, margin, confident }
}
