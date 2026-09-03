// P95 §19-21: recomputes P91's dual-prototype cost estimate from the ACTUAL production index
// format (src/data/scanner/visual-index.ts: Int8Array, VISUAL_INDEX_INT8_SCALE=127, 384-dim,
// dequantized to Float32 on load, brute-force dot-product search) rather than a fresh guess, and
// benchmarks that exact search loop's real wall-clock cost at 20k/40k/100k rows using synthetic
// Float32 vectors (same shape/dtype/algorithm as production, this lab's own Node/CPU environment —
// NOT an iPhone/browser measurement, disclosed the same way experiment 10's latency numbers are).
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

const DIM = 384
const REAL_CARD_COUNT = 19501
const CARD_ID_JSON_BYTES_PER_UUID = 39 // measured: 36-char UUID + quotes + comma, JSON array
const CARD_ID_BINARY_BYTES_PER_UUID = 16

function indexBytes(cardCount, prototypesPerCard) {
  const int8Bytes = cardCount * prototypesPerCard * DIM // 1 byte/dim, Int8Array
  const cardIdsJsonBytes = cardCount * CARD_ID_JSON_BYTES_PER_UUID
  const cardIdsBinaryBytes = cardCount * CARD_ID_BINARY_BYTES_PER_UUID
  const manifestBytesEstimate = 400 // measured order-of-magnitude from existing manifest.json shape
  return {
    prototypesPerCard,
    int8EmbeddingsBytes: int8Bytes,
    int8EmbeddingsMB: Number((int8Bytes / 1024 / 1024).toFixed(2)),
    cardIdsJsonMB: Number((cardIdsJsonBytes / 1024 / 1024).toFixed(2)),
    cardIdsBinaryMB: Number((cardIdsBinaryBytes / 1024 / 1024).toFixed(2)),
    totalWithJsonCardIdsMB: Number(
      ((int8Bytes + cardIdsJsonBytes + manifestBytesEstimate) / 1024 / 1024).toFixed(2),
    ),
    totalWithBinaryCardIdsMB: Number(
      ((int8Bytes + cardIdsBinaryBytes + manifestBytesEstimate) / 1024 / 1024).toFixed(2),
    ),
    decodedFloat32RamBytes: cardCount * prototypesPerCard * DIM * 4,
    decodedFloat32RamMB: Number(
      ((cardCount * prototypesPerCard * DIM * 4) / 1024 / 1024).toFixed(2),
    ),
  }
}

/** Reproduces src/data/scanner/visual-index.ts's exact search loop shape: one dot product per
 *  row over a decoded Float32Array, push to array, sort descending. */
function benchmarkBruteForceSearch(rowCount, dim = DIM, repeats = 5) {
  const embeddings = new Float32Array(rowCount * dim)
  for (let i = 0; i < embeddings.length; i += 1) embeddings[i] = Math.random() * 2 - 1
  const query = new Float32Array(dim)
  for (let i = 0; i < dim; i += 1) query[i] = Math.random() * 2 - 1

  const timings = []
  for (let rep = 0; rep < repeats; rep += 1) {
    const t0 = performance.now()
    const hits = []
    for (let row = 0; row < rowCount; row += 1) {
      const start = row * dim
      let dot = 0
      for (let d = 0; d < dim; d += 1) dot += embeddings[start + d] * query[d]
      hits.push({ row, similarity: dot })
    }
    hits.sort((a, b) => b.similarity - a.similarity)
    timings.push(performance.now() - t0)
  }
  timings.sort((a, b) => a - b)
  return {
    rowCount,
    medianMs: Number(timings[Math.floor(timings.length / 2)].toFixed(2)),
    minMs: Number(timings[0].toFixed(2)),
    maxMs: Number(timings[timings.length - 1].toFixed(2)),
  }
}

/** Grouped multi-prototype search (§20's "card -> max similarity across prototype rows" idea):
 *  same total row count, but scored by max-per-card instead of one row = one card. Isolates the
 *  extra grouping/reduction cost on top of the raw dot-product scan. */
function benchmarkGroupedMultiProtoSearch(cardCount, prototypesPerCard, dim = DIM, repeats = 5) {
  const rowCount = cardCount * prototypesPerCard
  const embeddings = new Float32Array(rowCount * dim)
  for (let i = 0; i < embeddings.length; i += 1) embeddings[i] = Math.random() * 2 - 1
  const query = new Float32Array(dim)
  for (let i = 0; i < dim; i += 1) query[i] = Math.random() * 2 - 1

  const timings = []
  for (let rep = 0; rep < repeats; rep += 1) {
    const t0 = performance.now()
    const bestPerCard = new Float32Array(cardCount).fill(-Infinity)
    for (let row = 0; row < rowCount; row += 1) {
      const start = row * dim
      let dot = 0
      for (let d = 0; d < dim; d += 1) dot += embeddings[start + d] * query[d]
      const card = Math.floor(row / prototypesPerCard)
      if (dot > bestPerCard[card]) bestPerCard[card] = dot
    }
    const hits = []
    for (let c = 0; c < cardCount; c += 1) hits.push({ card: c, similarity: bestPerCard[c] })
    hits.sort((a, b) => b.similarity - a.similarity)
    timings.push(performance.now() - t0)
  }
  timings.sort((a, b) => a - b)
  return {
    cardCount,
    prototypesPerCard,
    totalRows: rowCount,
    medianMs: Number(timings[Math.floor(timings.length / 2)].toFixed(2)),
  }
}

async function main() {
  const costEstimates = {
    current_singlePrototype: indexBytes(REAL_CARD_COUNT, 1),
    dualPrototype_pristinePlus1Aux: indexBytes(REAL_CARD_COUNT, 2),
    fivePrototype_pristinePlus4Aux: indexBytes(REAL_CARD_COUNT, 5),
    sevenPrototype_maxSimAllProtos: indexBytes(REAL_CARD_COUNT, 7),
  }

  const searchBenchmarks = {
    rowCount20k: benchmarkBruteForceSearch(20000),
    rowCount40k: benchmarkBruteForceSearch(40000),
    rowCount100k: benchmarkBruteForceSearch(100000),
    realCorpusSinglePrototype_19501: benchmarkBruteForceSearch(REAL_CARD_COUNT),
    groupedDualPrototype_19501cards_39002rows: benchmarkGroupedMultiProtoSearch(REAL_CARD_COUNT, 2),
    groupedFivePrototype_19501cards_97505rows: benchmarkGroupedMultiProtoSearch(REAL_CARD_COUNT, 5),
  }

  const report = {
    generatedAt: new Date().toISOString(),
    note: "Search timings are this lab's own Node/CPU environment (V8, single-threaded synchronous loop), NOT an iPhone/browser/WASM measurement — D-101/P84 already measured the REAL single-prototype production search at 16ms/19,501 cards on a real device; these numbers are for RELATIVE scaling (does doubling/quintupling rows meaningfully change cost), not absolute device latency.",
    productionFormatAssumptions: {
      quantization:
        'Int8Array, VISUAL_INDEX_INT8_SCALE=127, dequantized to Float32 on load (src/data/scanner/visual-index.ts)',
      embeddingDim: DIM,
      realCanonicalCardCount: REAL_CARD_COUNT,
    },
    costEstimates,
    searchBenchmarks,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '16-cost-and-search-benchmark.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
