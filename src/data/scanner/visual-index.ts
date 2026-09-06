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

/**
 * P100 (D-1xx): fail-closed schema/payload discriminant for a semantic BINARY LAYOUT change —
 * distinct from the free-text `version` string on `VisualIndexManifest`, which only ever names
 * the embedding CONTRACT (model/revision/preprocessing/dim, e.g. "visual-v1") and was never
 * designed to gate how many rows `embeddings.bin` stores per card (P98's finding: a future format
 * doubling `embeddingDim` to concatenate two prototypes per card would pass every check `version`
 * alone could offer and be silently misdecoded as one nonsensical double-length vector).
 *
 * A manifest with NONE of `schemaVersion`/`payloadFormat`/`prototypesPerCard` set is LEGACY_V1 —
 * the exact shape of every already-published, already-committed generation: implicitly one
 * prototype per card, one row per card. A manifest setting ANY of the three must set ALL three,
 * and `schemaVersion` must be one this build actually recognizes — `decodeVisualIndex` throws
 * (fails closed) for a manifest that partially declares the explicit schema, or names a
 * `schemaVersion` this exact build was never taught, rather than guessing at an unknown layout.
 */
export const VISUAL_INDEX_SCHEMA_LABEL_LEGACY_V1 = 'LEGACY_V1'
/** Numeric equivalent of LEGACY_V1, for a diagnostics field that always wants a number — never
 *  written into a manifest (a legacy manifest has NO schemaVersion field at all), only used to
 *  describe an already-resolved legacy decode. */
export const VISUAL_INDEX_SCHEMA_VERSION_LEGACY_V1 = 1
export const VISUAL_INDEX_SCHEMA_VERSION_MULTI_PROTOTYPE = 2
export const VISUAL_INDEX_PAYLOAD_FORMAT_MULTI_PROTOTYPE = 'multi-prototype-v2'
/** Closed allow-list of `schemaVersion` values this exact build's decoder understands, for a
 *  manifest that declares an EXPLICIT schema (i.e. is not LEGACY_V1). Extend only alongside a
 *  corresponding new branch in `decodeVisualIndex` — never widen this to "accept and hope." */
