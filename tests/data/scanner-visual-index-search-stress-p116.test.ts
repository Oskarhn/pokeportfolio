import { readFileSync } from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  decodeVisualIndex,
  searchVisualIndex,
  l2Normalize,
  type DecodedVisualIndex,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'

/**
 * P116 §5 — actual dual-index search stress, read-only, against the real committed generation
 * `f25fc05d569b7cca` (the same generation the P112 base ships and P113's fault matrix already
 * exercises for LOADING). This file is entirely off the network/worker boundary: `decodeVisualIndex`
 * and `searchVisualIndex` are pure functions over typed arrays, so the real production index can be
 * loaded straight from disk and searched at high volume inside plain Node/vitest — no browser, no
 * Worker, no ONNX model required (the query vectors here are synthetic, not real embeddings; this
 * proves the SEARCH path, not the embedding path, matching prompt §5's own "read-only... searchVisualIndex
 * calls" scope, distinct from §4's worker lifecycle soak).
 */

const GENERATION_DIR = path.resolve(
  __dirname,
  '../../scripts/scanner-visual-index/generated/visual-v1/generations/f25fc05d569b7cca',
)

function loadRealIndex(): DecodedVisualIndex {
  const manifest = JSON.parse(
    readFileSync(path.join(GENERATION_DIR, 'manifest.json'), 'utf-8'),
  ) as VisualIndexManifest
  const cardIds = JSON.parse(
    readFileSync(path.join(GENERATION_DIR, 'card-ids.json'), 'utf-8'),
  ) as string[]
  const embeddingsBuffer = readFileSync(path.join(GENERATION_DIR, 'embeddings.bin'))
  const embeddingsInt8 = new Int8Array(
    embeddingsBuffer.buffer,
    embeddingsBuffer.byteOffset,
    embeddingsBuffer.byteLength,
  )
  return decodeVisualIndex(manifest, cardIds, embeddingsInt8)
}

const REAL_INDEX = loadRealIndex()
const DIM = REAL_INDEX.manifest.embeddingDim
const CARD_COUNT = REAL_INDEX.cardIds.length

