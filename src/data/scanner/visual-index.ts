/**
 * Decode and search the static, versioned visual reference index (D-097).
 *
 * Pure, platform-neutral: works identically in the browser (fetched bytes) and in Node (the
 * offline generation/benchmark pipeline), because it operates on plain ArrayBuffers/TypedArrays
 * only — no DOM, no fetch, no Supabase. The index maps EVERY row back to an existing canonical
 * `cards.id` (prompt §19); this module never invents a second identity namespace.
 *
 * Format (see scripts/scanner-visual-index/build-index.mjs for the writer):
 *   manifest.json   — VisualIndexManifest (below)
 *   card-ids.json   — string[] of cards.id, order matches embeddings rows
 *   embeddings.bin  — raw Int8Array, row-major, length = cardCount * embeddingDim
 *
 * Quantization: each embedding is L2-normalized before storage, so every component already lies
 * in [-1, 1]; INT8 uses a fixed symmetric scale (value/127), no per-vector scale needed. Search
 * dequantizes on the fly and ranks by dot product, which approximates cosine similarity closely
 * for near-unit-norm vectors (validated empirically — see docs/SCANNER_RESEARCH.md §7b and
 * scripts/scanner-visual-benchmark's quantization-agreement metric).
 */

export const VISUAL_INDEX_QUANTIZATION = 'int8' as const
export const VISUAL_INDEX_INT8_SCALE = 127

export interface VisualIndexManifest {
  /** Bumped whenever the embedding contract (model/revision/preprocessing/dim) changes. */
  readonly version: string
  readonly modelId: string
  readonly modelRevision: string
  readonly modelSha256: string
  readonly embeddingDim: number
  readonly quantization: typeof VISUAL_INDEX_QUANTIZATION
  readonly cardCount: number
  /** SHA-256 of embeddings.bin, hex-encoded. Verified before the index is trusted. */
  readonly embeddingsSha256: string
  readonly generatedAt: string
  /** Of the canonical catalog, how many cards this index actually covers (prompt §19). */
  readonly coverage: {
    readonly totalCanonicalCards: number
    readonly cardsWithUsableImage: number
    readonly cardsIndexed: number
    readonly failures: number
    /** P97 (D-106): of `cardsIndexed`, how many got a REAL auxiliary (dual-prototype) embedding
     *  vs. a deterministic pristine-duplicate fallback because the auxiliary computation failed.
     *  Optional/absent on a single-prototype (v1) manifest — see `prototypeCount` below. */
    readonly cardsWithAuxPrototype?: number
    readonly cardsAuxFallback?: number
  }
  /**
   * Non-secret source identity (P77 prompt §20/§56): which project this index was actually built
   * against, so a local demo index can never be mistaken at a glance for a hosted-valid one, and
   * so the runtime diagnostics panel can show it directly. Optional only because manifests
   * committed before P77 predate these fields — never a service-role key or connection secret.
   */
  readonly sourceProjectRef?: string
  readonly sourceEnglishActiveCount?: number
  /**
   * P97 (D-106): how many reference prototype vectors `embeddings.bin` stores PER CARD, card-major
   * (card0-proto0, card0-proto1, ..., card1-proto0, ...). Absent/undefined means a pre-P97 (v1)
   * single-prototype manifest — implicitly 1, exactly today's committed format, so an existing
   * generation keeps decoding and verifying identically with no regeneration required. A present
   * value of 2 (or more) is the dual/multi-prototype format; `prototypeStrategy` and
   * `prototypeStrategyVersion` must also be present whenever this is > 1.
   */
  readonly prototypeCount?: number
  /** Name of the reference-augmentation strategy that produced the extra prototypes (e.g.
   *  `pristinePlus1Aux`) — present only when `prototypeCount` > 1. */
  readonly prototypeStrategy?: string
  /** Version of `prototypeStrategy`'s exact recipe (profile list/seeding/parameters) — bumped
   *  whenever the recipe changes, so two generations covering identical cards under two DIFFERENT
   *  recipes never collide on content id. Present only when `prototypeCount` > 1. */
  readonly prototypeStrategyVersion?: string
  /** Total rows in `embeddings.bin` = `cardCount * (prototypeCount ?? 1)`. Optional/redundant with
   *  `cardCount`/`prototypeCount` on a v1 manifest; when present, decode/verify cross-check it. */
  readonly rowCount?: number
}

export class VisualIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisualIndexError'
  }
}