export const SUPPORTED_EXPLICIT_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([
  VISUAL_INDEX_SCHEMA_VERSION_MULTI_PROTOTYPE,
])

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
     *  Optional/absent on a single-prototype (v1) manifest — see `prototypesPerCard` below. */
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
   * P100 (D-1xx): fail-closed schema discriminant — see the module-level comment above
   * `VISUAL_INDEX_SCHEMA_LABEL_LEGACY_V1`. Absent (together with `payloadFormat`/
   * `prototypesPerCard`) means LEGACY_V1. Present means an explicit schema that
   * `decodeVisualIndex` validates against a closed allow-list, requiring `payloadFormat` and
   * `prototypesPerCard` alongside it.
   */
  readonly schemaVersion?: number
  /** Must be present whenever `schemaVersion` is — the human-legible name of that exact binary
   *  layout (e.g. `"multi-prototype-v2"`), checked verbatim, not merely presence-checked. */
  readonly payloadFormat?: string
  /**
   * P97/P100 (D-106): how many reference prototype vectors `embeddings.bin` stores PER CARD,
   * card-major (card0-proto0, card0-proto1, ..., card1-proto0, ...). Part of the explicit-schema
   * group above — on a LEGACY_V1 manifest this is absent and implicitly 1 (today's committed
   * format, decoding identically with no regeneration required). A present value of 2 (or more)
   * requires `schemaVersion`/`payloadFormat` to also be present, and `prototypeStrategy`/
   * `prototypeStrategyVersion` to be present whenever this is > 1.
   */
  readonly prototypesPerCard?: number
  /** Name of the reference-augmentation strategy that produced the extra prototypes (e.g.
   *  `pristinePlus1Aux`) — present only when `prototypesPerCard` > 1. */
  readonly prototypeStrategy?: string
  /** Version of `prototypeStrategy`'s exact recipe (profile list/seeding/parameters) — bumped
   *  whenever the recipe changes, so two generations covering identical cards under two DIFFERENT
   *  recipes never collide on content id. Present only when `prototypesPerCard` > 1. */
  readonly prototypeStrategyVersion?: string
  /** Total rows in `embeddings.bin` = `cardCount * (prototypesPerCard ?? 1)`. Optional/redundant with
   *  `cardCount`/`prototypesPerCard` on a v1 manifest; when present, decode/verify cross-check it. */
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
  /**
   * Raw quantized embeddings, Int8, CARD-MAJOR: card0-proto0, card0-proto1, ..., card1-proto0, ...
   * Length = cardCount * prototypesPerCard * embeddingDim. For a v1 (prototypesPerCard=1) index
   * this is identical in shape to the pre-P97 format — one row per card, in `cardIds` order.
   *
   * P102 (direct-int8 search): kept as the raw `Int8Array` this module was handed, never decoded
   * to a Float32Array up front. `searchVisualIndex` dequantizes each component inline, at multiply
   * time, so decoding an index never materializes a second, ~4x-larger copy of it (P97 disclosed
   * this roughly doubling runtime memory again for a dual-prototype index, 28.56MB -> 57.13MB, as
   * a DIRECT, unavoidable consequence of that eager Float32 conversion — direct-int8 search removes
   * the conversion, not just avoids duplicating it). Measured faster too, not just lighter (P100:
   * 24-61ms direct-int8 vs 43-122ms decode-then-search across 1/2/5 prototypes/card) — one fewer
   * full pass over the buffer per decode, and no allocation at all beyond the source bytes.
   */
  readonly embeddingsInt8: Int8Array
  /** Resolved prototype count (manifest.prototypesPerCard ?? 1) — always a positive integer,
   *  computed once at decode time so search never has to re-derive it per call. */
  readonly prototypesPerCard: number
  /** P100: `VISUAL_INDEX_SCHEMA_LABEL_LEGACY_V1` for a manifest with no explicit schema fields, or
   *  the manifest's own `payloadFormat` string otherwise — diagnostics-only, resolved once here so
   *  callers never have to re-derive "is this legacy or explicit" themselves. */
  readonly schemaLabel: string
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
  // P100 (D-1xx): fail-closed schema/payload discriminant. A manifest with NONE of
  // schemaVersion/payloadFormat/prototypesPerCard set is LEGACY_V1 (every already-committed
  // generation) — implicitly one prototype per card. A manifest setting ANY of the three must set
  // ALL three, and schemaVersion must be one this exact build recognizes; anything else is a
  // corrupt manifest or a genuinely future/unknown format, and this throws rather than guessing.
  const hasExplicitSchemaFields =
    manifest.schemaVersion !== undefined ||
    manifest.payloadFormat !== undefined ||
    manifest.prototypesPerCard !== undefined

  let prototypesPerCard: number
  let schemaLabel: string
  if (!hasExplicitSchemaFields) {
    prototypesPerCard = 1
    schemaLabel = VISUAL_INDEX_SCHEMA_LABEL_LEGACY_V1
  } else {
    if (
      manifest.schemaVersion === undefined ||
      manifest.payloadFormat === undefined ||
      manifest.prototypesPerCard === undefined
    ) {
      throw new VisualIndexError(
        'Manifest declares an explicit schema (one of schemaVersion/payloadFormat/' +
          'prototypesPerCard is present) but not all three — they must be present together or ' +
          'not at all (fail closed).',
      )
    }
    if (!SUPPORTED_EXPLICIT_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
      throw new VisualIndexError(
        `Unrecognized index schemaVersion ${String(manifest.schemaVersion)} — this build does not ` +
          'know how to decode this format (fail closed, not best-effort).',
      )
    }
    if (manifest.payloadFormat !== VISUAL_INDEX_PAYLOAD_FORMAT_MULTI_PROTOTYPE) {
      throw new VisualIndexError(
        `Manifest declares schemaVersion=${String(manifest.schemaVersion)} with unrecognized ` +
          `payloadFormat "${manifest.payloadFormat}" (expected ` +
          `"${VISUAL_INDEX_PAYLOAD_FORMAT_MULTI_PROTOTYPE}").`,
      )
    }
    prototypesPerCard = manifest.prototypesPerCard
    schemaLabel = manifest.payloadFormat
    if (!Number.isInteger(prototypesPerCard) || prototypesPerCard < 1) {
      throw new VisualIndexError(
        `Manifest declares an invalid prototypesPerCard: ${String(manifest.prototypesPerCard)}.`,
      )
    }
  }
  if (
    prototypesPerCard > 1 &&
    (manifest.prototypeStrategy === undefined || manifest.prototypeStrategyVersion === undefined)
  ) {
    throw new VisualIndexError(
      `Manifest declares prototypesPerCard=${String(prototypesPerCard)} but is missing prototypeStrategy/prototypeStrategyVersion.`,
    )
  }
  const expectedLength = manifest.cardCount * prototypesPerCard * manifest.embeddingDim
  if (embeddingsBytes.length !== expectedLength) {
    throw new VisualIndexError(
      `Embeddings buffer has ${embeddingsBytes.length} bytes, expected ${expectedLength} ` +
        `(${manifest.cardCount} cards x ${String(prototypesPerCard)} prototypes x ${manifest.embeddingDim} dims).`,
    )
  }
  if (
    manifest.rowCount !== undefined &&
    manifest.rowCount !== manifest.cardCount * prototypesPerCard
  ) {
    throw new VisualIndexError(
      `Manifest declares rowCount=${String(manifest.rowCount)} but cardCount x prototypesPerCard = ` +
        `${String(manifest.cardCount * prototypesPerCard)}.`,
    )
  }
  const seen = new Set<string>()
  for (const id of cardIds) {
    if (seen.has(id)) throw new VisualIndexError(`Duplicate card id in index: ${id}.`)
    seen.add(id)
  }

  // No Float32 decode and no per-value finiteness scan here (P102, direct-int8 search): an
  // Int8Array component is always an integer in [-128, 127] — dividing it by the fixed nonzero
  // VISUAL_INDEX_INT8_SCALE can never produce NaN/Infinity, so the old per-row `assertFinite` pass
  // over the fully-decoded Float32 copy was always vacuously true for this quantization scheme; it
  // validated a conversion step that no longer happens, not the source bytes themselves (which the
  // byte-length check above already validates the shape of). `embeddingsBytes` is stored as handed
  // to this function, not copied — the caller keeps whatever ownership/lifetime it already had.
  return {
    manifest,
    cardIds,
    embeddingsInt8: embeddingsBytes,
    prototypesPerCard,
    schemaLabel,
  }
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
 * Bounded top-K selection (P102 §7): a fixed-capacity binary MIN-heap over parallel typed arrays
 * (no per-candidate object allocation), keyed on similarity. Keeps only the best `capacity`
 * candidates seen so far — `push` is O(log capacity), so scanning `n` candidates costs
 * O(n log capacity) instead of a full O(n log n) sort. Measured, not assumed: at the real
 * dual-prototype scale (39,002 rows), `Array.prototype.sort` with a comparator over hit objects
 * cost ~13ms against a ~24ms dot-product scan — a real ~36% addition, not the negligible cost an
 * earlier draft of this code assumed (see D-114) — while `topK` in the actual production search
 * path is a small, fixed 30 (D-101/controller.ts), so a heap capped at the real `topK` does
 * meaningfully less comparison work than sorting every row. `drainSorted()` is the only place that
 * pays for sorting, and only over `capacity` elements (tiny), not `n`.
 *
 * Exported and unit-tested directly (not just exercised through `searchVisualIndex`) so its
 * ordering/tie-breaking/eviction semantics are pinned on their own.
 */
