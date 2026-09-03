/**
 * Hard invariants over a visual index's coverage numbers (P77, prompt §8). Shared by the
 * generator (asserted BEFORE writing output — never ship a corrupt index) and verify-index.ts
 * (asserted after reading a committed one back) so both sides fail on the exact same rule.
 *
 * WHY THIS EXISTS: the P76 hosted regeneration produced a manifest claiming
 * `cardsIndexed: 1224` against `totalCanonicalCards: 1000` (122.4% "coverage") and the existing
 * verifier accepted it — it never checked coverage arithmetic at all, only checksum/model/
 * dimension agreement. This module is the fix: coverage above 100%, or any count that implies it,
 * is always a bug (checkpoint contamination, a stale packing step, a miscounted total) and must
 * fail loudly rather than ship.
 */

export class CoverageInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoverageInvariantError'
  }
}

export interface IndexCoverage {
  readonly totalCanonicalCards: number
  readonly cardsWithUsableImage: number
  readonly cardsIndexed: number
  readonly failures: number
  /** P97 (D-106): of `cardsIndexed`, how many got a REAL auxiliary (dual-prototype) embedding —
   *  vs. `cardsAuxFallback`, where the auxiliary computation failed and the card was still indexed
   *  (kept searchable) with its auxiliary prototype row deliberately duplicated from the pristine
   *  one (prompt §13's "prefer deterministic safe fallback"). Both optional/absent on a
   *  single-prototype (v1) build, where there is no auxiliary prototype to report on at all. */
  readonly cardsWithAuxPrototype?: number
  readonly cardsAuxFallback?: number
}

/**
 * Throws `CoverageInvariantError` on the first violated rule. `cardIdsLength` and
 * `manifestCardCount` are checked against `coverage.cardsIndexed` too — three numbers that must
 * all agree (the id list, the manifest's own declared count, and the coverage block) — because a
 * bug that only updates one of them is exactly how 1224/1000 shipped undetected.
 */
export function assertValidCoverage(
  coverage: IndexCoverage,
  cardIdsLength: number,
  manifestCardCount: number,
): void {
  const { totalCanonicalCards, cardsWithUsableImage, cardsIndexed, failures } = coverage

  if (totalCanonicalCards < 0 || cardsWithUsableImage < 0 || cardsIndexed < 0 || failures < 0) {
    throw new CoverageInvariantError('Coverage numbers must never be negative.')
  }
  if (cardsIndexed > totalCanonicalCards) {
    throw new CoverageInvariantError(
      `cardsIndexed (${String(cardsIndexed)}) exceeds totalCanonicalCards ` +
        `(${String(totalCanonicalCards)}) — impossible coverage over 100%. This is the exact ` +
        'historical 1224/1000 checkpoint-contamination shape (D-097 P77 addendum); refusing to ' +
        'trust this index.',
    )
  }
  if (cardsIndexed > cardsWithUsableImage) {
    throw new CoverageInvariantError(
      `cardsIndexed (${String(cardsIndexed)}) exceeds cardsWithUsableImage ` +
        `(${String(cardsWithUsableImage)}) — an index cannot cover more cards than had a usable ` +
        'reference image.',
    )
  }
  if (cardIdsLength !== cardsIndexed) {
    throw new CoverageInvariantError(
      `card-ids length (${String(cardIdsLength)}) does not match coverage.cardsIndexed ` +
        `(${String(cardsIndexed)}).`,
    )
  }
  if (manifestCardCount !== cardsIndexed) {
    throw new CoverageInvariantError(
      `manifest.cardCount (${String(manifestCardCount)}) does not match coverage.cardsIndexed ` +
        `(${String(cardsIndexed)}).`,
    )
  }
  // P97 (D-106): both optional and independently defaulted to 0 (not "absent means skip the
  // check") — a manifest that declares one but not the other, or whose sum exceeds cardsIndexed,
  // is exactly as impossible as the 1224/1000 shape this module already exists to catch.
  const cardsWithAuxPrototype = coverage.cardsWithAuxPrototype ?? 0
  const cardsAuxFallback = coverage.cardsAuxFallback ?? 0
  if (cardsWithAuxPrototype < 0 || cardsAuxFallback < 0) {
    throw new CoverageInvariantError('Auxiliary-prototype coverage numbers must never be negative.')
  }
  if (cardsWithAuxPrototype + cardsAuxFallback > cardsIndexed) {
    throw new CoverageInvariantError(
      `cardsWithAuxPrototype (${String(cardsWithAuxPrototype)}) + cardsAuxFallback ` +
        `(${String(cardsAuxFallback)}) exceeds cardsIndexed (${String(cardsIndexed)}) — an index ` +
        'cannot report more auxiliary-prototype outcomes than cards it actually indexed.',
    )
  }
}

