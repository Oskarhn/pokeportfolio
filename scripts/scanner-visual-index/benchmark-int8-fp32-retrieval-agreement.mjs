/**
 * P100 §11 / §21: the 1,000+-query FP32-vs-INT8 RETRIEVAL agreement test P97 disclosed it did NOT
 * run ("requires 1,000+ real query embeddings against a real ... reference corpus"). Reuses the
 * P91/P95 4,296-card research corpus's ALREADY-CACHED reference embeddings
 * (scripts/scanner-recognition-lab/.cache/reference-index-cls.json) — no hosted credentials, no
 * new network fetch, no new model inference needed.
 *
 * Method: for each of the corpus's ~4,296 cards, that card's own cached FP32 embedding is used as
 * the QUERY (a genuine "how does this real image resolve against the full corpus" question, not
 * synthetic noise). Two full-corpus brute-force searches are run per query:
 *   FP32 index  — the raw cached Float32 vectors, unquantized.
 *   INT8 index  — every reference vector round-tripped through the PRODUCTION quantize/dequantize
 *                 contract (`quantizeEmbedding`/`VISUAL_INDEX_INT8_SCALE=127`, imported directly
 *                 from src/data/scanner/visual-index.ts — the actual shipped functions, not a
 *                 reimplementation).
 * Reports TOP1 agreement, TOP5 overlap, rank-change distribution, and the worst per-query
 * similarity error between the two searches' own top-1 candidate.
 *
 * Run: node scripts/scanner-visual-index/benchmark-int8-fp32-retrieval-agreement.mjs
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quantizeEmbedding, VISUAL_INDEX_INT8_SCALE } from '../../src/data/scanner/visual-index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const LAB_CACHE_DIR = join(here, '..', 'scanner-recognition-lab', '.cache')
const REPORT_PATH = join(
  here,
  '..',
  'scanner-recognition-lab',
  'reports',
  '21-int8-fp32-retrieval-agreement.json',
)

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

function searchAll(queryVec, vectors) {
  const hits = []
  for (const [cardId, refVec] of vectors) hits.push({ cardId, similarity: dot(queryVec, refVec) })
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits
}

async function main() {
  const raw = JSON.parse(await readFile(join(LAB_CACHE_DIR, 'reference-index-cls.json'), 'utf-8'))
  const cardIds = raw.cardIds
  const fp32Vectors = new Map()
  const int8DecodedVectors = new Map()
  for (let i = 0; i < cardIds.length; i += 1) {
    const cardId = cardIds[i]
    const fp32 = Float32Array.from(raw.vectors[i])
    fp32Vectors.set(cardId, fp32)
    const quantized = quantizeEmbedding(fp32)
    const decoded = new Float32Array(quantized.length)
    for (let d = 0; d < quantized.length; d += 1)
      decoded[d] = quantized[d] / VISUAL_INDEX_INT8_SCALE
    int8DecodedVectors.set(cardId, decoded)
  }
  console.log(`[agreement] ${cardIds.length} cards loaded from cached reference index`)

  let top1Agree = 0
  let top5OverlapSum = 0
  const rankChanges = []
  let worstTop1SimilarityError = 0
  let queriesRun = 0

  for (const cardId of cardIds) {
    const queryVec = fp32Vectors.get(cardId)

    const fp32Hits = searchAll(queryVec, fp32Vectors)
    const int8Hits = searchAll(queryVec, int8DecodedVectors)

    const fp32Top1 = fp32Hits[0]?.cardId
    const int8Top1 = int8Hits[0]?.cardId
    if (fp32Top1 === int8Top1) top1Agree += 1

    const fp32Top5 = new Set(fp32Hits.slice(0, 5).map((h) => h.cardId))
    const int8Top5 = fp32Hits.slice(0, 5).map((h) => h.cardId) // placeholder overwritten below
    const int8Top5Set = new Set(int8Hits.slice(0, 5).map((h) => h.cardId))
    let overlap = 0
    for (const id of fp32Top5) if (int8Top5Set.has(id)) overlap += 1
    top5OverlapSum += overlap / 5

    // Rank change: where did the FP32-search's own top1 card land in the INT8 search's ranking?
    const int8RankOfFp32Top1 = int8Hits.findIndex((h) => h.cardId === fp32Top1) + 1
    rankChanges.push(int8RankOfFp32Top1 - 1) // 0 = no change

    // Worst per-query similarity error: compare the FP32-search top1 candidate's similarity as
    // computed by each search (fp32-vs-fp32 vs fp32-query-vs-int8-decoded-reference).
    const fp32Sim = fp32Hits[0]?.similarity ?? 0
    const int8SimForSameCandidate = dot(queryVec, int8DecodedVectors.get(fp32Top1))
    const err = Math.abs(fp32Sim - int8SimForSameCandidate)
    if (err > worstTop1SimilarityError) worstTop1SimilarityError = err

    queriesRun += 1
    if (queriesRun % 1000 === 0) console.log(`[agreement] ${queriesRun}/${cardIds.length}`)
    void int8Top5 // unused placeholder value kept only for clarity of intent above
  }

  const rankChangeHistogram = { unchanged: 0, moved1to5: 0, moved6to20: 0, movedOver20: 0 }
  for (const c of rankChanges) {
    if (c === 0) rankChangeHistogram.unchanged += 1
    else if (c <= 5) rankChangeHistogram.moved1to5 += 1
    else if (c <= 20) rankChangeHistogram.moved6to20 += 1
    else rankChangeHistogram.movedOver20 += 1
  }

  const report = {
    generatedAt: new Date().toISOString(),
    queriesRun,
    corpusSize: cardIds.length,
    top1AgreementPct: Number(((100 * top1Agree) / queriesRun).toFixed(2)),
    top5MeanOverlapPct: Number(((100 * top5OverlapSum) / queriesRun).toFixed(2)),
    rankChangeHistogram,
    worstTop1SimilarityError: Number(worstTop1SimilarityError.toFixed(6)),
    note:
      'Query = each corpus card\'s own cached FP32 embedding (a real, undistorted "how does this ' +
      'exact image resolve" question). FP32 index = raw cached vectors. INT8 index = every ' +
      'reference vector round-tripped through the PRODUCTION quantizeEmbedding/' +
      'VISUAL_INDEX_INT8_SCALE=127 contract (src/data/scanner/visual-index.ts, imported directly, ' +
      'not reimplemented).',
  }
  await mkdir(dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
