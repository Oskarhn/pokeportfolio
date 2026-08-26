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
  }
}

export class VisualIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisualIndexError'
  }
}

export interface DecodedVisualIndex {
  readonly manifest: VisualIndexManifest
  readonly cardIds: readonly string[]
  /** Row-major dequantized embeddings, Float32, length cardCount * embeddingDim. */
  readonly embeddings: Float32Array
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
  const expectedLength = manifest.cardCount * manifest.embeddingDim
  if (embeddingsBytes.length !== expectedLength) {
    throw new VisualIndexError(
      `Embeddings buffer has ${embeddingsBytes.length} bytes, expected ${expectedLength} ` +
        `(${manifest.cardCount} cards x ${manifest.embeddingDim} dims).`,
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
  for (let row = 0; row < manifest.cardCount; row += 1) {
    const start = row * manifest.embeddingDim
    const vector = embeddings.subarray(start, start + manifest.embeddingDim)
    assertFinite(vector, cardIds[row] ?? '?')
  }

  return { manifest, cardIds, embeddings }
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
  const hits: VisualSearchHit[] = []
  for (let row = 0; row < index.cardIds.length; row += 1) {
    const start = row * dim
    let dot = 0
    for (let d = 0; d < dim; d += 1) {
      dot += (index.embeddings[start + d] ?? 0) * (queryVector[d] ?? 0)
    }
    const cardId = index.cardIds[row]
    if (cardId !== undefined) hits.push({ cardId, similarity: dot })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits.slice(0, Math.max(0, topK))
}
