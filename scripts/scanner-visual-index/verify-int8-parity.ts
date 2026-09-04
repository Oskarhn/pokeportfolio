/**
 * P102 §8: numerical parity between the OLD production search shape (decode the whole int8 index
 * to Float32 up front, then dot-product each row — what `searchVisualIndex` did before this
 * session) and the NEW one (dot-product directly against the raw Int8Array, dequantizing each
 * component inline — what `searchVisualIndex` in src/data/scanner/visual-index.ts does now).
 *
 * The OLD approach is reimplemented locally here, verbatim from what this session removed from
 * production (see the git history of src/data/scanner/visual-index.ts), for A/B comparison only —
 * it is not itself production code and must never be imported from anywhere else.
 *
 * Real data only, no synthetic/random queries for the legacy-v1 half: every query is one of the
 * REAL 4,296 cached DINOv2 embeddings from the P91/P95 recognition-lab corpus
 * (scripts/scanner-recognition-lab/.cache/reference-index-cls.json — a real cached embedding run,
 * not re-embedded here), searched against the REAL committed 19,501-card production index. A
 * second pass repeats the same 4,296 queries against a SYNTHETIC 2-prototype-per-card index built
 * from the real int8 bytes (P100's own `buildSyntheticMultiProto` technique, reused verbatim) —
 * exercising the dual-prototype max-reduction path direct-int8 search must also get right, since no
 * real dual-prototype index exists yet to test against (owner build pending).
 *
 * Run: pnpm tsx scripts/scanner-visual-index/verify-int8-parity.ts
 * Throwaway verification script — writes one JSON report (gitignored), never touches the
 * committed index.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeVisualIndex,
  searchVisualIndex,
  type DecodedVisualIndex,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'

const here = dirname(fileURLToPath(import.meta.url))
const GENERATED_DIR = join(here, 'generated', 'visual-v1')
const CACHE_DIR = join(here, '..', 'scanner-recognition-lab', '.cache')
const REPORT_PATH = join(
  here,
  '..',
  'scanner-recognition-lab',
  'reports',
  '21-int8-parity-verification.json',
)
const INT8_SCALE = 127
const TOP_K = 20

interface OldHit {
  cardId: string
  similarity: number
  winningPrototype: number
}

interface Query {
  cardId: string
  vector: Float32Array
}

/** OLD production shape, reimplemented verbatim for comparison only (see module header). */
function searchFloat32Decoded(
  queryVec: Float32Array,
  int8Embeddings: Int8Array,
  cardIds: readonly string[],
  prototypesPerCard: number,
  dim: number,
  topK: number,
): OldHit[] {
  const totalValues = cardIds.length * prototypesPerCard * dim
  const decoded = new Float32Array(totalValues)
  for (let i = 0; i < totalValues; i += 1) decoded[i] = (int8Embeddings[i] ?? 0) / INT8_SCALE
  const hits: OldHit[] = []
  for (let cardIndex = 0; cardIndex < cardIds.length; cardIndex += 1) {
    let best = -Infinity
    let bestProto = 0
    const rowStart = cardIndex * prototypesPerCard
    for (let proto = 0; proto < prototypesPerCard; proto += 1) {
      const start = (rowStart + proto) * dim
      let dotp = 0
      for (let d = 0; d < dim; d += 1) dotp += (decoded[start + d] ?? 0) * (queryVec[d] ?? 0)
      if (dotp > best) {
        best = dotp
        bestProto = proto
      }
    }
    hits.push({ cardId: cardIds[cardIndex] ?? '?', similarity: best, winningPrototype: bestProto })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits.slice(0, topK)
}

function overlap(a: readonly string[], b: readonly string[]): number {
  const setB = new Set(b)
  let count = 0
  for (const id of a) if (setB.has(id)) count += 1
  return count / a.length
}

async function loadRealIndex(): Promise<{
  manifest: VisualIndexManifest
  cardIds: string[]
  int8: Int8Array
}> {
  const pointer = JSON.parse(await readFile(join(GENERATED_DIR, 'current.json'), 'utf-8')) as {
    contentId: string
  }
  const generationDir = join(GENERATED_DIR, 'generations', pointer.contentId)
  const manifest = JSON.parse(
    await readFile(join(generationDir, 'manifest.json'), 'utf-8'),
  ) as VisualIndexManifest
  const cardIds = JSON.parse(
    await readFile(join(generationDir, 'card-ids.json'), 'utf-8'),
  ) as string[]
  const raw = await readFile(join(generationDir, 'embeddings.bin'))
  const int8 = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return { manifest, cardIds, int8 }
}

/** P100's own technique, reused verbatim: card 0's real int8 bytes for proto 0, a small
 *  deterministic perturbation for proto 1 — realistic-magnitude values, not degenerate zeros. */
function buildSyntheticDualProto(realInt8: Int8Array, cardCount: number, dim: number): Int8Array {
  const out = new Int8Array(cardCount * 2 * dim)
  for (let card = 0; card < cardCount; card += 1) {
    const srcStart = card * dim
    for (let d = 0; d < dim; d += 1) {
      const base = realInt8[srcStart + d] ?? 0
      out[card * 2 * dim + d] = base
      out[(card * 2 + 1) * dim + d] = Math.max(-127, Math.min(127, base - ((d * 7) % 11) + 5))
    }
  }
  return out
}

async function loadQueries(): Promise<Query[]> {
  const corpus = JSON.parse(await readFile(join(CACHE_DIR, 'corpus.json'), 'utf-8')) as unknown[]
  const cached = JSON.parse(
    await readFile(join(CACHE_DIR, 'reference-index-cls.json'), 'utf-8'),
  ) as { cardIds: string[]; vectors: number[][] }
  if (cached.cardIds.length !== corpus.length) {
    throw new Error(
      `Cached reference index (${cached.cardIds.length}) does not match corpus.json (${corpus.length}) — stale cache.`,
    )
  }
  return cached.cardIds.map((cardId, i) => ({
    cardId,
    vector: Float32Array.from(cached.vectors[i] ?? []),
  }))
}

function runPass(
  label: string,
  decoded: DecodedVisualIndex,
  int8ForOld: Int8Array,
  cardIds: readonly string[],
  prototypesPerCard: number,
  dim: number,
  queries: readonly Query[],
) {
  let top1Agree = 0
  let top1WithinRealCorpusOnly = 0
  let top3OverlapSum = 0
  let top5OverlapSum = 0
  let top20OverlapSum = 0
  let winningProtoAgree = 0
  let worstSimilarityError = 0
  const disagreements: {
    query: string
    oldTop1: string | null
    newTop1: string | null
    oldSimilarity: number | null
    newSimilarity: number | null
  }[] = []

  for (const q of queries) {
    const oldHits = searchFloat32Decoded(
      q.vector,
      int8ForOld,
      cardIds,
      prototypesPerCard,
      dim,
      TOP_K,
    )
    const newHits = searchVisualIndex(decoded, q.vector, TOP_K)

    const oldTop1 = oldHits[0]
    const newTop1 = newHits[0]
    const top1Match = oldTop1?.cardId === newTop1?.cardId
    if (top1Match) top1Agree += 1
    else {
      disagreements.push({
        query: q.cardId,
        oldTop1: oldTop1?.cardId ?? null,
        newTop1: newTop1?.cardId ?? null,
        oldSimilarity: oldTop1?.similarity ?? null,
        newSimilarity: newTop1?.similarity ?? null,
      })
    }
    // The query card is itself in the corpus/index in the legacy-v1 pass — a query that finds
    // itself as TOP1 under BOTH implementations is an additional, stronger sanity signal.
    if (oldTop1?.cardId === q.cardId && newTop1?.cardId === q.cardId) top1WithinRealCorpusOnly += 1

    top3OverlapSum += overlap(
      oldHits.slice(0, 3).map((h) => h.cardId),
      newHits.slice(0, 3).map((h) => h.cardId),
    )
    top5OverlapSum += overlap(
      oldHits.slice(0, 5).map((h) => h.cardId),
      newHits.slice(0, 5).map((h) => h.cardId),
    )
    top20OverlapSum += overlap(
      oldHits.map((h) => h.cardId),
      newHits.map((h) => h.cardId),
    )

    if (oldTop1 !== undefined && newTop1 !== undefined) {
      const err = Math.abs(oldTop1.similarity - newTop1.similarity)
      if (err > worstSimilarityError) worstSimilarityError = err
    }
    if (prototypesPerCard > 1) {
      const oldWinner = oldHits.find((h) => h.cardId === newTop1?.cardId)
      if (oldWinner !== undefined) {
        // NEW searchVisualIndex does not expose winningPrototype (production never needs it) — so
        // this pass only asserts that OLD's own recorded winning prototype for the SAME card the
        // new implementation chose as TOP1 is internally consistent (a proto index in range),
        // matching the report's own disclosed scope.
        if (oldWinner.winningPrototype === 0 || oldWinner.winningPrototype === 1) {
          winningProtoAgree += 1
        }
      }
    }
  }

  return {
    label,
    queries: queries.length,
    prototypesPerCard,
    top1Agreement: `${String(top1Agree)}/${String(queries.length)} (${((top1Agree / queries.length) * 100).toFixed(2)}%)`,
    top1SelfRecallBothImplementations:
      prototypesPerCard === 1
        ? `${String(top1WithinRealCorpusOnly)}/${String(queries.length)}`
        : 'n/a (synthetic index, cardId identity across implementations is what is checked, not self-recall)',
    top3SetOverlap: `${((top3OverlapSum / queries.length) * 100).toFixed(2)}%`,
    top5SetOverlap: `${((top5OverlapSum / queries.length) * 100).toFixed(2)}%`,
    top20SetOverlap: `${((top20OverlapSum / queries.length) * 100).toFixed(2)}%`,
    winningPrototypeInRange:
      prototypesPerCard > 1
        ? `${String(winningProtoAgree)}/${String(queries.length)}`
        : 'n/a (single-prototype pass)',
    worstTop1SimilarityError: worstSimilarityError,
    disagreementCount: disagreements.length,
    disagreements: disagreements.slice(0, 20),
  }
}

async function main() {
  console.log('[parity] loading real committed index and real cached corpus embeddings...')
  const { manifest, cardIds, int8 } = await loadRealIndex()
  const queries = await loadQueries()
  console.log(
    `[parity] index: ${cardIds.length} cards, dim ${manifest.embeddingDim}; queries: ${queries.length}`,
  )

  const decodedV1 = decodeVisualIndex(manifest, cardIds, int8)
  const legacyResult = runPass(
    'legacy-v1 (real 19,501-card index)',
    decodedV1,
    int8,
    cardIds,
    1,
    manifest.embeddingDim,
    queries,
  )
  console.log(
    `[parity] legacy-v1: TOP1=${legacyResult.top1Agreement} TOP5=${legacyResult.top5SetOverlap} worstErr=${legacyResult.worstTop1SimilarityError}`,
  )

  const dualInt8 = buildSyntheticDualProto(int8, cardIds.length, manifest.embeddingDim)
  const dualManifest = {
    ...manifest,
    schemaVersion: 2,
    payloadFormat: 'multi-prototype-v2',
    prototypesPerCard: 2,
    prototypeStrategy: 'pristinePlus1Aux',
    prototypeStrategyVersion: 'synthetic-parity-check-v1',
    rowCount: cardIds.length * 2,
  }
  const decodedV2 = decodeVisualIndex(dualManifest, cardIds, dualInt8)
  const dualResult = runPass(
    'synthetic schema-v2 (2 prototypes/card, real card count)',
    decodedV2,
    dualInt8,
    cardIds,
    2,
    manifest.embeddingDim,
    queries,
  )
  console.log(
    `[parity] dual-v2: TOP1=${dualResult.top1Agreement} TOP5=${dualResult.top5SetOverlap} worstErr=${dualResult.worstTop1SimilarityError}`,
  )

  const report = {
    generatedAt: new Date().toISOString(),
    note: 'OLD = decode-whole-index-to-Float32-then-search (removed from production this session), NEW = production searchVisualIndex (direct-int8, this session). Both driven by the SAME real 4,296-card cached DINOv2 query set; legacy-v1 pass runs against the REAL committed 19,501-card index, the schema-v2 pass against a synthetic 2-prototype index built from the real int8 bytes (no real dual-prototype index exists yet — owner build pending).',
    legacyV1: legacyResult,
    syntheticSchemaV2: dualResult,
  }
  await mkdir(dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(`[parity] report written to ${REPORT_PATH}`)

  if (legacyResult.disagreementCount > 0 || dualResult.disagreementCount > 0) {
    console.error('[parity] FAIL: TOP1 disagreements found between OLD and NEW search.')
    process.exitCode = 1
  } else {
    console.log('[parity] PASS: 100% TOP1 agreement on both passes.')
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
