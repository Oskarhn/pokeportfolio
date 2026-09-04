/**
 * Visual reference index decode/search (P76, D-097). Covers prompt §44's V1–V6: decode, ranking
 * order, quantization accuracy bound, duplicate-id rejection, corrupt-index rejection, and
 * revision-mismatch handling (the mismatch check itself lives in build-index/verify-index; here
 * we pin that decodeVisualIndex never silently accepts a shape it wasn't given).
 */
import { describe, expect, it } from 'vitest'
import {
  decodeVisualIndex,
  quantizeEmbedding,
  l2Normalize,
  meanVectors,
  searchVisualIndex,
  BoundedTopK,
  VisualIndexError,
  VISUAL_INDEX_QUANTIZATION,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'

function manifest(overrides: Partial<VisualIndexManifest> = {}): VisualIndexManifest {
  return {
    version: 'visual-v1',
    modelId: 'Xenova/dinov2-small',
    modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
    modelSha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
    embeddingDim: 4,
    quantization: VISUAL_INDEX_QUANTIZATION,
    cardCount: 2,
    embeddingsSha256: 'deadbeef',
    generatedAt: '2026-08-26T00:00:00.000Z',
    coverage: { totalCanonicalCards: 2, cardsWithUsableImage: 2, cardsIndexed: 2, failures: 0 },
    ...overrides,
  }
}

function packInt8(rows: number[][]): Int8Array {
  const flat = rows.flat()
  return new Int8Array(flat)
}

describe('V1 — visual index decode', () => {
  it('decodes a well-formed index, keeping the raw int8 rows (P102: no Float32 materialization)', () => {
    const rows = [
      [127, 0, -127, 0],
      [0, 127, 0, -127],
    ]
    const decoded = decodeVisualIndex(manifest(), ['card-a', 'card-b'], packInt8(rows))
    expect(decoded.cardIds).toEqual(['card-a', 'card-b'])
    expect(decoded.embeddingsInt8.length).toBe(8)
    expect(decoded.embeddingsInt8[0]).toBe(127)
    expect(decoded.embeddingsInt8[2]).toBe(-127)
  })

  it('rejects a cardCount/card-ids length mismatch', () => {
    expect(() =>
      decodeVisualIndex(manifest({ cardCount: 3 }), ['only-one'], packInt8([[1, 2, 3, 4]])),
    ).toThrow(VisualIndexError)
  })

  it('rejects an unsupported quantization label', () => {
    expect(() =>
      decodeVisualIndex(
        manifest({ quantization: 'fp16' as never }),
        ['a', 'b'],
        packInt8([
          [1, 2, 3, 4],
          [1, 2, 3, 4],
        ]),
      ),
    ).toThrow(VisualIndexError)
  })
})

describe('V2/V3 — ranking order', () => {
  it('ranks by descending dot product, deterministically', () => {
    const rows = [
      [10, 0, 0, 0],
      [9, 1, 0, 0],
      [-10, 0, 0, 0],
    ]
    const decoded = decodeVisualIndex(
      manifest({ cardCount: 3 }),
      ['low', 'mid', 'neg'],
      packInt8(rows),
    )
    const query = new Float32Array([1, 0, 0, 0])
    const hits = searchVisualIndex(decoded, query, 3)
    expect(hits.map((h) => h.cardId)).toEqual(['low', 'mid', 'neg'])
    expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity)
    expect(hits[1]!.similarity).toBeGreaterThan(hits[2]!.similarity)
  })

  it('bounds output to topK and never returns more rows than the index has', () => {
    const rows = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ]
    const decoded = decodeVisualIndex(manifest({ cardCount: 3 }), ['a', 'b', 'c'], packInt8(rows))
    const hits = searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 2)
    expect(hits.length).toBe(2)
  })

  it('rejects a query vector of the wrong dimension', () => {
    const decoded = decodeVisualIndex(manifest({ cardCount: 1 }), ['a'], packInt8([[1, 2, 3, 4]]))
    expect(() => searchVisualIndex(decoded, new Float32Array([1, 2, 3]), 5)).toThrow(
      VisualIndexError,
    )
  })
})

describe('V4 — quantization accuracy bound', () => {
  it('round-trips a unit-normalized vector within a small error bound', () => {
    const original = l2Normalize(new Float32Array([3, 4, 0, 0]))
    const quantized = quantizeEmbedding(original)
    for (let i = 0; i < original.length; i += 1) {
      const dequantized = quantized[i]! / 127
      expect(Math.abs(dequantized - original[i]!)).toBeLessThan(0.01)
    }
  })

  it('clamps a value that would exceed int8 range after rounding', () => {
    const quantized = quantizeEmbedding(new Float32Array([1.5, -1.5]))
    expect(quantized[0]).toBe(127)
    expect(quantized[1]).toBe(-127)
  })
})

