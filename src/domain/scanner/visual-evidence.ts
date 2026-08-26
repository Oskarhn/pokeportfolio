/**
 * Calibrates raw cosine-similarity evidence from the on-device visual embedding channel (P76,
 * D-097) into the same coarse evidence language the rest of the matcher already uses. This is
 * the ONLY place a similarity number is interpreted — engine.ts spends the result as weighted
 * points, never re-derives a threshold of its own (prompt §32: never invent "97% confidence"
 * from cosine similarity).
 *
 * Thresholds are evidence-based, not guessed: they come from the augmented-camera-photo
 * benchmark in scripts/scanner-visual-benchmark (see docs/SCANNER_RESEARCH.md §7b for the
 * measured same-card vs different-card similarity distributions this pins).
 */

export type VisualEvidenceTier = 'strong' | 'moderate' | 'weak' | 'none'

export const VISUAL_SIMILARITY_THRESHOLDS = {
  /** Same physical card under realistic capture noise reliably scores at or above this. */
  strongMin: 0.82,
  moderateMin: 0.68,
  weakMin: 0.55,
} as const

/**
 * Tier labels only decide UI/diagnostic language (never re-derived into a fake percentage).
 * Point CONTRIBUTION is a continuous function of similarity (below) — a flat per-tier bonus was
 * tried first and rejected by the P76 benchmark (docs/SCANNER_RESEARCH.md §7b, n=1440 augmented
 * queries): a fixed +35 for any "strong" match (>=0.82) meant a near-perfect visual match (0.98)
 * scored identically to a barely-strong one (0.83), so a single OCR misread that coincidentally
 * produced an exact-collector-number hit on the WRONG card (worth 45 alone) could still outscore
 * a genuinely-correct but only-just-strong visual match. Scaling continuously with similarity
 * keeps a near-perfect visual match dominant while still letting two CONVERGING text signals
 * (e.g. exact id + exact name = 75) outweigh a merely-borderline visual read — the "OCR strong +
 * visual disagreement → ambiguous" balance prompt §33 asks for.
 */
export const VISUAL_EVIDENCE_WEIGHTS = {
  /** Points at similarity == 1.0 (never actually reached with real photos, so this is a ceiling,
   *  not a typical value). */
  maxPoints: 62,
  /** Below this similarity, visual evidence contributes nothing (matches weakMin). */
  floorSimilarity: VISUAL_SIMILARITY_THRESHOLDS.weakMin,
} as const

export function visualEvidenceTier(similarity: number | null | undefined): VisualEvidenceTier {
  if (similarity === null || similarity === undefined) return 'none'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.strongMin) return 'strong'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.moderateMin) return 'moderate'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.weakMin) return 'weak'
  return 'none'
}

/** Continuous point contribution for the composite score (engine.ts) — see the module doc for
 *  why this replaced a flat per-tier bonus. Zero below `floorSimilarity`; scales linearly from
 *  there to `maxPoints` at similarity 1.0. */
export function visualEvidencePoints(similarity: number | null | undefined): number {
  if (similarity === null || similarity === undefined) return 0
  const { floorSimilarity, maxPoints } = VISUAL_EVIDENCE_WEIGHTS
  if (similarity < floorSimilarity) return 0
  const normalized = (similarity - floorSimilarity) / (1 - floorSimilarity)
  return Math.round(Math.max(0, Math.min(1, normalized)) * maxPoints)
}