/**
 * The tiny bootstrap pointer (P87 F-01) a client fetches FIRST, with a revalidating
 * Cache-Control (`no-cache` — see vite.config.ts's `_headers` generation and `cache: 'no-store'`
 * on the fetch call itself, belt-and-suspenders), to learn which content-addressed generation is
 * CURRENT — analogous to `build-meta.json`'s existing role for app deployments (D-100), applied to
 * index data instead. `manifest.json`/`card-ids.json`/`embeddings.bin` for that generation then
 * live under `.../index/generations/<contentId>/`, served genuinely immutable (the URL itself
 * changes when the content does, so the directive is finally true rather than merely asserted).
 */
export interface VisualIndexPointer {
  readonly indexVersion: string
  readonly contentId: string
  readonly manifestPath: string
}

export interface DecodedVisualIndex {
  readonly manifest: VisualIndexManifest
  readonly cardIds: readonly string[]
  /** Row-major dequantized embeddings, Float32, CARD-MAJOR: card0-proto0, card0-proto1, ...,
   *  card1-proto0, ... Length = cardCount * prototypeCount * embeddingDim. For a v1
   *  (prototypeCount=1) index this is identical in shape to the pre-P97 format — one row per
   *  card, in `cardIds` order. */
  readonly embeddings: Float32Array
  /** Resolved prototype count (manifest.prototypeCount ?? 1) — always a positive integer,
   *  computed once at decode time so search never has to re-derive it per call. */
  readonly prototypeCount: number
}

function assertFinite(vector: Float32Array, cardId: string): void {
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i]
    if (value === undefined || !Number.isFinite(value)) {
      throw new VisualIndexError(`Non-finite embedding value for card ${cardId} at index ${i}.`)
    }
  }
}

/**
 * Validates and decodes the three raw index parts into typed, searchable form (prompt §43: a
 * corrupt or contract-mismatched index must never be trusted silently).
 */
export function decodeVisualIndex(
  manifest: VisualIndexManifest,
  cardIds: readonly string[],
  embeddingsBytes: Int8Array,
): DecodedVisualIndex {
  // manifest arrives from JSON.parse over an untrusted asset in real callers — widen before
  // comparing so this stays a genuine runtime guard rather than a type-narrowed no-op.
  const quantization: string = manifest.quantization
  if (quantization !== VISUAL_INDEX_QUANTIZATION) {
    throw new VisualIndexError(`Unsupported quantization "${quantization}".`)
  }
  if (cardIds.length !== manifest.cardCount) {
    throw new VisualIndexError(
      `Manifest declares ${manifest.cardCount} cards but card-ids has ${cardIds.length}.`,
    )
  }
  // P97 (D-106): absent/undefined means a pre-P97 (v1) single-prototype manifest — implicitly 1,
  // exactly the format every already-committed generation uses. A present value must be a positive
  // integer; anything else is a corrupt/impossible manifest, never silently coerced.
  const prototypeCount = manifest.prototypeCount ?? 1
  if (!Number.isInteger(prototypeCount) || prototypeCount < 1) {
    throw new VisualIndexError(
      `Manifest declares an invalid prototypeCount: ${String(manifest.prototypeCount)}.`,
    )
  }
  if (
    prototypeCount > 1 &&
    (manifest.prototypeStrategy === undefined || manifest.prototypeStrategyVersion === undefined)
  ) {
    throw new VisualIndexError(
      `Manifest declares prototypeCount=${String(prototypeCount)} but is missing prototypeStrategy/prototypeStrategyVersion.`,
    )
  }
  const expectedLength = manifest.cardCount * prototypeCount * manifest.embeddingDim
  if (embeddingsBytes.length !== expectedLength) {
    throw new VisualIndexError(
      `Embeddings buffer has ${embeddingsBytes.length} bytes, expected ${expectedLength} ` +
        `(${manifest.cardCount} cards x ${String(prototypeCount)} prototypes x ${manifest.embeddingDim} dims).`,
    )
  }
  if (
    manifest.rowCount !== undefined &&
    manifest.rowCount !== manifest.cardCount * prototypeCount
  ) {
    throw new VisualIndexError(
      `Manifest declares rowCount=${String(manifest.rowCount)} but cardCount x prototypeCount = ` +
        `${String(manifest.cardCount * prototypeCount)}.`,
    )
  }
  const seen = new Set<string>()
  for (const id of cardIds) {
    if (seen.has(id)) throw new VisualIndexError(`Duplicate card id in index: ${id}.`)
    seen.add(id)
  }

  const embeddings = new Float32Array(expectedLength)
  for (let i = 0; i < expectedLength; i += 1) {
    embeddings[i] = (embeddingsBytes[i] ?? 0) / VISUAL_INDEX_INT8_SCALE
  }
  const totalRows = manifest.cardCount * prototypeCount
  for (let row = 0; row < totalRows; row += 1) {
    const start = row * manifest.embeddingDim
    const vector = embeddings.subarray(start, start + manifest.embeddingDim)
    const cardId = cardIds[Math.floor(row / prototypeCount)] ?? '?'
    assertFinite(vector, cardId)
  }

  return { manifest, cardIds, embeddings, prototypeCount }
}