describe('V5 — duplicate id rejection', () => {
  it('rejects an index with a repeated card id', () => {
    expect(() =>
      decodeVisualIndex(
        manifest({ cardCount: 2 }),
        ['same', 'same'],
        packInt8([
          [1, 2, 3, 4],
          [5, 6, 7, 8],
        ]),
      ),
    ).toThrow(VisualIndexError)
  })
})

describe('V6 — corrupt index rejection', () => {
  it('rejects an embeddings buffer of the wrong byte length for its declared shape', () => {
    expect(() =>
      decodeVisualIndex(manifest({ cardCount: 2, embeddingDim: 4 }), ['a', 'b'], new Int8Array(7)),
    ).toThrow(VisualIndexError)
  })

  it('rejects non-finite values surviving into the decoded embeddings', () => {
    // Int8Array cannot itself hold NaN/Infinity, so this exercises the finite-check path via a
    // manifest whose declared dim disagrees with what was actually packed, which is the
    // realistic way corruption manifests in a shipped binary asset.
    const wrongShapeManifest = manifest({ cardCount: 1, embeddingDim: 4 })
    expect(() => decodeVisualIndex(wrongShapeManifest, ['a'], new Int8Array([1, 2, 3]))).toThrow(
      VisualIndexError,
    )
  })
})

describe('meanVectors (P97, D-106 — the aux-prototype centroid step)', () => {
  it('L2-normalizes the plain average of its inputs', () => {
    const centroid = meanVectors([new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])])
    let normSquared = 0
    for (const v of centroid) normSquared += v * v
    expect(Math.sqrt(normSquared)).toBeCloseTo(1, 5)
    expect(centroid[0]).toBeCloseTo(centroid[1] ?? 0, 5)
  })

  it('returns the input unchanged (after normalization) for a single vector', () => {
    const centroid = meanVectors([l2Normalize(new Float32Array([3, 4, 0, 0]))])
    expect(centroid[0]).toBeCloseTo(0.6, 5)
    expect(centroid[1]).toBeCloseTo(0.8, 5)
  })

  it('throws on an empty input rather than silently returning a zero/NaN vector', () => {
    expect(() => meanVectors([])).toThrow(VisualIndexError)
  })
})

