/**
 * P84 §14: similarity calibration. No prior M15 session ever recorded the ACTUAL cosine-similarity
 * VALUE distributions same-card vs. different-card produce under realistic capture noise — only
 * TOP1/TOP3/TOP5 rank percentages (P79/P80's hard-benchmark reports). The owner's real-device scan
 * showing TOP1=0.1816 needs a real yardstick: is that "clearly a miss," "borderline," or within the
 * normal range for a genuine match under this specific pipeline's own real distortion profiles?
 *
 * Reuses the SAME real production pipeline every prior hard-benchmark session used (P79's
 * rectify.ts detect+warp, the real embedImageBuffer/quantizeEmbedding contract) over the cached
 * 240-card corpus and its 3 hard-augment profiles (P79) — geometry-only (tilted-offcenter) and two
 * combined-photometric-defect profiles (tilted-glare-shadow-blur, skewed-partial-shadow-noisy).
 *
 * For every query: records (a) similarity to its OWN true reference embedding (same-card) and
 * (b) similarity to the best-scoring WRONG reference (nearest different-card neighbor) — both
 * against the full 240-card reference pool, both via the real INT8 quantize/dequantize round trip
 * the production index actually stores (not raw FP32), so the reported numbers are what the real
 * app's own searchVisualIndex would compute, not an idealized upper bound.
 *
 * Run: `pnpm tsx scripts/scanner-visual-benchmark/run-similarity-calibration.ts [--limit=N]`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { rectifyCard, type RectPixelRect, type RgbaImage } from '../../src/domain/scanner/rectify'
import { buildCorpus } from './lib/fetch-references.mjs'
import { hardAugmentAll } from './lib/hard-augment.mjs'
import { embedImageBuffer, warmUpModel } from './lib/embed.mjs'
import {
  quantizeEmbedding,
  l2Normalize,
  VISUAL_INDEX_INT8_SCALE,
} from '../../src/data/scanner/visual-index'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, 'reports')

interface CorpusRow {
  cardId: string
  imagePath: string
}

const RECTIFY_EXPAND_FRACTION = 0.18
const RECTIFY_OUTPUT_WIDTH = 700
const RECTIFY_OUTPUT_HEIGHT = 980

function clampRect(rect: RectPixelRect, boundsWidth: number, boundsHeight: number): RectPixelRect {
  const left = Math.max(0, Math.min(Math.round(rect.left), boundsWidth - 1))
  const top = Math.max(0, Math.min(Math.round(rect.top), boundsHeight - 1))
  const right = Math.max(left + 1, Math.min(Math.round(rect.left + rect.width), boundsWidth))
  const bottom = Math.max(top + 1, Math.min(Math.round(rect.top + rect.height), boundsHeight))
  return { left, top, width: right - left, height: bottom - top }
}
function expandRect(rect: RectPixelRect, fraction: number, bw: number, bh: number): RectPixelRect {
  const padX = rect.width * fraction
  const padY = rect.height * fraction
  const left = Math.max(0, rect.left - padX)
  const top = Math.max(0, rect.top - padY)
  const right = Math.min(bw, rect.left + rect.width + padX)
  const bottom = Math.min(bh, rect.top + rect.height + padY)
  return { left, top, width: right - left, height: bottom - top }
}
async function rectifyToJpeg(
  buffer: Buffer,
  nominalRect: RectPixelRect,
  canvasW: number,
  canvasH: number,
): Promise<Buffer> {
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
  return sharp(Buffer.from(rectified.image.data.buffer), {
    raw: { width: rectified.image.width, height: rectified.image.height, channels: 4 },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

function quantizeRoundTrip(vec: Float32Array): Float32Array {
  const int8 = quantizeEmbedding(vec)
  const out = new Float32Array(int8.length)
  for (let i = 0; i < int8.length; i += 1) out[i] = (int8[i] ?? 0) / VISUAL_INDEX_INT8_SCALE
  return out
}
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[idx] ?? NaN
}
function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: values.length,
    mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)),
    median: Number(percentile(sorted, 0.5).toFixed(4)),
    min: Number(sorted[0]?.toFixed(4)),
    max: Number(sorted[sorted.length - 1]?.toFixed(4)),
    p10: Number(percentile(sorted, 0.1).toFixed(4)),
    p90: Number(percentile(sorted, 0.9).toFixed(4)),
  }
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 999

  console.log('[calibration] loading cached corpus...')
  const fullCorpus = (await buildCorpus({ maxPerSet: 999 })) as CorpusRow[]
  const corpus = fullCorpus.slice(0, limit)
  console.log(
    `[calibration] querying ${corpus.length}/${fullCorpus.length} cards against the full pool`,
  )

  console.log('[calibration] warming up...')
  await warmUpModel()

  console.log(
    '[calibration] embedding full reference pool (INT8 round-trip, matches production storage)...',
  )
  const referenceIndex = new Map<string, Float32Array>()
  for (const row of fullCorpus) {
    const buf = await readFile(row.imagePath)
    const raw = await embedImageBuffer(buf)
    referenceIndex.set(row.cardId, quantizeRoundTrip(l2Normalize(new Float32Array(raw))))
  }

  function searchAll(query: Float32Array) {
    return [...referenceIndex.entries()]
      .map(([cardId, ref]) => ({ cardId, similarity: cosine(ref, query) }))
      .sort((a, b) => b.similarity - a.similarity)
  }

  const results: Record<
    string,
    { sameCard: number[]; nearestWrong: number[]; rank1IsCorrect: number[] }
  > = {}

  for (const row of corpus) {
    const buffer = await readFile(row.imagePath)
    const hardQueries = await hardAugmentAll(buffer, row.cardId)
    for (const q of hardQueries as {
      profile: string
      buffer: Buffer
      nominalRect: RectPixelRect
      canvasWidth: number
      canvasHeight: number
    }[]) {
      const rectifiedJpeg = await rectifyToJpeg(
        q.buffer,
        q.nominalRect,
        q.canvasWidth,
        q.canvasHeight,
      )
      const rawVec = await embedImageBuffer(rectifiedJpeg)
      const queryVec = quantizeRoundTrip(l2Normalize(new Float32Array(rawVec)))
      const ranked = searchAll(queryVec)
      const sameCardSim = ranked.find((h) => h.cardId === row.cardId)?.similarity ?? -1
      const nearestWrong = ranked.find((h) => h.cardId !== row.cardId)
      const nearestWrongSim = nearestWrong?.similarity ?? -1
      results[q.profile] ??= { sameCard: [], nearestWrong: [], rank1IsCorrect: [] }
      const bucket = results[q.profile]
      if (!bucket) continue
      bucket.sameCard.push(sameCardSim)
      bucket.nearestWrong.push(nearestWrongSim)
      bucket.rank1IsCorrect.push(ranked[0]?.cardId === row.cardId ? 1 : 0)
    }
  }

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    corpusSize: corpus.length,
    referencePoolSize: fullCorpus.length,
  }
  for (const [profile, data] of Object.entries(results)) {
    report[profile] = {
      sameCardSimilarity: summarize(data.sameCard),
      nearestWrongCardSimilarity: summarize(data.nearestWrong),
      top1AccuracyPct: Number(
        (
          (100 * data.rank1IsCorrect.reduce((a, b) => a + b, 0)) /
          data.rank1IsCorrect.length
        ).toFixed(1),
      ),
    }
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, 'similarity-calibration-report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
