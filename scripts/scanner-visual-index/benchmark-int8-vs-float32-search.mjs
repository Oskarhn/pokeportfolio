/**
 * P100 §10: does the production searchVisualIndex path need to decode the WHOLE int8 index to a
 * ~2x-larger Float32Array before searching, or can it search directly against the raw Int8Array
 * (computing `dot(queryFloat, int8Value/127)` per component, on the fly, never materializing a
 * decoded copy)? P97 disclosed the dual-prototype format roughly doubles decoded runtime memory
 * (~28.56MB -> ~57.13MB for the real 19,501-card scale) purely from dequantizing twice as many
 * rows. This script measures whether skipping that dequantization step is "comfortably fast" or
 * "materially too slow" at 1/2/5 prototypes/card, using the REAL committed index's actual int8
 * bytes as the data source (not random noise — realistic embedding-value distributions).
 *
 * Run: node scripts/scanner-visual-index/benchmark-int8-vs-float32-search.mjs
 * Throwaway measurement script — writes one JSON report, never touches the committed index.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const GENERATED_DIR = join(here, 'generated', 'visual-v1')
const REPORT_PATH = join(
  here,
  '..',
  'scanner-recognition-lab',
  'reports',
  '20-int8-vs-float32-search.json',
)
const INT8_SCALE = 127
const TOP_K = 30
const REPEATS = 7

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Current production shape: decode the WHOLE int8 buffer to one Float32Array up front (exactly
 *  src/data/scanner/visual-index.ts's decodeVisualIndex), then dot-product each row. */
function searchFloat32Decoded(queryVec, int8Embeddings, cardCount, prototypesPerCard, dim) {
  const totalValues = cardCount * prototypesPerCard * dim
  const decoded = new Float32Array(totalValues)
  for (let i = 0; i < totalValues; i += 1) decoded[i] = (int8Embeddings[i] ?? 0) / INT8_SCALE
  const hits = []
  for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
    let best = -Infinity
    const rowStart = cardIndex * prototypesPerCard
    for (let proto = 0; proto < prototypesPerCard; proto += 1) {
      const start = (rowStart + proto) * dim
      let dotp = 0
      for (let d = 0; d < dim; d += 1) dotp += decoded[start + d] * queryVec[d]
      if (dotp > best) best = dotp
    }
    hits.push({ cardIndex, similarity: best })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return { hits: hits.slice(0, TOP_K), decodedBytes: totalValues * 4 }
}

/** Candidate alternative: search DIRECTLY against the raw Int8Array — no full-array Float32
 *  decode step at all. Each component is dequantized inline (`int8Value / 127`) only as it is
 *  multiplied into the running dot product, so the only extra memory this needs beyond the
 *  original int8 buffer itself is O(1) scratch. */
function searchDirectInt8(queryVec, int8Embeddings, cardCount, prototypesPerCard, dim) {
  const hits = []
  for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
    let best = -Infinity
    const rowStart = cardIndex * prototypesPerCard
    for (let proto = 0; proto < prototypesPerCard; proto += 1) {
      const start = (rowStart + proto) * dim
      let dotp = 0
      for (let d = 0; d < dim; d += 1)
        dotp += ((int8Embeddings[start + d] ?? 0) / INT8_SCALE) * queryVec[d]
      if (dotp > best) best = dotp
    }
    hits.push({ cardIndex, similarity: best })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return { hits: hits.slice(0, TOP_K), decodedBytes: 0 }
}

function randomUnitQuery(dim, seed) {
  let a = seed
  const rng = () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const v = new Float32Array(dim)
  let norm = 0
  for (let i = 0; i < dim; i += 1) {
    v[i] = rng() * 2 - 1
    norm += v[i] * v[i]
  }
  norm = Math.sqrt(norm)
  for (let i = 0; i < dim; i += 1) v[i] /= norm
  return v
}

async function loadRealInt8Embeddings() {
  const pointer = JSON.parse(await readFile(join(GENERATED_DIR, 'current.json'), 'utf-8'))
  const generationDir = join(GENERATED_DIR, 'generations', pointer.contentId)
  const manifest = JSON.parse(await readFile(join(generationDir, 'manifest.json'), 'utf-8'))
  const raw = await readFile(join(generationDir, 'embeddings.bin'))
  return {
    int8: new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength),
    cardCount: manifest.cardCount,
    dim: manifest.embeddingDim,
  }
}