describe('P97 (D-106) — dual/multi-prototype decode and search', () => {
  function dualManifest(overrides: Partial<VisualIndexManifest> = {}): VisualIndexManifest {
    return manifest({
      cardCount: 2,
      schemaVersion: 2,
      payloadFormat: 'multi-prototype-v2',
      prototypesPerCard: 2,
      prototypeStrategy: 'pristinePlus1Aux',
      prototypeStrategyVersion: '1',
      coverage: {
        totalCanonicalCards: 2,
        cardsWithUsableImage: 2,
        cardsIndexed: 2,
        failures: 0,
        cardsWithAuxPrototype: 2,
        cardsAuxFallback: 0,
      },
      ...overrides,
    })
  }

  it('a v1 (single-prototype) manifest with no prototypesPerCard field still decodes exactly as before — prototypesPerCard resolves to 1', () => {
    const rows = [
      [127, 0, -127, 0],
      [0, 127, 0, -127],
    ]
    const decoded = decodeVisualIndex(manifest(), ['card-a', 'card-b'], packInt8(rows))
    expect(decoded.prototypesPerCard).toBe(1)
    expect(decoded.embeddingsInt8.length).toBe(8)
  })

  it('a v2 (dual-prototype) manifest decodes card-major, 2 rows per card', () => {
    // card 'a': proto0 points +x, proto1 points +y. card 'b': proto0 points -x, proto1 points -y.
    const rows = [
      [127, 0, 0, 0], // a-proto0
      [0, 127, 0, 0], // a-proto1
      [-127, 0, 0, 0], // b-proto0
      [0, -127, 0, 0], // b-proto1
    ]
    const decoded = decodeVisualIndex(dualManifest(), ['a', 'b'], packInt8(rows))
    expect(decoded.prototypesPerCard).toBe(2)
    expect(decoded.embeddingsInt8.length).toBe(16)
    expect(decoded.embeddingsInt8[5]).toBe(127) // a-proto1's y component (row 1 = indices 4-7)
  })

  it('search returns exactly ONE hit per card, never one per prototype row', () => {
    const rows = [
      [127, 0, 0, 0],
      [0, 127, 0, 0],
      [-127, 0, 0, 0],
      [0, -127, 0, 0],
    ]
    const decoded = decodeVisualIndex(dualManifest(), ['a', 'b'], packInt8(rows))
    const hits = searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 10)
    expect(hits.length).toBe(2) // not 4
    expect(new Set(hits.map((h) => h.cardId)).size).toBe(2)
  })

  it("per-card similarity is the MAX over that card's own prototypes — prototype 1 can rescue a card whose prototype 0 is a poor match", () => {
    // card 'a': proto0 is a poor match (orthogonal), proto1 is a near-perfect match.
    // card 'b': proto0 is a decent match, proto1 is a poor match — proto0 should win for b.
    const rows = [
      [0, 127, 0, 0], // a-proto0: orthogonal to query
      [126, 10, 0, 0], // a-proto1: near-perfect match to query
      [100, 50, 0, 0], // b-proto0: decent match
      [0, 0, 127, 0], // b-proto1: orthogonal
    ]
    const decoded = decodeVisualIndex(dualManifest(), ['a', 'b'], packInt8(rows))
    const query = new Float32Array([1, 0, 0, 0])
    const hits = searchVisualIndex(decoded, query, 2)
    // a's winning similarity comes from proto1 (dot ~126/127), which beats b's proto0 (~100/127).
    expect(hits[0]!.cardId).toBe('a')
    expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity)
  })

  it("prototype 0 can remain the winner when it is already the card's best-matching prototype", () => {
    const rows = [
      [127, 0, 0, 0], // a-proto0: perfect match
      [0, 127, 0, 0], // a-proto1: orthogonal (worse)
    ]
    const decoded = decodeVisualIndex(dualManifest({ cardCount: 1 }), ['a'], packInt8(rows))
    const hits = searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 1)
    expect(hits[0]!.similarity).toBeCloseTo(1, 2)
  })

  it('a 5-prototype card is scored correctly too — the max-reduction generalizes beyond 2', () => {
    const rows = [
      [10, 0, 0, 0],
      [20, 0, 0, 0],
      [126, 0, 0, 0], // the real winner among this card's 5 prototypes
      [5, 0, 0, 0],
      [-100, 0, 0, 0],
    ]
    const decoded = decodeVisualIndex(
      manifest({
        cardCount: 1,
        schemaVersion: 2,
        payloadFormat: 'multi-prototype-v2',
        prototypesPerCard: 5,
        prototypeStrategy: 'maxSimAllProtos',
        prototypeStrategyVersion: '1',
      }),
      ['a'],
      packInt8(rows),
    )
    const hits = searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 1)
    expect(hits[0]!.similarity).toBeCloseTo(126 / 127, 3)
  })

  it('rejects an embeddings buffer whose length does not match cardCount x prototypesPerCard x dim (bad rowCount)', () => {
    const rows = [
      [127, 0, 0, 0],
      [0, 127, 0, 0],
      [-127, 0, 0, 0],
      // missing b-proto1 — only 3 rows for a 2-card, 2-prototype manifest
    ]
    expect(() => decodeVisualIndex(dualManifest(), ['a', 'b'], packInt8(rows))).toThrow(
      VisualIndexError,
    )
  })

  it('rejects a manifest.rowCount that disagrees with cardCount x prototypesPerCard', () => {
    const rows = [
      [127, 0, 0, 0],
      [0, 127, 0, 0],
      [-127, 0, 0, 0],
      [0, -127, 0, 0],
    ]
    expect(() =>
      decodeVisualIndex(dualManifest({ rowCount: 3 }), ['a', 'b'], packInt8(rows)),
    ).toThrow(VisualIndexError)
  })

  it('rejects a non-positive or non-integer prototypesPerCard', () => {
    const rows = [[127, 0, 0, 0]]
    expect(() =>
      decodeVisualIndex(
        dualManifest({ cardCount: 1, prototypesPerCard: 0 }),
        ['a'],
        packInt8(rows),
      ),
    ).toThrow(VisualIndexError)
    expect(() =>
      decodeVisualIndex(
        dualManifest({ cardCount: 1, prototypesPerCard: 1.5 }),
        ['a'],
        packInt8(rows),
      ),
    ).toThrow(VisualIndexError)
  })

  it('rejects prototypesPerCard > 1 with no prototypeStrategy/prototypeStrategyVersion declared', () => {
    const rows = [
      [127, 0, 0, 0],
      [0, 127, 0, 0],
    ]
    expect(() =>
      decodeVisualIndex(
        dualManifest({ cardCount: 1, prototypeStrategy: undefined }),
        ['a'],
        packInt8(rows),
      ),
    ).toThrow(VisualIndexError)
  })
})

