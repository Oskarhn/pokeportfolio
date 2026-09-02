/**
 * P84 §8: query-only multi-view evaluation. Does NOT require another owner index rebuild — every
 * variant here is a different QUERY representation searched against the SAME existing reference
 * pool (the 240-card corpus's own generator-path INT8-round-tripped embeddings, same contract the
 * real 19,501-card index uses).
 *
 * Variants (subset of the prompt's A-H list, chosen for what's cheap/meaningful without a second
 * reference index):
 *   A. rectified full card (the shipped production representation, P79)
 *   B. raw guide crop (nominal rect only, no perspective correction — pre-P79 behavior)
 *   C. rectified + 5% border inset
 *   D. rectified + 10% border inset
 *   E. rectified + photometric normalization (P80's built-but-unwired contrast-stretch/desaturate)
 *
 * Then evaluates score fusion across A/C/D/E (excluding B, the known-worse baseline) via max
 * similarity, unweighted average, and rank fusion (Borda-style: average of each variant's own
 * rank, lower is better).
 *
 * Run: `pnpm tsx scripts/scanner-visual-benchmark/run-query-variants.ts [--limit=N]`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { rectifyCard, type RectPixelRect, type RgbaImage } from '../../src/domain/scanner/rectify'
import { normalizePhotometricRgba } from '../../src/domain/scanner/photometric'
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
interface HardQuery {
  profile: string
  buffer: Buffer
  nominalRect: RectPixelRect
  canvasWidth: number
  canvasHeight: number
}

const OUTPUT_W = 700
const OUTPUT_H = 980

function clampRect(rect: RectPixelRect, bw: number, bh: number): RectPixelRect {
  const left = Math.max(0, Math.min(Math.round(rect.left), bw - 1))
  const top = Math.max(0, Math.min(Math.round(rect.top), bh - 1))
  const right = Math.max(left + 1, Math.min(Math.round(rect.left + rect.width), bw))
  const bottom = Math.max(top + 1, Math.min(Math.round(rect.top + rect.height), bh))
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

async function extractRgba(buffer: Buffer, rect: RectPixelRect): Promise<RgbaImage> {
  const { data, info } = await sharp(buffer)
    .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  }
}

async function rgbaToJpeg(image: RgbaImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data.buffer), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

function insetRect(rect: RectPixelRect, fraction: number): RectPixelRect {
  const padX = rect.width * fraction
  const padY = rect.height * fraction
  return { left: padX, top: padY, width: rect.width - 2 * padX, height: rect.height - 2 * padY }
}

/** Builds every query-variant JPEG for one hard query. */
async function buildVariants(q: HardQuery): Promise<Record<string, Buffer>> {
  const expanded = clampRect(
    expandRect(q.nominalRect, 0.18, q.canvasWidth, q.canvasHeight),
    q.canvasWidth,
    q.canvasHeight,
  )
  const expandedRgba = await extractRgba(q.buffer, expanded)
  const nominalLocal: RectPixelRect = {
    left: q.nominalRect.left - expanded.left,
    top: q.nominalRect.top - expanded.top,
    width: q.nominalRect.width,
    height: q.nominalRect.height,
  }
  const margin = Math.max(
    12,
    Math.round(
      Math.min(expanded.width - q.nominalRect.width, expanded.height - q.nominalRect.height) / 2,
    ),
  )

  // A. rectified full card (production baseline)
  const rectified = rectifyCard(expandedRgba, nominalLocal, OUTPUT_W, OUTPUT_H, margin)
  const rectifiedJpeg = await rgbaToJpeg(rectified.image)

  // B. raw guide crop (nominal rect only, no perspective correction)
  const nominalClamped = clampRect(nominalLocal, expandedRgba.width, expandedRgba.height)
  const rawCropRgba = await sharp(Buffer.from(expandedRgba.data.buffer), {
    raw: { width: expandedRgba.width, height: expandedRgba.height, channels: 4 },
  })
    .extract({
      left: nominalClamped.left,
      top: nominalClamped.top,
      width: nominalClamped.width,
      height: nominalClamped.height,
    })
    .jpeg({ quality: 90 })
    .toBuffer()

  // C/D. rectified + border inset (5% / 10%), re-rectified from the SAME expanded source at an
  // inset nominal rect so the inset genuinely trims toward the card's own interior.
  const insetLocal5 = insetRect(nominalLocal, 0.05)
  const insetLocal10 = insetRect(nominalLocal, 0.1)
  const rectified5 = rectifyCard(expandedRgba, insetLocal5, OUTPUT_W, OUTPUT_H, margin)
  const rectified10 = rectifyCard(expandedRgba, insetLocal10, OUTPUT_W, OUTPUT_H, margin)
  const rectified5Jpeg = await rgbaToJpeg(rectified5.image)
  const rectified10Jpeg = await rgbaToJpeg(rectified10.image)

  // E. rectified + photometric normalization
  const normalized = normalizePhotometricRgba(rectified.image)
  const normalizedJpeg = await rgbaToJpeg(normalized)

  return {
    rectified: rectifiedJpeg,
    rawCrop: rawCropRgba,
    inset5: rectified5Jpeg,
    inset10: rectified10Jpeg,
    photometric: normalizedJpeg,
  }
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

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 60

  console.log('[query-variants] loading cached corpus...')
  const fullCorpus = (await buildCorpus({ maxPerSet: 999 })) as CorpusRow[]
  const corpus = fullCorpus.slice(0, limit)
  console.log(`[query-variants] querying ${corpus.length}/${fullCorpus.length} cards`)

  console.log('[query-variants] warming up + embedding reference pool...')
  await warmUpModel()
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
  function rankOf(ranked: { cardId: string }[], trueId: string): number {
    const idx = ranked.findIndex((h) => h.cardId === trueId)
    return idx === -1 ? ranked.length + 1 : idx + 1
  }

  const variantNames = ['rectified', 'rawCrop', 'inset5', 'inset10', 'photometric'] as const
  const profileNames = [
    'tilted-offcenter',
    'tilted-glare-shadow-blur',
    'skewed-partial-shadow-noisy',
  ]

  type Tally = { top1: number; top3: number; top5: number; total: number }
  const freshTally = (): Tally => ({ top1: 0, top3: 0, top5: 0, total: 0 })
  const record = (t: Tally, rank: number) => {
    t.total += 1
    if (rank <= 1) t.top1 += 1
    if (rank <= 3) t.top3 += 1
    if (rank <= 5) t.top5 += 1
  }

  const perVariant: Record<string, Record<string, Tally>> = {}
  const fusionMax: Record<string, Tally> = {}
  const fusionAvg: Record<string, Tally> = {}
  const fusionRank: Record<string, Tally> = {}
  for (const p of profileNames) {
    fusionMax[p] = freshTally()
    fusionAvg[p] = freshTally()
    fusionRank[p] = freshTally()
    perVariant[p] = {}
    for (const v of variantNames) perVariant[p][v] = freshTally()
  }

  const fusionSet = ['rectified', 'inset5', 'inset10', 'photometric'] as const

  for (const row of corpus) {
    const buffer = await readFile(row.imagePath)
    const hardQueries = (await hardAugmentAll(buffer, row.cardId)) as HardQuery[]
    for (const q of hardQueries) {
      const variants = await buildVariants(q)
      const rankedByVariant: Record<string, { cardId: string; similarity: number }[]> = {}
      for (const v of variantNames) {
        const buffer = variants[v]
        if (!buffer) continue
        const raw = await embedImageBuffer(buffer)
        const vec = quantizeRoundTrip(l2Normalize(new Float32Array(raw)))
        const ranked = searchAll(vec)
        rankedByVariant[v] = ranked
        const tally = perVariant[q.profile]?.[v]
        if (tally) record(tally, rankOf(ranked, row.cardId))
      }

      // Score fusion over fusionSet (max / average similarity per candidate card)
      const cardIds = [...referenceIndex.keys()]
      const maxScored = cardIds
        .map((cardId) => ({
          cardId,
          similarity: Math.max(
            ...fusionSet.map(
              (v) => rankedByVariant[v]?.find((h) => h.cardId === cardId)?.similarity ?? -1,
            ),
          ),
        }))
        .sort((a, b) => b.similarity - a.similarity)
      const avgScored = cardIds
        .map((cardId) => ({
          cardId,
          similarity:
            fusionSet.reduce(
              (sum, v) =>
                sum + (rankedByVariant[v]?.find((h) => h.cardId === cardId)?.similarity ?? -1),
              0,
            ) / fusionSet.length,
        }))
        .sort((a, b) => b.similarity - a.similarity)
      const rankScored = cardIds
        .map((cardId) => ({
          cardId,
          avgRank:
            fusionSet.reduce((sum, v) => sum + rankOf(rankedByVariant[v] ?? [], cardId), 0) /
            fusionSet.length,
        }))
        .sort((a, b) => a.avgRank - b.avgRank)

      const fm = fusionMax[q.profile]
      const fa = fusionAvg[q.profile]
      const fr = fusionRank[q.profile]
      if (fm) record(fm, rankOf(maxScored, row.cardId))
      if (fa) record(fa, rankOf(avgScored, row.cardId))
      if (fr) record(fr, rankOf(rankScored, row.cardId))
    }
  }

  function pct(t: Tally) {
    return {
      top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)),
      top3Pct: Number(((100 * t.top3) / t.total).toFixed(1)),
      top5Pct: Number(((100 * t.top5) / t.total).toFixed(1)),
      n: t.total,
    }
  }

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    corpusSize: corpus.length,
    referencePoolSize: fullCorpus.length,
  }
  for (const p of profileNames) {
    const variantResults: Record<string, unknown> = {}
    for (const v of variantNames) {
      const tally = perVariant[p]?.[v]
      if (tally) variantResults[v] = pct(tally)
    }
    const fm = fusionMax[p]
    const fa = fusionAvg[p]
    const fr = fusionRank[p]
    report[p] = {
      variants: variantResults,
      fusionMaxSimilarity: fm ? pct(fm) : null,
      fusionAverageSimilarity: fa ? pct(fa) : null,
      fusionRankAverage: fr ? pct(fr) : null,
    }
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, 'query-variants-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