export class BoundedTopK {
  private readonly capacity: number
  private readonly sims: Float64Array
  private readonly indices: Int32Array
  private size = 0

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new VisualIndexError(
        `BoundedTopK capacity must be a positive integer, got ${String(capacity)}.`,
      )
    }
    this.capacity = capacity
    this.sims = new Float64Array(capacity)
    this.indices = new Int32Array(capacity)
  }

  /** Offers one (index, similarity) candidate. Kept if the heap has room, or if it beats the
   *  current worst kept candidate (which is then evicted). O(log capacity). */
  push(index: number, similarity: number): void {
    if (this.size < this.capacity) {
      let i = this.size
      this.sims[i] = similarity
      this.indices[i] = index
      this.size += 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if ((this.sims[parent] ?? Infinity) <= (this.sims[i] ?? -Infinity)) break
        this.swap(i, parent)
        i = parent
      }
      return
    }
    if (similarity <= (this.sims[0] ?? -Infinity)) return // worse than the current minimum kept
    this.sims[0] = similarity
    this.indices[0] = index
    let i = 0
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let smallest = i
      if (left < this.size && (this.sims[left] ?? Infinity) < (this.sims[smallest] ?? Infinity)) {
        smallest = left
      }
      if (right < this.size && (this.sims[right] ?? Infinity) < (this.sims[smallest] ?? Infinity)) {
        smallest = right
      }
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
  }

  private swap(a: number, b: number): void {
    const simA = this.sims[a] ?? 0
    const idxA = this.indices[a] ?? 0
    this.sims[a] = this.sims[b] ?? 0
    this.indices[a] = this.indices[b] ?? 0
    this.sims[b] = simA
    this.indices[b] = idxA
  }

  /** Drains the kept candidates as `{ index, similarity }`, best (highest similarity) first —
   *  sorts only the `size` kept elements, never `n`. Consumes the heap (call once).
   *
   * P102 real bug, found via numerical parity verification against 4,296 real queries (not
   * assumed correct from the algorithm looking right on paper): two DISTINCT cards can have
   * float64-identical (or effectively tied) similarity to a query — real duplicate/near-duplicate
   * reference embeddings exist in the catalog (e.g. reprints sharing artwork). The full-sort
   * fallback path below naturally breaks such ties by ascending card index, because
   * `Array.prototype.sort` is stable and cards are pushed into that array in ascending index
   * order. This heap's OWN internal array order is sift-history order, not card-index order, so
   * sorting only by `similarity` here let ties resolve by an arbitrary heap-internal order instead
   * — the SET of kept top-K cards was still correct, but which of two exactly-tied cards reported
   * as the winner could differ from the full-sort path for the exact same query. The explicit
   * `a.index - b.index` tie-break makes both paths deterministic and identical for a genuine tie,
   * matching the full-sort path's own (previously implicit, now explicit there too) rule. */
  drainSorted(): { index: number; similarity: number }[] {
    const out: { index: number; similarity: number }[] = []
    for (let i = 0; i < this.size; i += 1) {
      out.push({ index: this.indices[i] ?? 0, similarity: this.sims[i] ?? 0 })
    }
    out.sort((a, b) => b.similarity - a.similarity || a.index - b.index)
    return out
  }
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
 * Bounded top-K search directly against the raw int8 index (prompt §13/§31; P102 direct-int8): a
 * brute-force dot product scan, dequantizing each component inline at multiply time rather than
 * against a pre-decoded Float32 copy — see `DecodedVisualIndex.embeddingsInt8`'s own doc for why.
 * `queryVector` stays Float32 (the runtime always has a real embedding to search with, never a
 * quantized one) — only the STORED side is int8; `dot(queryFloat, int8Row) / SCALE` is the same
 * value `dot(queryFloat, int8Row/SCALE)` would be (SCALE is a positive constant, so division
 * distributes over the sum), computed with one division per prototype instead of one per
 * dimension. At a few tens of thousands of 384-dim rows this is a few million multiply-adds —
 * well within a phone's per-scan budget (measured in scripts/scanner-visual-benchmark; see
 * SCANNER_RESEARCH). No external ANN library: it would be dead weight at this index size and is
 * exactly the kind of unjustified dependency the project avoids.
 *
 * Top-K selection (P102 §7, D-114): measured, not assumed. `Array.prototype.sort` over the full
 * hit-object list is NOT a negligible cost next to the dot-product scan — at the real
 * dual-prototype scale (39,002 rows) it measured ~13ms against a ~24ms scan, a real ~36% addition,
 * not the "two orders of magnitude smaller" an earlier draft of this comment assumed before
 * actually measuring it. The real production search path's `topK` is a small, fixed 30
 * (D-101/controller.ts) — far smaller than `cardIds.length` — so `BoundedTopK` (a capacity-`topK`
 * min-heap, above) replaces the full sort with O(n log topK) selection whenever `topK` is smaller
 * than the index; a caller asking for a FULL ranking (`topK >= cardIds.length`, used only by the
 * diagnostics rank-lookup path, not the hot per-scan path) gets no benefit from a same-size heap,
 * so that case falls back to the plain full sort instead of paying heap overhead for nothing.
 *
 * Legacy (v1, prototypesPerCard=1) and schema-v2 (prototypesPerCard>=2) indexes share this exact
 * loop, parameterized by `index.prototypesPerCard` — never two independent search
 * implementations that could silently drift apart. P97 (D-112): a card with `prototypesPerCard` >
 * 1 stores multiple reference rows (card-major); its similarity is the MAX dot product over its
 * own prototypes (P91/P95's `searchMultiProto` strategy, reproduced here) — one hit per CARD is
 * ever pushed, never one per prototype row, so the matcher downstream (unchanged, out of scope for
 * this work) keeps seeing exactly the same "one score per candidate card" shape it always has. For
 * prototypesPerCard=1 this degenerates to exactly the pre-P97 single-row-per-card loop.
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
  const prototypesPerCard = index.prototypesPerCard
  const embeddingsInt8 = index.embeddingsInt8
  const cardCount = index.cardIds.length
  const boundedK = Math.max(0, topK)

  function bestSimilarityForCard(cardIndex: number): number {
    let best = -Infinity
    const cardRowStart = cardIndex * prototypesPerCard
    for (let proto = 0; proto < prototypesPerCard; proto += 1) {
      const start = (cardRowStart + proto) * dim
      let rawDot = 0
      for (let d = 0; d < dim; d += 1) {
        rawDot += (embeddingsInt8[start + d] ?? 0) * (queryVector[d] ?? 0)
      }
      const dot = rawDot / VISUAL_INDEX_INT8_SCALE
      if (dot > best) best = dot
    }
    return best
  }

  if (boundedK === 0) return []

  if (boundedK < cardCount) {
    const heap = new BoundedTopK(boundedK)
    for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
      if (index.cardIds[cardIndex] === undefined) continue
      heap.push(cardIndex, bestSimilarityForCard(cardIndex))
    }
    return heap.drainSorted().map(({ index: cardIndex, similarity }) => ({
      cardId: index.cardIds[cardIndex] ?? '?',
      similarity,
    }))
  }

  // Full ranking requested (topK >= cardCount, e.g. the diagnostics rank-lookup path) — a
  // same-size heap has no selection advantage here, so this falls back to a plain sort.
  //
  // P110 (prompt §22, P107's TOPK_VERDICT maintainability note): the tie-break is EXPLICIT here —
  // `similarity desc, then cardIndex asc` — matching BoundedTopK.drainSorted's own comparator
  // exactly, rather than relying on the implicit combination of "hits pushed in ascending
  // cardIndex order" plus "Array.prototype.sort is stable (ES2019+)" to produce the same result.
  // That implicit version was correct for the current code shape (proven by P102's own numerical
  // verification) but fragile to a future refactor that changed push order without noticing the
  // dependency; a shared, explicit rule removes the dependency entirely rather than merely
  // re-verifying it once more.
  const hits: (VisualSearchHit & { readonly index: number })[] = []
  for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
    const cardId = index.cardIds[cardIndex]
    if (cardId === undefined) continue
    hits.push({ cardId, similarity: bestSimilarityForCard(cardIndex), index: cardIndex })
  }
  hits.sort((a, b) => b.similarity - a.similarity || a.index - b.index)
  return hits.slice(0, boundedK).map(({ cardId, similarity }) => ({ cardId, similarity }))
}
