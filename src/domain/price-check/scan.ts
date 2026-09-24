/**
 * Interprets a scanner analysis for Price Check. The scanner proposes card IDENTITIES; it never
 * chooses a variant and never decides a price. The only question here is how much confirmation a
 * proposal needs before Price Check may look up prices for it:
 *
 *   - HIGH confidence with a candidate: the best candidate is pre-selected (same rule as the
 *     scanner's own review step), but the person still confirms it explicitly.
 *   - MEDIUM / LOW: candidates are shown with NO pre-selection — the person must choose.
 *   - NO_MATCH (or nothing usable): manual search fallback.
 *
 * Confidence is the scanner's coarse band, passed through as-is; no number is invented here.
 */

export type ScanConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_MATCH'

export interface ScanCandidate {
  readonly candidateId: string
  readonly name: string
  readonly setName: string | null
  readonly collectorNumber: string | null
  readonly imageBaseUrl: string | null
  readonly languageLabel: string | null
}

export type ScanOutcome =
  | {
      readonly kind: 'high'
      readonly candidates: readonly ScanCandidate[]
      readonly preselectedId: string
    }
  | { readonly kind: 'review'; readonly candidates: readonly ScanCandidate[] }
  | { readonly kind: 'no_match' }

export function interpretScan(analysis: {
  readonly confidence: ScanConfidence
  readonly candidates: readonly ScanCandidate[]
}): ScanOutcome {
  const { confidence, candidates } = analysis
  const [best] = candidates
  if (best === undefined) return { kind: 'no_match' }
  if (confidence === 'HIGH') {
    return { kind: 'high', candidates, preselectedId: best.candidateId }
  }
  // MEDIUM / LOW — and, defensively, a NO_MATCH that nonetheless carries candidates (the contract
  // says that cannot happen; if it does, showing them without a pre-selection is the safe reading).
  return { kind: 'review', candidates }
}