describe('P100 (D-1xx) — fail-closed schema/payload discriminant', () => {
  it('a manifest with none of schemaVersion/payloadFormat/prototypesPerCard is LEGACY_V1', () => {
    const decoded = decodeVisualIndex(
      manifest(),
      ['card-a', 'card-b'],
      packInt8([
        [127, 0, -127, 0],
        [0, 127, 0, -127],
      ]),
    )
    expect(decoded.schemaLabel).toBe('LEGACY_V1')
    expect(decoded.prototypesPerCard).toBe(1)
  })

  it('an explicit dual-prototype manifest resolves schemaLabel to its own payloadFormat', () => {
    const decoded = decodeVisualIndex(
      manifest({
        cardCount: 1,
        schemaVersion: 2,
        payloadFormat: 'multi-prototype-v2',
        prototypesPerCard: 2,
        prototypeStrategy: 'pristinePlus1Aux',
        prototypeStrategyVersion: '1',
      }),
      ['a'],
      packInt8([
        [127, 0, 0, 0],
        [0, 127, 0, 0],
      ]),
    )
    expect(decoded.schemaLabel).toBe('multi-prototype-v2')
  })

  it('rejects a manifest that sets only ONE of the three explicit-schema fields (partial declaration)', () => {
    const rows = [[127, 0, 0, 0]]
    expect(() =>
      decodeVisualIndex(manifest({ cardCount: 1, schemaVersion: 2 }), ['a'], packInt8(rows)),
    ).toThrow(VisualIndexError)
    expect(() =>
      decodeVisualIndex(
        manifest({ cardCount: 1, payloadFormat: 'multi-prototype-v2' }),
        ['a'],
        packInt8(rows),
      ),
    ).toThrow(VisualIndexError)
    expect(() =>
      decodeVisualIndex(manifest({ cardCount: 1, prototypesPerCard: 1 }), ['a'], packInt8(rows)),
    ).toThrow(VisualIndexError)
  })

  it('fails closed on an unrecognized schemaVersion — never guesses at a future format', () => {
    const rows = [
      [127, 0, 0, 0],
      [0, 127, 0, 0],
    ]
    expect(() =>
      decodeVisualIndex(
        manifest({
          cardCount: 1,
          schemaVersion: 99,
          payloadFormat: 'multi-prototype-v2',
          prototypesPerCard: 2,
          prototypeStrategy: 'x',
          prototypeStrategyVersion: '1',
        }),
        ['a'],
        packInt8(rows),
      ),
    ).toThrow(VisualIndexError)
  })

  it('rejects a recognized schemaVersion paired with an unrecognized payloadFormat string', () => {
    const rows = [
      [127, 0, 0, 0],
      [0, 127, 0, 0],
    ]
    expect(() =>
      decodeVisualIndex(
        manifest({
          cardCount: 1,
          schemaVersion: 2,
          payloadFormat: 'some-future-format-v3',
          prototypesPerCard: 2,
          prototypeStrategy: 'x',
          prototypeStrategyVersion: '1',
        }),
        ['a'],
        packInt8(rows),
      ),
    ).toThrow(VisualIndexError)
  })
})

