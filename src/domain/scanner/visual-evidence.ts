/**
 * Calibrates raw cosine-similarity evidence from the on-device visual embedding channel (P76,
 * D-097) into the same coarse evidence language the rest of the matcher already uses. This is
 * the ONLY place a similarity number is interpreted — engine.ts spends the result as weighted
 * points, never re-derives a threshold of its own (prompt §32: never invent "97% confidence"
 * from cosine similarity).
 *
 * Thresholds are evidence-based, not guessed: they come from the augmented-camera-photo
 * benchmark in scripts/scanner-visual-benchmark (see docs/SCANNER_RESEARCH.md §7b for the
 * measured same-card vs different-card similarity distributions this pins) AND from P84's
 * real-similarity-unit calibration (D-101 §2): under clean geometry-only distortion, same-card
 * similarity averages ~0.81 (nearest-wrong ~0.67); under combined photometric defects
 * (glare+shadow+blur), same-card similarity collapses to ~0.10 while the nearest WRONG card
 * scores systematically HIGHER (~0.28-0.33) — signal inversion, not just weak signal. A value
 * around 0.18 is calibrated CATASTROPHIC, never "moderate."
 */

export type VisualEvidenceTier = 'strong' | 'moderate' | 'weak' | 'none'

export const VISUAL_SIMILARITY_THRESHOLDS = {
  /** Same physical card under realistic capture noise reliably scores at or above this
   *  (P84: clean-geometry same-card mean 0.812, p90 0.900; nearest-wrong mean 0.674). */
  strongMin: 0.82,
  moderateMin: 0.68,
  weakMin: 0.55,
} as const

/**
 * Point CONTRIBUTION is a continuous, PIECEWISE function of similarity, banded to match the P84
 * calibration rather than one straight line from floor to 1.0 (P88 §2/§3 redesign — the prior
 * single-slope curve made a realistic strong match, similarity 0.85-0.90, worth only 41-48
 * points: structurally below a coincidental two-signal OCR text convergence on a WRONG card
 * (collector-number-exact + name-exact = 75), which could then ALWAYS outrank a genuinely correct
 * visual match by construction — F-02).
 *
 * The bands:
 * - [floorSimilarity, moderateMin): 'weak' territory — P84's own catastrophic-defect nearest-
 *   wrong-card similarity (0.28-0.33) sits well BELOW this band already (visualEvidencePoints
 *   returns 0 below floorSimilarity), so this band only ever fires for a genuinely marginal read;
 *   capped low (weakMaxPoints) so it can never dominate a clean text signal on its own.
 * - [moderateMin, strongMin): 'moderate' — plausible but not yet the calibrated same-card range;
 *   scales up to moderateMaxPoints.
 * - [strongMin, 1.0]: 'strong' — P84's own calibrated same-card territory. Crossing into this
 *   band is itself informative (same-card similarity clusters tightly above strongMin in clean
 *   conditions while wrong-card similarity clusters below moderateMin), so points jump to
 *   strongMinPoints at the boundary rather than continuing the moderate band's slope, then scale
 *   up to maxPoints (asymptotic ceiling at similarity 1.0, never actually reached with real
 *   photos). At a realistic strong match (0.85-0.90) this now yields ~61-71 points — genuinely
 *   competitive with a coincidental id+name text convergence (75), closing most of the gap that
 *   made F-02 possible on point value alone. The remaining, harder guarantee (a strong visual
 *   match must not be defeated PURELY BY CONSTRUCTION regardless of point tuning) is engine.ts's
 *   own visual-dominance guard, not this curve.
 */
export const VISUAL_EVIDENCE_WEIGHTS = {
  /** Points at the top of the 'weak' band (just below moderateMin). */
  weakMaxPoints: 15,
  /** Points at the top of the 'moderate' band (just below strongMin). */
  moderateMaxPoints: 38,
  /** Points at similarity == strongMin, the calibrated floor of "same physical card" territory. */
  strongMinPoints: 55,
  /** Points at similarity == 1.0 (never actually reached with real photos, so this is a ceiling,
   *  not a typical value). */
  maxPoints: 92,
  /** Below this similarity, visual evidence contributes nothing (matches weakMin). */
  floorSimilarity: VISUAL_SIMILARITY_THRESHOLDS.weakMin,
} as const

export function visualEvidenceTier(similarity: number | null | undefined): VisualEvidenceTier {
  if (similarity === null || similarity === undefined || !Number.isFinite(similarity)) return 'none'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.strongMin) return 'strong'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.moderateMin) return 'moderate'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.weakMin) return 'weak'
  return 'none'
}

/** Continuous, banded point contribution for the composite score (engine.ts) — see the module
 *  doc for the calibrated bands. Zero below `floorSimilarity` AND for any non-finite input
 *  (NaN/Infinity/-Infinity fail closed to "no visual evidence" rather than propagating a
 *  corrupted number into diagnostics — F-27). */
export function visualEvidencePoints(similarity: number | null | undefined): number {
  if (similarity === null || similarity === undefined || !Number.isFinite(similarity)) return 0
  const { floorSimilarity, weakMaxPoints, moderateMaxPoints, strongMinPoints, maxPoints } =
    VISUAL_EVIDENCE_WEIGHTS
  const { moderateMin, strongMin } = VISUAL_SIMILARITY_THRESHOLDS
  if (similarity < floorSimilarity) return 0

  if (similarity < moderateMin) {
    const span = moderateMin - floorSimilarity
    const t = span <= 0 ? 1 : (similarity - floorSimilarity) / span
    return Math.round(Math.max(0, Math.min(1, t)) * weakMaxPoints)
  }
  if (similarity < strongMin) {
    const span = strongMin - moderateMin
    const t = span <= 0 ? 1 : (similarity - moderateMin) / span
    return Math.round(weakMaxPoints + Math.max(0, Math.min(1, t)) * (moderateMaxPoints - weakMaxPoints))
  }
  const span = 1 - strongMin
  const t = span <= 0 ? 1 : (similarity - strongMin) / span
  return Math.round(strongMinPoints + Math.max(0, Math.min(1, t)) * (maxPoints - strongMinPoints))
}
