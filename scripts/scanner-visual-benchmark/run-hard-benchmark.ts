/**
 * M15 HARD visual-recognition benchmark (P79 §7). The P76 benchmark (run-benchmark.ts) compares
 * methods on synthetic distortions of an already-tight, card-only reference image — it cannot
 * exercise the failure class the owner's real iPhone actually hit (a captured frame with real
 * background around an imperfectly-aligned, mildly tilted card). This script builds THAT harder
 * query shape instead (hard-augment.mjs) and compares FIVE preprocessing methods before the SAME
 * real production embedding/matching code runs:
 *
 *   A. simple crop        — crop to the nominal (guide) rect only, exactly what the pre-P79
 *                            pipeline fed the embedder.
 *   B. tightened crop      — crop to a 10%-inset nominal rect (a crude "shrink the guide a bit"
 *                            heuristic, no real edge detection).
 *   C. rectified crop      — the REAL src/domain/scanner/rectify.ts detect+warp pipeline this
 *                            session shipped, run exactly as the browser worker path would.
 *   D. rectified + OCR + rerank — the rectified image fed to BOTH OCR and the visual channel,
 *                            reranked by the SAME real domain matcher (src/domain/scanner/engine).
 *
 * Run: `pnpm scanner:visual:benchmark:hard`. Does not touch or replace the P76 benchmark/report.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  matchScannerObservation,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../src/domain/scanner/index'
import { rectifyCard, type RectPixelRect, type RgbaImage } from '../../src/domain/scanner/rectify'
import { splitFullFrameCardText, cleanSignal } from '../../src/features/scanner/analyze'
import { buildCorpus } from './lib/fetch-references.mjs'
import { hardAugmentAll, HARD_AUGMENTATION_PROFILES } from './lib/hard-augment.mjs'
import {
  embedImageBuffer,
  warmUpModel,
  VISUAL_MODEL_ID,
  VISUAL_MODEL_REVISION,
} from './lib/embed.mjs'
import { ocrFullFrame, disposeOcr } from './lib/ocr.mjs'

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
function summarize(t: MethodTally) {
  return {
    top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)),
    top3Pct: Number(((100 * t.top3) / t.total).toFixed(1)),
    top5Pct: Number(((100 * t.top5) / t.total).toFixed(1)),
    n: t.total,
  }
}

function clampRect(rect: RectPixelRect, boundsWidth: number, boundsHeight: number): RectPixelRect {
  const left = Math.max(0, Math.min(Math.round(rect.left), boundsWidth - 1))
  const top = Math.max(0, Math.min(Math.round(rect.top), boundsHeight - 1))
  const right = Math.max(left + 1, Math.min(Math.round(rect.left + rect.width), boundsWidth))
  const bottom = Math.max(top + 1, Math.min(Math.round(rect.top + rect.height), boundsHeight))
  return { left, top, width: right - left, height: bottom - top }
}

function insetRect(rect: RectPixelRect, fraction: number): RectPixelRect {
  const padX = rect.width * fraction
  const padY = rect.height * fraction
  return {
    left: rect.left + padX,
    top: rect.top + padY,
    width: Math.max(1, rect.width - padX * 2),
    height: Math.max(1, rect.height - padY * 2),
  }
}

function expandRect(
  rect: RectPixelRect,
  fraction: number,
  boundsWidth: number,
  boundsHeight: number,
): RectPixelRect {
  const padX = rect.width * fraction
  const padY = rect.height * fraction
  const left = Math.max(0, rect.left - padX)
  const top = Math.max(0, rect.top - padY)
  const right = Math.min(boundsWidth, rect.left + rect.width + padX)
  const bottom = Math.min(boundsHeight, rect.top + rect.height + padY)
  return { left, top, width: right - left, height: bottom - top }
}

async function extractJpeg(buffer: Buffer, rect: RectPixelRect, canvasW: number, canvasH: number) {
  const clamped = clampRect(rect, canvasW, canvasH)
  return sharp(buffer)
    .extract({
      left: clamped.left,
      top: clamped.top,
      width: clamped.width,
      height: clamped.height,
    })
    .jpeg({ quality: 90 })
    .toBuffer()
}

const RECTIFY_EXPAND_FRACTION = 0.18
const RECTIFY_OUTPUT_WIDTH = 700
const RECTIFY_OUTPUT_HEIGHT = 980

/** Runs the REAL rectify.ts detect+warp pipeline over a region of `buffer`, mirroring exactly
 *  what rectify-capture.ts does in the browser (expand → RGBA → detect+warp → JPEG). */
