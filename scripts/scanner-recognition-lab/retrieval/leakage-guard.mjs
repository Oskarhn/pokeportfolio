// P100: benchmark-data-leakage detector. P98's post-repair audit CONFIRMED a real defect in P95's
// own geometry-only benchmark (experiments/17-two-stage-pipeline-search.mjs): the query buffer for
// the "geometryOnly" regime was built by calling `applyNamedProfile('perspective-rotate', buf,
// trueId)` — the EXACT SAME function, on the EXACT SAME source buffer, with the EXACT SAME
// deterministic per-card seed (`augment/photometric.mjs`'s `baseSeed + idx*97` for
// idx=AUGMENTATION_PROFILES.indexOf('perspective-rotate')) already used to build one of the six
// augmented views averaged into that card's own dual-prototype auxiliary embedding
// (`dualProtos = [pristineVec, mean(augmentedVecs)]`). The query was therefore bit-identical to one
// of the six ingredients of its own reference — measuring near-tautological self-recall, not
// generalization. Architecture B's reported 100% TOP1 on that regime was contaminated.
//
// This module is the permanent fix: every benchmark that builds BOTH a reference-augmentation set
// and a held-out query for the same card must hash every reference ingredient and every query
// buffer, then call `assertNoLeakage` before recording a result. A collision throws immediately —
// fail the whole benchmark run loudly, never silently keep a contaminated number.
import { createHash } from 'node:crypto'

/** SHA-256 hex digest of one image buffer — cheap (single pass, no image decode), buffer-content
 *  based so it catches literal byte-identity regardless of which code path produced either side. */
export function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Hashes every reference-augmentation ingredient for one card (the pristine buffer plus each of
 * its N augmented-view buffers) into a Set of hex digests, keyed for later lookup.
 * `ingredients` is `[{ label, buffer }, ...]` — label is diagnostic only (e.g. 'pristine',
 * 'perspective-rotate'), never load-bearing for the hash comparison itself.
 */
export function hashReferenceIngredients(ingredients) {
  const byHash = new Map()
  for (const { label, buffer } of ingredients) {
    byHash.set(hashBuffer(buffer), label)
  }
  return byHash
}

export class LeakageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LeakageError'
  }
}

/**
 * Throws `LeakageError` if `queryBuffer` is byte-identical to ANY of this card's own
 * reference-augmentation ingredients (as hashed by {@link hashReferenceIngredients}). Cross-card
 * collisions are never checked (and would never legitimately matter — a query for card A being
 * byte-identical to an unrelated card B's reference ingredient is not a leak against A).
 */
export function assertNoLeakage(cardId, regimeLabel, queryBuffer, referenceIngredientHashes) {
  const queryHash = hashBuffer(queryBuffer)
  const collidingLabel = referenceIngredientHashes.get(queryHash)
  if (collidingLabel !== undefined) {
    throw new LeakageError(
      `Benchmark data leakage detected: card ${cardId}'s "${regimeLabel}" query is byte-identical ` +
        `to its own reference ingredient "${collidingLabel}" (sha256 ${queryHash}). This is the ` +
        'exact P95/P98 contamination shape — refusing to record a self-recall result as if it were ' +
        'generalization. Fix the query construction so it never reuses the same transform/seed as ' +
        'any reference-augmentation ingredient.',
    )
  }
}

/**
 * Convenience wrapper for the common shape: one card, its full set of reference ingredients, and
 * one or more held-out query buffers keyed by regime label. Throws on the FIRST collision found
 * (fail fast, fail closed — never continue accumulating a benchmark result past a detected leak).
 */
export function assertNoLeakageAll(cardId, referenceIngredients, queriesByRegime) {
  const hashes = hashReferenceIngredients(referenceIngredients)
  for (const [regimeLabel, queryBuffer] of Object.entries(queriesByRegime)) {
    assertNoLeakage(cardId, regimeLabel, queryBuffer, hashes)
  }
}
