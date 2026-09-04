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
 *
 * ── P93/N-04 redesign: continuous point curve ──────────────────────────────────────────────────
 * The previous point curve was three PIECEWISE-LINEAR bands that met at hard threshold
 * boundaries — at similarity 0.819999 a candidate scored 38 points, at 0.82 exactly it jumped to
 * 55 (a 17-point discontinuity, P92 finding N-04). A discontinuous curve is dangerous specifically
 * BECAUSE the matcher's dominance logic used to key off that same absolute boundary: P84's own
 * calibration puts the MEAN genuine same-card similarity at 0.812 — already below 0.82 — so an
 * entirely ordinary correct scan could land on the wrong side of the cliff by pure sampling noise.
 *
 * `visualEvidencePoints` is now a single continuous, monotonic logistic curve over the whole
 * [0, 1] similarity range — no bands, no jump, no hidden dependence on `strongMin` at all. The
 * curve's two free parameters (`midpoint`, `steepness`) are solved algebraically from two
 * calibration anchors read directly off P84's measured distributions (D-101 §2), not tuned by
 * eye:
 *   - at similarity = moderateMin (0.68, P84's nearest-wrong-card mean under clean geometry
 *     distortion), points ≈ 25 — a plausible-but-unproven read, well below a confident signal.
 *   - at similarity = strongMin (0.82, just above P84's own mean genuine-match similarity of
 *     0.812), points ≈ 60 — genuinely competitive with the maximum coincidental TEXT-only score a
 *     wrong card can reach today (id-exact + name-exact = 75, since `rawSetText` is never
 *     populated in production and language-match no longer scores — see engine.ts's own
 *     `SCORING_WEIGHTS` doc), without erasing the gap outright — closing that residual gap for a
 *     genuinely well-supported visual anchor is `applyVisualAnchorReliability`'s job, not this
 *     curve's (see engine.ts).
 * Solving `points(0.68) = 25` and `points(0.82) = 60` for a logistic
 * `f(s) = ceilingPoints / (1 + e^{-steepness·(s - midpoint)})` gives `steepness ≈ 11.53`,
 * `midpoint ≈ 0.7655` — see docs/SCANNER_RESEARCH.md §7i for the worked algebra and the full
 * similarity → points table (0.0 through 1.0, plus every 0.01 step from 0.79 to 0.90).
 *
 * `strongMin`/`moderateMin`/`weakMin` remain as CLASSIFICATION boundaries only — `visualEvidence
 * Tier` still reports discrete tiers for reason codes, diagnostics and the (also redesigned,
 * non-absolute) visual-anchor-reliability model in engine.ts. They no longer gate the point
 * curve itself.
 */

export type VisualEvidenceTier = 'strong' | 'moderate' | 'weak' | 'none'

export const VISUAL_SIMILARITY_THRESHOLDS = {
  /** Same physical card under realistic capture noise reliably scores at or above this
   *  (P84: clean-geometry same-card mean 0.812, p90 0.900; nearest-wrong mean 0.674). Used only
   *  for tier CLASSIFICATION (reason codes, diagnostics, the anchor-reliability model) — the point
   *  curve below is continuous and does not key off this value at all (P93/N-04). */
  strongMin: 0.82,
  moderateMin: 0.68,
  weakMin: 0.55,
} as const

/**
 * Continuous logistic point curve (P93/N-04 — replaces the old three-band piecewise curve, see
 * module doc for the calibration derivation). `midpoint`/`steepness` are solved from two P84-
 * calibrated anchors, not guessed; `ceilingPoints` is the asymptotic value as similarity -> 1.0
 * (never actually reached with real photos, same ceiling concept the old curve used).
 */
export const VISUAL_EVIDENCE_CURVE = {
  /** Logistic midpoint (cosine similarity at which the curve crosses half its ceiling). */
  midpoint: 0.7655,
  /** Logistic steepness — larger means a sharper transition around `midpoint`. */
  steepness: 11.53,
  /** Points at similarity == 1.0 (asymptotic ceiling, never actually reached with real photos). */
  ceilingPoints: 92,
} as const

export function visualEvidenceTier(similarity: number | null | undefined): VisualEvidenceTier {
  if (similarity === null || similarity === undefined || !Number.isFinite(similarity)) return 'none'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.strongMin) return 'strong'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.moderateMin) return 'moderate'
  if (similarity >= VISUAL_SIMILARITY_THRESHOLDS.weakMin) return 'weak'
  return 'none'
}

/** Continuous, monotonic point contribution for the composite score (engine.ts) — see the module
 *  doc for the calibration. Zero for any non-finite input (NaN/Infinity/-Infinity fail closed to
 *  "no visual evidence" rather than propagating a corrupted number into diagnostics — F-27) and
 *  for any similarity at or below zero (a logistic curve alone would still return a vanishingly
 *  small but nonzero value there; rounding already makes this a no-op above ~-0.05, but zeroing it
 *  explicitly for non-positive cosine similarity keeps the contract simple: a card that reads as
 *  actively DISSIMILAR never contributes a positive point value, even a rounding artifact). */
export function visualEvidencePoints(similarity: number | null | undefined): number {
  if (similarity === null || similarity === undefined || !Number.isFinite(similarity)) return 0
  if (similarity <= 0) return 0
  const { midpoint, steepness, ceilingPoints } = VISUAL_EVIDENCE_CURVE
  const z = steepness * (similarity - midpoint)
  const sigmoid = 1 / (1 + Math.exp(-z))
  return Math.round(sigmoid * ceilingPoints)
}