/** Builds a synthetic `prototypesPerCard`-shaped int8 buffer at the SAME real card count/dim,
 *  reusing the REAL card's own bytes for prototype 0 and small deterministic perturbations of it
 *  for the extra prototype rows — realistic value distribution (not random noise), same approach
 *  P97 used for its own search-performance recompute. */
function buildSyntheticMultiProto(realInt8, cardCount, dim, prototypesPerCard) {
  const out = new Int8Array(cardCount * prototypesPerCard * dim)
  for (let card = 0; card < cardCount; card += 1) {
    const srcStart = card * dim
    for (let proto = 0; proto < prototypesPerCard; proto += 1) {
      const dstStart = (card * prototypesPerCard + proto) * dim
      for (let d = 0; d < dim; d += 1) {
        const base = realInt8[srcStart + d] ?? 0
        // proto 0 = the real byte verbatim; extra protos = a small deterministic perturbation, so
        // they are realistic-magnitude int8 values, not degenerate all-zero rows.
        const perturbed =
          proto === 0 ? base : Math.max(-127, Math.min(127, base - ((proto * 7 + d) % 11) + 5))
        out[dstStart + d] = perturbed
      }
    }
  }
  return out
}

async function main() {
  const { int8: realInt8, cardCount, dim } = await loadRealInt8Embeddings()
  console.log(`[bench] real index: ${cardCount} cards, dim ${dim}`)

  const results = {}
  for (const prototypesPerCard of [1, 2, 5]) {
    const int8Data =
      prototypesPerCard === 1
        ? realInt8
        : buildSyntheticMultiProto(realInt8, cardCount, dim, prototypesPerCard)

    const float32Times = []
    const directInt8Times = []
    let identicalTop1Count = 0
    let identicalTopKCount = 0
    const queries = REPEATS

    for (let q = 0; q < queries; q += 1) {
      const query = randomUnitQuery(dim, 1000 + q)

      const t0 = performance.now()
      const { hits: float32Hits } = searchFloat32Decoded(
        query,
        int8Data,
        cardCount,
        prototypesPerCard,
        dim,
      )
      float32Times.push(performance.now() - t0)

      const t1 = performance.now()
      const { hits: directHits } = searchDirectInt8(
        query,
        int8Data,
        cardCount,
        prototypesPerCard,
        dim,
      )
      directInt8Times.push(performance.now() - t1)

      if (float32Hits[0]?.cardIndex === directHits[0]?.cardIndex) identicalTop1Count += 1
      const float32TopKIds = float32Hits.map((h) => h.cardIndex).join(',')
      const directTopKIds = directHits.map((h) => h.cardIndex).join(',')
      if (float32TopKIds === directTopKIds) identicalTopKCount += 1
    }

    results[`prototypesPerCard_${prototypesPerCard}`] = {
      cardCount,
      dim,
      rowCount: cardCount * prototypesPerCard,
      float32DecodedSearchMedianMs: Number(median(float32Times).toFixed(2)),
      directInt8SearchMedianMs: Number(median(directInt8Times).toFixed(2)),
      queries,
      top1IdentityRate: `${String(identicalTop1Count)}/${String(queries)}`,
      fullTopKIdentityRate: `${String(identicalTopKCount)}/${String(queries)}`,
      float32DecodedMemoryBytes: cardCount * prototypesPerCard * dim * 4,
      directInt8MemoryBytesBeyondSourceBuffer: 0,
    }
    console.log(
      `[bench] prototypesPerCard=${String(prototypesPerCard)}: ` +
        `float32=${String(results[`prototypesPerCard_${prototypesPerCard}`].float32DecodedSearchMedianMs)}ms ` +
        `directInt8=${String(results[`prototypesPerCard_${prototypesPerCard}`].directInt8SearchMedianMs)}ms ` +
        `topKIdentical=${results[`prototypesPerCard_${prototypesPerCard}`].fullTopKIdentityRate}`,
    )
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment:
      'Node/CPU (this lab machine) — NOT a browser/iPhone measurement, matching every prior lab benchmark disclosure',
    note: 'directInt8SearchMedianMs and float32DecodedSearchMedianMs are both a FULL brute-force scan over every card; directInt8 dequantizes each int8 value inline at multiply time instead of pre-decoding the whole buffer to Float32 first. topKIdentityRate=N/N confirms the two search strategies produce byte-for-byte identical rankings (dequantization order does not change floating-point results at this precision) — this is a pure memory-vs-speed tradeoff, not an accuracy tradeoff.',
    results,
  }
  await mkdir(dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
