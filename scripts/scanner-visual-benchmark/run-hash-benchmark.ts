/**
 * M15 lightweight-hash benchmark (P82 §10). P76's original dHash number (86.7%/93.0%/95.0% TOP1/3/5,
 * docs/SCANNER_RESEARCH.md §7b) came from the EASY corpus — resize/rotate-in-place distortions of
 * an already-tight, card-only reference image, never a captured frame with real background around
 * an imperfectly-aligned card. P79's harder corpus (tilt + off-center placement, composed onto a
 * larger background canvas) is the more realistic stand-in for a real phone photo, and it was never
 * run against either hash family. This script fixes that gap: for every hard-augmented query, it
 * runs the SAME real `rectify.ts` detect+warp pipeline `run-hard-benchmark.ts` uses, then computes
 * dHash/pHash directly from the rectified RGBA (before it is even JPEG-encoded) and ranks the
 * reference corpus by Hamming distance — no ML runtime, no network, sub-millisecond per query.
 *
 * Run: `pnpm scanner:visual:benchmark:hash`. Does not touch or replace any other benchmark/report.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  computeDHash,
  computePHash,
  hammingDistance,
  dHashSimilarity,
} from '../../src/domain/scanner/perceptual-hash'
import {
  rectifyCard,
  toGrayscaleRgba,
  type RectPixelRect,
  type RgbaImage,
} from '../../src/domain/scanner/rectify'
import { buildCorpus } from './lib/fetch-references.mjs'
import { hardAugmentAll, HARD_AUGMENTATION_PROFILES } from './lib/hard-augment.mjs'

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

/** Runs the REAL rectify.ts detect+warp pipeline and returns the rectified RGBA directly (no JPEG
 *  round trip — a hash benchmark should measure the pipeline's own pixels, not lossy re-decode
 *  artifacts a real capture wouldn't introduce twice). */
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

function hashOf(rgba: RgbaImage): { d: bigint; p: bigint } {
  const gray = toGrayscaleRgba(rgba)
  return {
    d: computeDHash(gray.data as Uint8ClampedArray, gray.width, gray.height),
    p: computePHash(gray.data as Uint8ClampedArray, gray.width, gray.height),
  }
}

async function main() {
  const maxPerSetArg = process.argv.find((a) => a.startsWith('--max-per-set='))
  const maxPerSet = maxPerSetArg ? Number(maxPerSetArg.split('=')[1]) : 999
  console.log(`[hash-bench] building corpus (maxPerSet=${maxPerSet})...`)
  const fullCorpus = (await buildCorpus({ maxPerSet })) as CorpusRow[]
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const corpus = limitArg ? fullCorpus.slice(0, Number(limitArg.split('=')[1])) : fullCorpus
  console.log(`[hash-bench] corpus size: ${corpus.length}`)

  console.log('[hash-bench] hashing reference images...')
  const referenceHashes = new Map<string, { d: bigint; p: bigint }>()
  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const rgba: RgbaImage = {
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    }
    referenceHashes.set(row.cardId, hashOf(rgba))
  }

  function rankBy(query: { d: bigint; p: bigint }, method: 'dHash' | 'pHash' | 'combined') {
    return [...referenceHashes.entries()]
      .map(([cardId, ref]) => {
        const dDist = hammingDistance(query.d, ref.d)
        const pDist = hammingDistance(query.p, ref.p)
        const similarity =
          method === 'dHash'
            ? dHashSimilarity(dDist)
            : method === 'pHash'
              ? dHashSimilarity(pDist)
              : (dHashSimilarity(dDist) + dHashSimilarity(pDist)) / 2
        return { cardId, similarity }
      })
      .sort((a, b) => b.similarity - a.similarity)
      .map((h) => h.cardId)
  }

  const tallies: Record<'dHash' | 'pHash' | 'combined', MethodTally> = {
    dHash: freshTally(),
    pHash: freshTally(),
    combined: freshTally(),
  }
  const perProfile: Record<string, Record<string, MethodTally>> = {}
  function profileTally(profile: string, method: string): MethodTally {
    const byMethod = (perProfile[profile] ??= {})
    return (byMethod[method] ??= freshTally())
  }

  // Same-card vs different-card similarity samples (P82 §10/§11: real evidence to calibrate
  // hash-evidence.ts's tier thresholds, mirroring how visual-evidence.ts's DINO thresholds were
  // calibrated from P76's own benchmark distribution — never guessed).
  const sameCardCombined: number[] = []
  const differentCardCombined: number[] = []

  let queryCount = 0

  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const hardQueries = await hardAugmentAll(buf, row.cardId)
    for (const { profile, buffer, nominalRect, canvasWidth, canvasHeight } of hardQueries) {
      queryCount += 1
      const trueId = row.cardId
      const rgba = await rectifyToRgba(buffer, nominalRect, canvasWidth, canvasHeight)
      const queryHash = hashOf(rgba)

      const dOrder = rankBy(queryHash, 'dHash')
      record(tallies.dHash, rankOf(dOrder, trueId))
      record(profileTally(profile, 'dHash'), rankOf(dOrder, trueId))

      const pOrder = rankBy(queryHash, 'pHash')
      record(tallies.pHash, rankOf(pOrder, trueId))
      record(profileTally(profile, 'pHash'), rankOf(pOrder, trueId))

      const cOrder = rankBy(queryHash, 'combined')
      record(tallies.combined, rankOf(cOrder, trueId))
      record(profileTally(profile, 'combined'), rankOf(cOrder, trueId))

      for (const [cardId, ref] of referenceHashes.entries()) {
        const combinedSim =
          (dHashSimilarity(hammingDistance(queryHash.d, ref.d)) +
            dHashSimilarity(hammingDistance(queryHash.p, ref.p))) /
          2
        if (cardId === trueId) sameCardCombined.push(combinedSim)
        else differentCardCombined.push(combinedSim)
      }
    }
  }

  function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
    return sorted[idx] ?? 0
  }

  const report = {
    generatedAt: new Date().toISOString(),
    corpus: {
      referenceCount: corpus.length,
      hardAugmentationProfiles: HARD_AUGMENTATION_PROFILES,
      queryCount,
    },
    methods: Object.fromEntries(Object.entries(tallies).map(([k, t]) => [k, summarize(t)])),
    perProfile: Object.fromEntries(
      Object.entries(perProfile).map(([profile, methods]) => [
        profile,
        Object.fromEntries(Object.entries(methods).map(([m, t]) => [m, summarize(t)])),
      ]),
    ),
    similarityDistribution: {
      sameCard: {
        n: sameCardCombined.length,
        p10: percentile(sameCardCombined, 0.1),
        median: percentile(sameCardCombined, 0.5),
        p90: percentile(sameCardCombined, 0.9),
      },
      differentCard: {
        n: differentCardCombined.length,
        p10: percentile(differentCardCombined, 0.1),
        median: percentile(differentCardCombined, 0.5),
        p90: percentile(differentCardCombined, 0.9),
      },
    },
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, 'hash-benchmark-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
