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

/**
 * P110 (prompt §4, P107's DUAL_BUILD_RISK_VERDICT §19 "no coverage/failure-rate floor"): the
 * generator's own real single-prototype baseline indexed 19,501 of 19,508 cards that had a usable
 * reference image — 99.964% of the denominator that actually matters (see the module header:
 * `cardsWithUsableImage`, never `totalCanonicalCards`, since a large legitimate share of the
 * catalog has no image at all and was never a candidate for indexing). A run degraded by sustained
 * rate-limiting or a source outage could previously still publish at, say, 20% coverage as a fully
 * "valid" generation — nothing checked a LOWER bound at all, only that coverage could not exceed
 * 100%. 98% leaves headroom for ordinary day-to-day image-availability churn (a few dozen cards
 * with a genuinely broken CDN asset) while still catching an order-of-magnitude degradation
 * (a 20%-complete run, or anything below "the vast majority of usable images actually made it in")
 * well before it could ever reach {@link assertValidCoverage}'s caller.
 */
export const MIN_INDEXED_OF_USABLE_IMAGE_PERCENT = 98

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

  // P110 (prompt §4): the lower-bound coverage floor. Denominator is deliberately
  // `cardsWithUsableImage`, never `totalCanonicalCards` — see MIN_INDEXED_OF_USABLE_IMAGE_PERCENT's
  // own doc comment for why. Skipped only when there are zero usable images to begin with (the
  // "accepts zero-card coverage" case above already forces cardsIndexed to 0 too in that case —
  // 0/0 is vacuously fine, not a degraded run).
  if (cardsWithUsableImage > 0) {
    const indexedOfUsableImagePercent = (100 * cardsIndexed) / cardsWithUsableImage
    if (indexedOfUsableImagePercent < MIN_INDEXED_OF_USABLE_IMAGE_PERCENT) {
      throw new CoverageInvariantError(
        `cardsIndexed/cardsWithUsableImage = ${indexedOfUsableImagePercent.toFixed(2)}% ` +
          `(${String(cardsIndexed)}/${String(cardsWithUsableImage)}) is below the minimum ` +
          `acceptable coverage floor of ${String(MIN_INDEXED_OF_USABLE_IMAGE_PERCENT)}%. Refusing ` +
          'to publish a degraded index — this shape matches a run interrupted by sustained ' +
          'rate-limiting, a source outage, or a systemic fetch failure, not ordinary day-to-day ' +
          'image-availability churn. Investigate the failure budget before re-running.',
      )
    }
  }
}

/**
 * Per-cause breakdown of everything that kept a usable-image card OUT of the published index
 * (P110, prompt §5). Reported separately, never collapsed into one misleading "failures" number —
 * a systemic 429 storm and a handful of permanently-404 images look identical in a single count
 * but call for completely different owner action (wait and resume vs. nothing to do).
 *
 * `decodeFailure`/`embedFailure` are reported as the SAME count, deliberately, not two
 * independently-tracked numbers: the underlying `embedImageBuffer` call this pipeline uses does
 * not distinguish "the bytes fetched are not a decodable image" from "decoding succeeded but the
 * model's own inference threw" — inventing a fake split between them would be exactly the kind of
 * fabricated precision this project's honesty bar forbids. Both fields are exposed because the
 * prompt names both explicitly; their equal value documents the real limitation rather than
 * hiding it.
 */
export interface FailureBudget {
  /** Network error or timeout — no HTTP response was ever received. */
  readonly fetchFailure: number
  readonly http404: number
  readonly http429: number
  readonly http5xx: number
  /** Any other non-2xx HTTP status (401/403/etc.) — treated as permanent, never retried. */
  readonly httpOther: number
  readonly decodeFailure: number
  readonly embedFailure: number
}

export function logFailureBudget(
  budget: FailureBudget,
  log: (line: string) => void = console.log,
): void {
  log(
    `[failure-budget] FETCH_FAILURE=${String(budget.fetchFailure)} (network error or timeout — no HTTP response received)`,
  )
  log(`[failure-budget] HTTP_404=${String(budget.http404)}`)
  log(`[failure-budget] HTTP_429=${String(budget.http429)}`)
  log(`[failure-budget] HTTP_5XX=${String(budget.http5xx)}`)
  log(
    `[failure-budget] HTTP_OTHER=${String(budget.httpOther)} (non-2xx status other than 404/429/5xx)`,
  )
  log(
    `[failure-budget] DECODE_FAILURE=${String(budget.decodeFailure)} / EMBED_FAILURE=${String(budget.embedFailure)} ` +
      '(reported equal — the embed pipeline does not distinguish a decode-time error from a ' +
      "model-inference error; see FailureBudget's own doc comment)",
  )
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