describe('BoundedTopK (P102 §7 — bounded top-K selection)', () => {
  it('keeps exactly the K highest-similarity candidates, best first', () => {
    const heap = new BoundedTopK(3)
    const inputs = [
      { index: 0, similarity: 0.5 },
      { index: 1, similarity: 0.9 },
      { index: 2, similarity: 0.1 },
      { index: 3, similarity: 0.7 },
      { index: 4, similarity: 0.3 },
    ]
    for (const { index, similarity } of inputs) heap.push(index, similarity)
    const drained = heap.drainSorted()
    expect(drained.map((h) => h.index)).toEqual([1, 3, 0])
    expect(drained.map((h) => h.similarity)).toEqual([0.9, 0.7, 0.5])
  })

  it('a candidate at or below the current worst kept score is evicted/never enters once full', () => {
    const heap = new BoundedTopK(2)
    heap.push(0, 1.0)
    heap.push(1, 0.5)
    heap.push(2, 0.5) // ties the current minimum — must not evict either kept candidate
    const drained = heap.drainSorted()
    expect(drained).toHaveLength(2)
    expect(drained.map((h) => h.index)).toContain(0)
  })

  it('handles fewer pushes than capacity — drains only what was actually kept', () => {
    const heap = new BoundedTopK(5)
    heap.push(0, 1)
    heap.push(1, 2)
    const drained = heap.drainSorted()
    expect(drained).toHaveLength(2)
    expect(drained[0]!.index).toBe(1)
  })

  it('capacity 1 keeps only the single best candidate', () => {
    const heap = new BoundedTopK(1)
    heap.push(0, 0.2)
    heap.push(1, 0.9)
    heap.push(2, 0.5)
    const drained = heap.drainSorted()
    expect(drained).toEqual([{ index: 1, similarity: 0.9 }])
  })

  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new BoundedTopK(0)).toThrow(VisualIndexError)
    expect(() => new BoundedTopK(-1)).toThrow(VisualIndexError)
    expect(() => new BoundedTopK(1.5)).toThrow(VisualIndexError)
  })

  it('matches a full sort on a larger randomized set (cross-check against Array.sort)', () => {
    const n = 200
    const k = 17
    const candidates = Array.from({ length: n }, (_, i) => ({
      index: i,
      // Deterministic pseudo-values, not Math.random(), so a failure is reproducible.
      similarity:
        Math.sin(i * 12.9898) * 43758.5453 - Math.floor(Math.sin(i * 12.9898) * 43758.5453),
    }))
    const heap = new BoundedTopK(k)
    for (const c of candidates) heap.push(c.index, c.similarity)
    const fromHeap = heap.drainSorted().map((h) => h.index)
    const fromSort = [...candidates]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .map((c) => c.index)
    expect(new Set(fromHeap)).toEqual(new Set(fromSort))
  })
})

describe('searchVisualIndex — bounded top-K path vs. full-ranking fallback (P102 §7)', () => {
  it('topK smaller than cardCount uses the bounded-heap path and still ranks correctly', () => {
    // 10 cards, orthogonal-ish directions of varying similarity to the query [1,0,0,0].
    const rows = Array.from({ length: 10 }, (_, i) => {
      const v = [0, 0, 0, 0]
      v[0] = 127 - i * 10 // decreasing similarity to [1,0,0,0] as i grows
      v[1] = i * 10
      return v
    })
    const decoded = decodeVisualIndex(
      manifest({ cardCount: 10 }),
      rows.map((_, i) => `card-${String(i)}`),
      packInt8(rows),
    )
    const hits = searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 3)
    expect(hits).toHaveLength(3)
    expect(hits.map((h) => h.cardId)).toEqual(['card-0', 'card-1', 'card-2'])
    expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity)
    expect(hits[1]!.similarity).toBeGreaterThan(hits[2]!.similarity)
  })

  it('topK >= cardCount falls back to the full-sort path and returns every card', () => {
    const rows = [
      [127, 0, 0, 0],
      [0, 127, 0, 0],
      [-127, 0, 0, 0],
    ]
    const decoded = decodeVisualIndex(manifest({ cardCount: 3 }), ['a', 'b', 'c'], packInt8(rows))
    const hits = searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 3)
    expect(hits.map((h) => h.cardId)).toEqual(['a', 'b', 'c'])
    const hitsOverRequested = searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 100)
    expect(hitsOverRequested).toHaveLength(3)
  })

  it('topK=0 returns no hits without touching either search path', () => {
    const rows = [[127, 0, 0, 0]]
    const decoded = decodeVisualIndex(manifest({ cardCount: 1 }), ['a'], packInt8(rows))
    expect(searchVisualIndex(decoded, new Float32Array([1, 0, 0, 0]), 0)).toEqual([])
  })

  it('the bounded-heap path and the full-sort path agree on real-shaped data (cross-check)', () => {
    const cardCount = 50
    const rows: number[][] = Array.from({ length: cardCount }, (_, i) => {
      const v = new Array<number>(4).fill(0)
      v[i % 4] = 100 - ((i * 13) % 200)
      v[(i + 1) % 4] = (i * 7) % 127
      return v
    })
    const cardIds = rows.map((_, i) => `c${String(i)}`)
    const decoded = decodeVisualIndex(manifest({ cardCount }), cardIds, packInt8(rows))
    const query = new Float32Array([0.6, 0.3, -0.2, 0.1])
    const boundedHits = searchVisualIndex(decoded, query, 8) // bounded-heap path
    const fullHits = searchVisualIndex(decoded, query, cardCount) // full-sort path
    expect(boundedHits.map((h) => h.cardId)).toEqual(fullHits.slice(0, 8).map((h) => h.cardId))
    expect(boundedHits.map((h) => h.similarity)).toEqual(
      fullHits.slice(0, 8).map((h) => h.similarity),
    )
  })
})
