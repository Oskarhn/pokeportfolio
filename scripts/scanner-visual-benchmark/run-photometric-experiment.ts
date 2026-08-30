/**
 * P80 §5 bounded experiment: does the P80 photometric-normalization step (`domain/scanner/
 * photometric.ts`) help or hurt visual retrieval? Reuses the SAME cached 240-card corpus and REAL
 * rectify.ts/embed.mjs pipeline the P79 hard benchmark uses, restricted to the `tilted-offcenter`
 * profile only (geometry-only distortion, no lighting defects) — the one profile that is already
 * near-ceiling (93%+ TOP1 per P79), so this experiment's only job is a non-regression check: a
 * genuinely useful photometric step must not cost accuracy on the case that already works.
 *
 * This experiment does NOT and cannot test the actual hypothesis behind the Chandelure miss
 * (foil/rainbow full-art cards clustering together at REAL 19,501-card index scale) — the cached
 * corpus's card ids are TCGdex-style ("base1-1"), not the real catalog's UUIDs the hosted index is
 * keyed by, so there is no ground truth to test large-scale near-duplicate-foil confusion against
 * without a future session's Supabase catalog access to build a proper id mapping. Disclosed
 * honestly in docs/SCANNER_RESEARCH.md §7c rather than overclaiming what this run proves.
 *
 * Run: `pnpm scanner:visual:benchmark:photometric [--limit=N]`
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

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, 'reports')

interface CorpusRow {
  cardId: string
  imagePath: string
}

function clampRect(rect: RectPixelRect, boundsWidth: number, boundsHeight: number): RectPixelRect {
  const left = Math.max(0, Math.min(Math.round(rect.left), boundsWidth - 1))
  const top = Math.max(0, Math.min(Math.round(rect.top), boundsHeight - 1))
  const right = Math.max(left + 1, Math.min(Math.round(rect.left + rect.width), boundsWidth))
  const bottom = Math.max(top + 1, Math.min(Math.round(rect.top + rect.height), boundsHeight))
  return { left, top, width: right - left, height: bottom - top }
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

const RECTIFY_EXPAND_FRACTION = 0.18
const RECTIFY_OUTPUT_WIDTH = 700
const RECTIFY_OUTPUT_HEIGHT = 980

/** Rectifies a region of `buffer`, returning the RAW RgbaImage (not yet JPEG-encoded) so the
 *  caller can optionally run photometric normalization before encoding both variants. */
async function rectifyToRgba(
  buffer: Buffer,
  nominalRect: RectPixelRect,
  canvasW: number,
  canvasH: number,
): Promise<RgbaImage> {
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
  return rectified.image
}

async function toJpeg(image: RgbaImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data.buffer), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

interface Tally {
  top1: number
  top3: number
  top5: number
  total: number
}
function freshTally(): Tally {
  return { top1: 0, top3: 0, top5: 0, total: 0 }
}
function record(tally: Tally, rank: number | null) {
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
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 40

  console.log('[photometric-experiment] loading cached corpus...')
  const fullCorpus = (await buildCorpus({ maxPerSet: 999 })) as CorpusRow[]
  const corpus = fullCorpus.slice(0, limit)
  console.log(`[photometric-experiment] using ${corpus.length}/${fullCorpus.length} cached cards`)

  console.log('[photometric-experiment] warming up visual model...')
  await warmUpModel()

  const referenceEmbeddings = new Map<string, Float32Array>()
  for (const row of fullCorpus) {
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

  const plain = freshTally()
  const normalized = freshTally()
  let queryCount = 0

  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const hardQueries = await hardAugmentAll(buf, row.cardId)
    const tiltedOffcenter = hardQueries.find(
      (q: { profile: string }) => q.profile === 'tilted-offcenter',
    )
    if (!tiltedOffcenter) continue
    const { buffer, nominalRect, canvasWidth, canvasHeight } = tiltedOffcenter
    queryCount += 1
    const trueId = row.cardId

    const rgba = await rectifyToRgba(buffer, nominalRect, canvasWidth, canvasHeight)

    const plainVec = await embedImageBuffer(await toJpeg(rgba))
    const plainOrder = searchTop(plainVec).map((h) => h.cardId)
    record(plain, rankOf(plainOrder, trueId))

    const normalizedRgba = normalizePhotometricRgba(rgba)
    const normalizedVec = await embedImageBuffer(await toJpeg(normalizedRgba))
    const normalizedOrder = searchTop(normalizedVec).map((h) => h.cardId)
    record(normalized, rankOf(normalizedOrder, trueId))
  }

  function summarize(t: Tally) {
    return {
      top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)),
      top3Pct: Number(((100 * t.top3) / t.total).toFixed(1)),
      top5Pct: Number(((100 * t.top5) / t.total).toFixed(1)),
      n: t.total,
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    profile: 'tilted-offcenter',
    corpusSize: corpus.length,
    referencePoolSize: fullCorpus.length,
    queryCount,
    plain: summarize(plain),
    photometricNormalized: summarize(normalized),
    note:
      'Non-regression check only (see file header): this corpus cannot ground-truth-test the ' +
      'large-index foil/style-confusion hypothesis behind the real Chandelure miss.',
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, 'photometric-experiment-report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
