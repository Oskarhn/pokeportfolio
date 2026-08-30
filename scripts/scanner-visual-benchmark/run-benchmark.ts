/**
 * M15 visual-recognition benchmark (P76, prompt §11–§14). Compares FOUR recognition methods on a
 * real, diverse TCGdex reference corpus under synthetic camera-capture distortions:
 *
 *   A. OCR-first        — today's shipped production path (D-094): full-frame Tesseract text,
 *                          parsed exactly like ocr-engine.ts's fallback, scored by the real
 *                          domain matcher with no visual evidence.
 *   B. Perceptual (dHash) — a cheap ML-free visual fingerprint, ranked by Hamming distance alone.
 *   C. Visual embedding   — DINOv2-small cosine similarity against the reference index alone.
 *   D. Hybrid             — visual top-K shortlist merged into the candidate pool, reranked by
 *                          the SAME real domain matcher (src/domain/scanner/engine.ts) with the
 *                          visual evidence channel now wired in (D-097).
 *
 * Every method reuses REAL production code from src/domain/scanner (§30: one domain scoring
 * implementation) — nothing here reimplements the matcher. Run: `pnpm scanner:visual:benchmark`.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  matchScannerObservation,
  computeDHash,
  hammingDistance,
  dHashSimilarity,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../src/domain/scanner/index'
import { splitFullFrameCardText, cleanSignal } from '../../src/features/scanner/analyze'
import { buildCorpus } from './lib/fetch-references.mjs'
import { augmentAll, AUGMENTATION_PROFILES } from './lib/augment.mjs'
import {
  embedImageBuffer,
  warmUpModel,
  VISUAL_MODEL_ID,
  VISUAL_MODEL_REVISION,
} from './lib/embed.mjs'
import { ocrFullFrame, disposeOcr } from './lib/ocr.mjs'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, 'reports')

interface CorpusRow {
  cardId: string
  name: string
  localId: string
  setId: string
  setName: string
  language: string
  imagePath: string
}

function toCandidateRecord(row: CorpusRow): ScannerCandidateRecord {
  return {
    cardId: row.cardId,
    name: row.name,
    localId: row.localId,
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: row.language === 'ja' ? 'ja' : 'en',
    setId: row.setId,
    setName: row.setName,
    variantCount: 1,
  }
}

async function grayscaleGrid(buffer: Buffer, width = 32, height = 32) {
  const raw = await sharp(buffer)
    .resize(width, height, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()
  return new Uint8ClampedArray(raw)
}

interface MethodTally {
  top1: number
  top3: number
  top5: number
  total: number
}
function freshTally(): MethodTally {
  return { top1: 0, top3: 0, top5: 0, total: 0 }
}
function record(tally: MethodTally, rank: number | null) {
  tally.total += 1
  if (rank === null) return
  if (rank <= 1) tally.top1 += 1
  if (rank <= 3) tally.top3 += 1
  if (rank <= 5) tally.top5 += 1
}
function rankOf(orderedIds: string[], trueId: string): number | null {
  const index = orderedIds.indexOf(trueId)
  return index === -1 ? null : index + 1
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--max-per-set='))
  const maxPerSet = limitArg ? Number(limitArg.split('=')[1]) : 999
  console.log(`[bench] building corpus (maxPerSet=${maxPerSet})...`)
  const corpus = (await buildCorpus({ maxPerSet })) as CorpusRow[]
  console.log(`[bench] corpus size: ${corpus.length}`)

  console.log('[bench] warming up visual model...')
  const loadStart = performance.now()
  await warmUpModel()
  const modelColdLoadMs = performance.now() - loadStart

  const candidatePool = corpus.map(toCandidateRecord)

  // ── Reference embeddings + dHash (the "index") ──────────────────────────────────────────────
  const referenceEmbeddings = new Map<string, Float32Array>()
  const referenceHashes = new Map<string, bigint>()
  let embedWarmTotalMs = 0
  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const t0 = performance.now()
    referenceEmbeddings.set(row.cardId, await embedImageBuffer(buf))
    embedWarmTotalMs += performance.now() - t0
    const grid = await grayscaleGrid(buf, 9, 8)
    referenceHashes.set(row.cardId, computeDHash(grid, 9, 8))
  }
  const avgRefEmbedMs = embedWarmTotalMs / corpus.length

  // ── Method tallies ───────────────────────────────────────────────────────────────────────────
  const tallies: Record<'ocr' | 'perceptual' | 'visual' | 'hybrid', MethodTally> = {
    ocr: freshTally(),
    perceptual: freshTally(),
    visual: freshTally(),
    hybrid: freshTally(),
  }
  const subsetTallies: Record<string, Record<string, MethodTally>> = {}
  function subsetTally(subset: string, method: string): MethodTally {
    const bySubset = (subsetTallies[subset] ??= {})
    return (bySubset[method] ??= freshTally())
  }

  let searchTimeTotalMs = 0
  let queryEmbedTimeTotalMs = 0
  let searchCount = 0
  let queryCount = 0
  let quantAgreementTop1 = 0

  const REPRINT_CARD_IDS = new Set(corpus.filter((r) => r.setId === 'cel25cc').map((r) => r.cardId))

  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const augmented = await augmentAll(buf, row.cardId)

    for (const { buffer } of augmented) {
      queryCount += 1
      const trueId = row.cardId

      // --- visual embedding + search (timed separately: inference vs. pure linear scan) ---
      const embedStart = performance.now()
      const queryVec = await embedImageBuffer(buffer)
      queryEmbedTimeTotalMs += performance.now() - embedStart

      const searchStart = performance.now()
      const visualRanked = [...referenceEmbeddings.entries()]
        .map(([cardId, refVec]) => {
          let dot = 0
          for (let i = 0; i < refVec.length; i += 1) dot += (refVec[i] ?? 0) * (queryVec[i] ?? 0)
          return { cardId, similarity: dot }
        })
        .sort((a, b) => b.similarity - a.similarity)
      searchTimeTotalMs += performance.now() - searchStart
      searchCount += 1

      // Quantization-agreement check (int8 vs fp32 top1) — quick per-query spot check.
      const int8Query = new Int8Array(queryVec.length)
      for (let i = 0; i < queryVec.length; i += 1) {
        int8Query[i] = Math.max(-127, Math.min(127, Math.round((queryVec[i] ?? 0) * 127)))
      }
      const int8Ranked = [...referenceEmbeddings.entries()]
        .map(([cardId, refVec]) => {
          let dot = 0
          for (let i = 0; i < refVec.length; i += 1) {
            dot += (refVec[i] ?? 0) * ((int8Query[i] ?? 0) / 127)
          }
          return { cardId, similarity: dot }
        })
        .sort((a, b) => b.similarity - a.similarity)
      if (visualRanked[0]?.cardId === int8Ranked[0]?.cardId) quantAgreementTop1 += 1

      // --- perceptual hash ---
      const queryGrid = await grayscaleGrid(buffer, 9, 8)
      const queryHash = computeDHash(queryGrid, 9, 8)
      const perceptualRanked = [...referenceHashes.entries()]
        .map(([cardId, refHash]) => ({
          cardId,
          similarity: dHashSimilarity(hammingDistance(queryHash, refHash)),
        }))
        .sort((a, b) => b.similarity - a.similarity)

      // --- OCR ---
      const ocrResult = await ocrFullFrame(buffer)
      const split = splitFullFrameCardText(ocrResult.text)
      const observation = {
        rawNameText: cleanSignal(split.name, 1),
        rawCollectorNumberText: cleanSignal(split.number, 1),
        rawSetText: null,
        languageHint: 'en' as const,
      }

      // --- A: OCR-first (real domain matcher, no visual evidence) ---
      const ocrMatch = matchScannerObservation(observation, candidatePool)
      const ocrOrder = ocrMatch.candidates.map((c) => c.card.cardId)
      // OCR-first's real production shortlist is capped at 5; for TOP5/TOP3/TOP1 measurement we
      // need the FULL ranked order, so re-rank the whole pool the same way once more, uncapped,
      // by reusing the same signals (rankScannerCandidates already returns bounded top-5, which
      // is exactly what production shows — so "not in top 5" is scored as a genuine miss here,
      // matching what a real user would actually see).
      record(tallies.ocr, rankOf(ocrOrder, trueId))
      record(subsetTally(row.setId, 'ocr'), rankOf(ocrOrder, trueId))

      // --- B: perceptual only ---
      record(tallies.perceptual, rankOf(perceptualRanked.map((h) => h.cardId).slice(0, 5), trueId))

      // --- C: visual only ---
      record(tallies.visual, rankOf(visualRanked.map((h) => h.cardId).slice(0, 5), trueId))
      record(
        subsetTally(row.setId, 'visual'),
        rankOf(visualRanked.map((h) => h.cardId).slice(0, 5), trueId),
      )

      // --- D: hybrid (visual top-30 shortlist + real domain matcher rerank) ---
      const shortlist = visualRanked.slice(0, 30)
      const visualScores: VisualEvidenceByCard = new Map(
        shortlist.map((hit) => [hit.cardId, hit.similarity]),
      )
      const shortlistPool = candidatePool.filter((c) => visualScores.has(c.cardId))
      const hybridMatch = matchScannerObservation(observation, shortlistPool, visualScores)
      const hybridOrder = hybridMatch.candidates.map((c) => c.card.cardId)
      record(tallies.hybrid, rankOf(hybridOrder, trueId))
      record(subsetTally(row.setId, 'hybrid'), rankOf(hybridOrder, trueId))
      if (REPRINT_CARD_IDS.has(trueId) || row.setId === 'cel25cc') {
        record(subsetTally('same-art-reprint', 'ocr'), rankOf(ocrOrder, trueId))
        record(
          subsetTally('same-art-reprint', 'visual'),
          rankOf(visualRanked.map((h) => h.cardId).slice(0, 5), trueId),
        )
        record(subsetTally('same-art-reprint', 'hybrid'), rankOf(hybridOrder, trueId))
      }
    }
  }

  const avgSearchMs = searchTimeTotalMs / searchCount
  const quantAgreementPct = (100 * quantAgreementTop1) / searchCount

  const report = {
    generatedAt: new Date().toISOString(),
    model: { id: VISUAL_MODEL_ID, revision: VISUAL_MODEL_REVISION, dim: 384, dtype: 'q8' },
    corpus: {
      referenceCount: corpus.length,
      sets: [...new Set(corpus.map((r) => r.setId))],
      augmentationProfiles: AUGMENTATION_PROFILES,
      queryCount,
    },
    performanceDesktop: {
      // "Desktop, Node onnxruntime-node CPU execution provider" — NOT a browser/WASM/iPhone
      // measurement (prompt §46). Real WASM timing needs a browser profile; iPhone needs the
      // owner's device test.
      modelColdLoadMs: Math.round(modelColdLoadMs),
      avgReferenceEmbedMs: Number(avgRefEmbedMs.toFixed(1)),
      avgQueryEmbedMs: Number((queryEmbedTimeTotalMs / queryCount).toFixed(1)),
      avgIndexSearchOnlyMs: Number(avgSearchMs.toFixed(3)),
      int8VsFp32Top1AgreementPct: Number(quantAgreementPct.toFixed(1)),
    },
    methods: Object.fromEntries(
      Object.entries(tallies).map(([method, t]) => [
        method,
        {
          top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)),
          top3Pct: Number(((100 * t.top3) / t.total).toFixed(1)),
          top5Pct: Number(((100 * t.top5) / t.total).toFixed(1)),
          n: t.total,
        },
      ]),
    ),
    subsets: Object.fromEntries(
      Object.entries(subsetTallies).map(([subset, methods]) => [
        subset,
        Object.fromEntries(
          Object.entries(methods).map(([method, t]) => [
            method,
            {
              top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)),
              top3Pct: Number(((100 * t.top3) / t.total).toFixed(1)),
              top5Pct: Number(((100 * t.top5) / t.total).toFixed(1)),
              n: t.total,
            },
          ]),
        ),
      ]),
    ),
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, 'benchmark-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await disposeOcr()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
