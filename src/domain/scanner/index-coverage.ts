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
}