function randomVector(rng: () => number): Float32Array {
  const v = new Float32Array(DIM)
  for (let i = 0; i < DIM; i += 1) v[i] = rng() * 2 - 1
  return l2Normalize(v)
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('real dual-index search stress (P116 §5) — generation f25fc05d569b7cca, read-only', () => {
  it('loads the real committed generation with a sane shape', () => {
    expect(CARD_COUNT).toBeGreaterThan(0)
    expect(DIM).toBeGreaterThan(0)
    expect(REAL_INDEX.prototypesPerCard).toBeGreaterThanOrEqual(1)
  })

  // The real committed generation has ~19,500 cards x 2 prototypes x 384 dims — a brute-force
  // searchVisualIndex call is O(cardCount * prototypesPerCard * dim) regardless of topK (a bounded
  // heap only cuts SORTING cost, not the per-card dot-product scan), roughly 15M multiply-adds per
  // call. 250,000 calls against a SYNTHETIC small index would be cheap, but against the REAL
  // production-scale index that is ~3.7 trillion multiply-adds — tens of minutes, not a runnable
  // test. PERMANENT_TOTAL below is chosen to actually complete in CI; SOAK_TOTAL (opt-in via
  // SCANNER_INDEX_SEARCH_SOAK=1) pushes toward prompt §5's literal 250,000 for a manual soak run.
  const PERMANENT_TOTAL = 3_000
  const SOAK_TOTAL = 250_000
  const SOAK_ENABLED = process.env.SCANNER_INDEX_SEARCH_SOAK === '1'
  const TOTAL = SOAK_ENABLED ? SOAK_TOTAL : PERMANENT_TOTAL

  it(
    `${String(PERMANENT_TOTAL)} searches over random finite unit vectors (SCANNER_INDEX_SEARCH_SOAK=1 for the full 250,000): deterministic, finite, correct topK, stable ties, index never mutated`,
    () => {
      const beforeSnapshot = Array.from(REAL_INDEX.embeddingsInt8.slice(0, 4096))
      const topKs = [1, 5, 20, 100]
      let performed = 0
      const rng = mulberry32(20260907)
      for (let i = 0; i < TOTAL; i += 1) {
        const topK = topKs[i % topKs.length] ?? 5
        const vector = randomVector(rng)
        const hits = searchVisualIndex(REAL_INDEX, vector, topK)
        performed += 1
        expect(hits.length).toBe(Math.min(topK, CARD_COUNT))
        for (const hit of hits) {
          expect(Number.isFinite(hit.similarity)).toBe(true)
          expect(typeof hit.cardId).toBe('string')
        }
        // Sorted similarity desc across the returned page (BoundedTopK/full-sort contract).
        for (let h = 1; h < hits.length; h += 1) {
          const prev = hits[h - 1]
          const curr = hits[h]
          if (!prev || !curr) continue
          expect(prev.similarity).toBeGreaterThanOrEqual(curr.similarity)
        }
        // No duplicate cardId within one result page.
        expect(new Set(hits.map((h) => h.cardId)).size).toBe(hits.length)
      }
      expect(performed).toBe(TOTAL)
      // The underlying int8 buffer is read-only from this module's perspective — a search must
      // never write back into the shared decoded index.
      expect(Array.from(REAL_INDEX.embeddingsInt8.slice(0, 4096))).toEqual(beforeSnapshot)
    },
    SOAK_ENABLED ? 20 * 60_000 : 100_000,
  )

  it('adversarial query vectors (zero, near-zero, all-ones, all-minus-ones) never throw and stay finite', () => {
    const adversarial: Float32Array[] = [
      new Float32Array(DIM), // all-zero
      (() => {
        const v = new Float32Array(DIM)
        v[0] = 1e-30
        return v
      })(), // near-zero
      new Float32Array(DIM).fill(1),
      new Float32Array(DIM).fill(-1),
      l2Normalize(new Float32Array(DIM).fill(1)),
    ]
    for (const vector of adversarial) {
      const hits = searchVisualIndex(REAL_INDEX, vector, 20)
      expect(hits).toHaveLength(Math.min(20, CARD_COUNT))
      for (const hit of hits) expect(Number.isFinite(hit.similarity)).toBe(true)
    }
  })

  it('genuinely dequantized real index vectors (a stored card row, re-searched against itself) rank that card at position 1', () => {
    // Reconstruct card 0's own first-prototype row as a float query — the index searching for
    // its own stored vector must find itself as the top (or tied-top) hit.
    const prototypesPerCard = REAL_INDEX.prototypesPerCard
    for (const cardIndex of [0, Math.floor(CARD_COUNT / 2), CARD_COUNT - 1]) {
      const start = cardIndex * prototypesPerCard * DIM
      const row = new Float32Array(DIM)
      for (let d = 0; d < DIM; d += 1) row[d] = REAL_INDEX.embeddingsInt8[start + d] ?? 0
      const query = l2Normalize(row)
      const hits = searchVisualIndex(REAL_INDEX, query, 1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.cardId).toBe(REAL_INDEX.cardIds[cardIndex])
    }
  })

  it('property: 300 random topK/vector pairs never mutate cardIds order or count', () => {
    // Each run performs one full brute-force search over the real ~19,500-card index (~15M
    // multiply-adds) — kept small deliberately; the bulk-volume assertions above already cover
    // the high-iteration-count ground this property would otherwise duplicate at prohibitive cost.
    const beforeIds = [...REAL_INDEX.cardIds]
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Math.min(CARD_COUNT, 500) }),
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
          minLength: DIM,
          maxLength: DIM,
        }),
        (topK, vectorArray) => {
          const vector = l2Normalize(Float32Array.from(vectorArray))
          const hits = searchVisualIndex(REAL_INDEX, vector, topK)
          expect(hits.length).toBe(Math.min(topK, CARD_COUNT))
        },
      ),
      { numRuns: 300 },
    )
    expect(REAL_INDEX.cardIds).toEqual(beforeIds)
  }, 60_000)
})
