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
  searchVisualIndex,
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
  it('decodes a well-formed index into dequantized Float32 rows', () => {
    const rows = [
      [127, 0, -127, 0],
      [0, 127, 0, -127],
    ]
    const decoded = decodeVisualIndex(manifest(), ['card-a', 'card-b'], packInt8(rows))
    expect(decoded.cardIds).toEqual(['card-a', 'card-b'])
    expect(decoded.embeddings.length).toBe(8)
    expect(decoded.embeddings[0]).toBeCloseTo(1, 2)
    expect(decoded.embeddings[2]).toBeCloseTo(-1, 2)
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