/**
 * Full, honestly-labelled breakdown of an index's coverage (N-07): the old single-line summary
 * ("X/Y canonical cards (Z failures)") read as "only Z cards are missing out of Y", which hides
 * the far larger "no usable reference image at all" gap entirely — `failures` only ever counted
 * cards that HAD a usable image but still failed to embed (fetch/decode error), never the cards
 * with no image to begin with. Every consumer of coverage numbers (the build script, the verify
 * script) must report all six quantities with their denominators labelled, never a bare
 * percentage or a "failures" count that implies it is the only gap.
 */
export interface CoverageBreakdown {
  readonly totalCanonical: number
  readonly cardsWithUsableImage: number
  readonly cardsWithoutUsableImage: number
  readonly cardsIndexed: number
  readonly indexFailuresAmongUsableImages: number
  readonly totalUnindexed: number
  /** cardsIndexed / totalCanonical, as a 0-100 percentage. */
  readonly indexedOfTotalPercent: number
  /** cardsIndexed / cardsWithUsableImage, as a 0-100 percentage (undefined when no usable images exist). */
  readonly indexedOfUsableImagePercent: number | null
  /** P97 (D-106): pass-through of the manifest's own auxiliary-prototype coverage — undefined on a
   *  v1 (single-prototype) index, where there is nothing to report. */
  readonly cardsWithAuxPrototype?: number
  readonly cardsAuxFallback?: number
}

export function computeCoverageBreakdown(coverage: IndexCoverage): CoverageBreakdown {
  const { totalCanonicalCards, cardsWithUsableImage, cardsIndexed, failures } = coverage
  return {
    totalCanonical: totalCanonicalCards,
    cardsWithUsableImage,
    cardsWithoutUsableImage: totalCanonicalCards - cardsWithUsableImage,
    cardsIndexed,
    indexFailuresAmongUsableImages: failures,
    totalUnindexed: totalCanonicalCards - cardsIndexed,
    indexedOfTotalPercent: totalCanonicalCards > 0 ? (100 * cardsIndexed) / totalCanonicalCards : 0,
    indexedOfUsableImagePercent:
      cardsWithUsableImage > 0 ? (100 * cardsIndexed) / cardsWithUsableImage : null,
    cardsWithAuxPrototype: coverage.cardsWithAuxPrototype,
    cardsAuxFallback: coverage.cardsAuxFallback,
  }
}

/** Prints the full breakdown to the console with every denominator named — never a bare
 *  percentage or an unlabelled "N failures" line (N-07). Shared by build-index.ts and
 *  verify-index.ts so both report identically instead of drifting. */
export function logCoverageBreakdown(
  coverage: IndexCoverage,
  log: (line: string) => void = console.log,
): void {
  const b = computeCoverageBreakdown(coverage)
  log(`[coverage] TOTAL_CANONICAL=${String(b.totalCanonical)}`)
  log(`[coverage] CARDS_WITH_USABLE_IMAGE=${String(b.cardsWithUsableImage)}`)
  log(
    `[coverage] CARDS_WITHOUT_USABLE_IMAGE=${String(b.cardsWithoutUsableImage)} (no reference image at all — not attempted, not a failure)`,
  )
  log(`[coverage] CARDS_INDEXED=${String(b.cardsIndexed)}`)
  log(
    `[coverage] INDEX_FAILURES_AMONG_USABLE_IMAGES=${String(b.indexFailuresAmongUsableImages)} (had a usable image, still failed to embed)`,
  )
  log(
    `[coverage] TOTAL_UNINDEXED=${String(b.totalUnindexed)} (= without-usable-image + failures-among-usable)`,
  )
  log(
    `[coverage] indexed/total = ${b.indexedOfTotalPercent.toFixed(1)}% of ${String(b.totalCanonical)} canonical cards; ` +
      `indexed/usable-image = ${b.indexedOfUsableImagePercent === null ? 'n/a (no usable images)' : `${b.indexedOfUsableImagePercent.toFixed(1)}%`} of ${String(b.cardsWithUsableImage)} cards with a usable image.`,
  )
  if (b.cardsWithAuxPrototype !== undefined || b.cardsAuxFallback !== undefined) {
    log(
      `[coverage] CARDS_WITH_AUX_PROTOTYPE=${String(b.cardsWithAuxPrototype ?? 0)} (real dual-prototype auxiliary embedding)`,
    )
    log(
      `[coverage] CARDS_AUX_FALLBACK=${String(b.cardsAuxFallback ?? 0)} (auxiliary computation failed — indexed with the pristine prototype duplicated as a safe fallback)`,
    )
  }
}