async function rectifyBuffer(
  buffer: Buffer,
  nominalRect: RectPixelRect,
  canvasW: number,
  canvasH: number,
): Promise<{ jpeg: Buffer; usedFallback: boolean }> {
  const expanded = clampRect(
    expandRect(nominalRect, RECTIFY_EXPAND_FRACTION, canvasW, canvasH),
    canvasW,
    canvasH,
  )
  const { data, info } = await sharp(buffer)
    .extract({
      left: expanded.left,
      top: expanded.top,
      width: expanded.width,
      height: expanded.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgba: RgbaImage = {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  }
  const nominalLocal: RectPixelRect = {
    left: nominalRect.left - expanded.left,
    top: nominalRect.top - expanded.top,
    width: nominalRect.width,
    height: nominalRect.height,
  }
  const margin = Math.max(
    12,
    Math.round(
      Math.min(expanded.width - nominalRect.width, expanded.height - nominalRect.height) / 2,
    ),
  )
  const rectified = rectifyCard(
    rgba,
    nominalLocal,
    RECTIFY_OUTPUT_WIDTH,
    RECTIFY_OUTPUT_HEIGHT,
    margin,
  )
  const jpeg = await sharp(Buffer.from(rectified.image.data.buffer), {
    raw: { width: RECTIFY_OUTPUT_WIDTH, height: RECTIFY_OUTPUT_HEIGHT, channels: 4 },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
  return { jpeg, usedFallback: rectified.usedFallback }
}

async function main() {
  const maxPerSetArg = process.argv.find((a) => a.startsWith('--max-per-set='))
  const maxPerSet = maxPerSetArg ? Number(maxPerSetArg.split('=')[1]) : 999
  console.log(`[hard-bench] building corpus (maxPerSet=${maxPerSet})...`)
  const fullCorpus = (await buildCorpus({ maxPerSet })) as CorpusRow[]
  // buildCorpus returns the cached manifest verbatim once one exists, ignoring maxPerSet —
  // matching run-benchmark.ts's own existing behavior. `--limit=` is this script's own
  // dev-convenience total-row slice, independent of that cache.
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const corpus = limitArg ? fullCorpus.slice(0, Number(limitArg.split('=')[1])) : fullCorpus
  console.log(`[hard-bench] corpus size: ${corpus.length}`)

  console.log('[hard-bench] warming up visual model...')
  await warmUpModel()

  const candidatePool = corpus.map(toCandidateRecord)
  const referenceEmbeddings = new Map<string, Float32Array>()
  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    referenceEmbeddings.set(row.cardId, await embedImageBuffer(buf))
  }

  function searchTop(queryVec: Float32Array) {
    return [...referenceEmbeddings.entries()]
      .map(([cardId, refVec]) => {
        let dot = 0
        for (let i = 0; i < refVec.length; i += 1) dot += (refVec[i] ?? 0) * (queryVec[i] ?? 0)
        return { cardId, similarity: dot }
      })
      .sort((a, b) => b.similarity - a.similarity)
  }

  const tallies: Record<'simpleCrop' | 'tightCrop' | 'rectified' | 'rectifiedHybrid', MethodTally> =
    {
      simpleCrop: freshTally(),
      tightCrop: freshTally(),
      rectified: freshTally(),
      rectifiedHybrid: freshTally(),
    }
  const perProfile: Record<string, Record<string, MethodTally>> = {}
  function profileTally(profile: string, method: string): MethodTally {
    const byMethod = (perProfile[profile] ??= {})
    return (byMethod[method] ??= freshTally())
  }

  let fallbackCount = 0
  let queryCount = 0

  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const hardQueries = await hardAugmentAll(buf, row.cardId)

    for (const { profile, buffer, nominalRect, canvasWidth, canvasHeight } of hardQueries) {
      queryCount += 1
      const trueId = row.cardId

      // --- A: simple crop (the pre-P79 pipeline's own behavior) ---
      const simpleCropJpeg = await extractJpeg(buffer, nominalRect, canvasWidth, canvasHeight)
      const simpleVec = await embedImageBuffer(simpleCropJpeg)
      const simpleOrder = searchTop(simpleVec).map((h) => h.cardId)
      record(tallies.simpleCrop, rankOf(simpleOrder, trueId))
      record(profileTally(profile, 'simpleCrop'), rankOf(simpleOrder, trueId))

      // --- B: tightened crop (10% inset, no real edge detection) ---
      const tightRect = insetRect(nominalRect, 0.1)
      const tightCropJpeg = await extractJpeg(buffer, tightRect, canvasWidth, canvasHeight)
      const tightVec = await embedImageBuffer(tightCropJpeg)
      const tightOrder = searchTop(tightVec).map((h) => h.cardId)
      record(tallies.tightCrop, rankOf(tightOrder, trueId))
      record(profileTally(profile, 'tightCrop'), rankOf(tightOrder, trueId))

      // --- C: rectified crop (the REAL P79 pipeline) ---
      const { jpeg: rectifiedJpeg, usedFallback } = await rectifyBuffer(
        buffer,
        nominalRect,
        canvasWidth,
        canvasHeight,
      )
      if (usedFallback) fallbackCount += 1
      const rectifiedVec = await embedImageBuffer(rectifiedJpeg)
      const rectifiedOrder = searchTop(rectifiedVec).map((h) => h.cardId)
      record(tallies.rectified, rankOf(rectifiedOrder, trueId))
      record(profileTally(profile, 'rectified'), rankOf(rectifiedOrder, trueId))

      // --- D: rectified + OCR + rerank (real domain matcher) ---
      const ocrResult = await ocrFullFrame(rectifiedJpeg)
      const split = splitFullFrameCardText(ocrResult.text)
      const observation = {
        rawNameText: cleanSignal(split.name, 1),
        rawCollectorNumberText: cleanSignal(split.number, 1),
        rawSetText: null,
        languageHint: 'en' as const,
      }
      const shortlist = searchTop(rectifiedVec).slice(0, 30)
      const visualScores: VisualEvidenceByCard = new Map(
        shortlist.map((hit) => [hit.cardId, hit.similarity]),
      )
      const shortlistPool = candidatePool.filter((c) => visualScores.has(c.cardId))
      const hybridMatch = matchScannerObservation(observation, shortlistPool, visualScores)
      const hybridOrder = hybridMatch.candidates.map((c) => c.card.cardId)
      record(tallies.rectifiedHybrid, rankOf(hybridOrder, trueId))
      record(profileTally(profile, 'rectifiedHybrid'), rankOf(hybridOrder, trueId))
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model: { id: VISUAL_MODEL_ID, revision: VISUAL_MODEL_REVISION, dim: 384, dtype: 'q8' },
    corpus: {
      referenceCount: corpus.length,
      hardAugmentationProfiles: HARD_AUGMENTATION_PROFILES,
      queryCount,
    },
    rectificationFallbackRate: Number(((100 * fallbackCount) / queryCount).toFixed(1)),
    methods: Object.fromEntries(Object.entries(tallies).map(([k, t]) => [k, summarize(t)])),
    perProfile: Object.fromEntries(
      Object.entries(perProfile).map(([profile, methods]) => [
        profile,
        Object.fromEntries(Object.entries(methods).map(([m, t]) => [m, summarize(t)])),
      ]),
    ),
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, 'hard-benchmark-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await disposeOcr()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
