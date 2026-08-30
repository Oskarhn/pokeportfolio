/**
 * Bounded Damerau-Levenshtein (optimal string alignment) distance — P67 §8.
 *
 * Hand-rolled rather than a dependency: the whole matcher needs exactly one edit-distance
 * primitive, OSA's known limitation (no substring transposition+edit interactions) is
 * irrelevant at these tolerances, and a 40-line pure function with tests beats a supply-chain
 * surface. No project dependency existed for this (checked before writing).
 *
 * The `cutoff` parameter lets callers bound work: once the distance provably exceeds cutoff,
 * computation stops early and returns cutoff + 1.
 */
export function boundedDamerauLevenshtein(a: string, b: string, cutoff: number): number {
  if (a === b) return 0
  const alen = a.length
  const blen = b.length
  if (Math.abs(alen - blen) > cutoff) return cutoff + 1

  // DP rows: previous-previous (for transpositions), previous, current.
  let prevPrev: number[] = []
  let prev: number[] = Array.from({ length: blen + 1 }, (_, j) => j)

  for (let i = 1; i <= alen; i++) {
    const current: number[] = [i]
    let rowMin = i
    for (let j = 1; j <= blen; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (current[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + substitutionCost, // substitution
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const transposition = (prevPrev[j - 2] ?? 0) + 1
        if (transposition < value) value = transposition
      }
      current[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > cutoff) return cutoff + 1
    prevPrev = prev
    prev = current
  }
  return prev[blen] ?? cutoff + 1
}