/** L2-normalized mean of a set of same-length vectors — the "centroid" step of the dual-prototype
 *  auxiliary embedding (P97, D-106): average N augmented-view embeddings, then re-normalize to
 *  unit length so the result stays directly comparable (dot-product-as-cosine) with every other
 *  stored prototype. Exported so both the offline generator and this module's own tests share one
 *  implementation. Throws on an empty input — a caller always has at least one augmented view. */
export function meanVectors(vectors: readonly Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new VisualIndexError('meanVectors requires at least one vector.')
  const dim = vectors[0]?.length ?? 0
  const out = new Float32Array(dim)
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) out[i] = (out[i] ?? 0) + (v[i] ?? 0)
  }
  for (let i = 0; i < dim; i += 1) out[i] = (out[i] ?? 0) / vectors.length
  return l2Normalize(out)
}

export interface VisualSearchHit {
  readonly cardId: string
  /** Dot product of the (near-unit-norm) query and reference vectors — cosine-similarity proxy. */
  readonly similarity: number
}

/**
 * Quantizes one L2-normalized Float32 embedding to the index's INT8 contract. Exported so the
 * browser query path and the offline generator round-trip through the exact same function.
 */
export function quantizeEmbedding(vector: Float32Array): Int8Array {
  const out = new Int8Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) {
    const scaled = Math.round((vector[i] ?? 0) * VISUAL_INDEX_INT8_SCALE)
    out[i] = Math.max(-127, Math.min(127, scaled))
  }
  return out
}

/** L2-normalizes a vector in place and returns it (convenience for embedding callers). */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0
  for (let i = 0; i < vector.length; i += 1) sumSquares += (vector[i] ?? 0) ** 2
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) return vector
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / norm
  return vector
}

/**
 * Bounded top-K search over the decoded index (prompt §13/§31): a brute-force dot product scan.
 * At a few tens of thousands of 384-dim rows this is a few million multiply-adds — well within a
 * phone's per-scan budget (measured in scripts/scanner-visual-benchmark; see SCANNER_RESEARCH).
 * No external ANN library: it would be dead weight at this index size and is exactly the kind of
 * unjustified dependency the project avoids.
 *
 * P97 (D-106): a card with `prototypeCount` > 1 stores multiple reference rows (card-major); its
 * similarity is the MAX dot product over its own prototypes (P91/P95's `searchMultiProto`
 * strategy, reproduced here) — one hit per CARD is ever pushed, never one per prototype row, so
 * the matcher downstream (unchanged, out of scope for this work) keeps seeing exactly the same
 * "one score per candidate card" shape it always has. For prototypeCount=1 this degenerates to
 * exactly the pre-P97 single-row-per-card loop (no extra allocation, no behavior change).
 */
export function searchVisualIndex(
  index: DecodedVisualIndex,
  queryVector: Float32Array,
  topK: number,
): VisualSearchHit[] {
  if (queryVector.length !== index.manifest.embeddingDim) {
    throw new VisualIndexError(
      `Query vector has ${queryVector.length} dims, index expects ${index.manifest.embeddingDim}.`,
    )
  }
  const dim = index.manifest.embeddingDim
  const prototypeCount = index.prototypeCount
  const hits: VisualSearchHit[] = []
  for (let cardIndex = 0; cardIndex < index.cardIds.length; cardIndex += 1) {
    const cardId = index.cardIds[cardIndex]
    if (cardId === undefined) continue
    let best = -Infinity
    const cardRowStart = cardIndex * prototypeCount
    for (let proto = 0; proto < prototypeCount; proto += 1) {
      const start = (cardRowStart + proto) * dim
      let dot = 0
      for (let d = 0; d < dim; d += 1) {
        dot += (index.embeddings[start + d] ?? 0) * (queryVector[d] ?? 0)
      }
      if (dot > best) best = dot
    }
    hits.push({ cardId, similarity: best })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits.slice(0, Math.max(0, topK))
}
