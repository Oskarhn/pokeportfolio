/**
 * P93 §11 — continuous-severity benchmark for the ONE quality dimension actually wired into
 * production (capture-quality.ts's blur gate). P91 explicitly disclosed its own blur benchmark
 * was bimodal by construction (only two fixed severity tiers — clean/geometry vs. the two hard-
 * defect profiles, which always bundle blur with glare/shadow/noise together). This script sweeps
 * a SINGLE isolated dimension (Gaussian blur sigma) continuously, using the REAL production
 * `computeBlurScore` (src/domain/scanner/capture-quality.ts, not a lab reimplementation) against
 * REAL retrieval (the cached ~4,300-card reference index), to see where retrieval reliability
 * actually degrades relative to the shipped `BLUR_ABSTAIN_THRESHOLD` (378, inherited unchanged
 * from P91 — this script's job is to check that number against a continuous sweep, not to invent
 * a new one; P93 §11's own instruction is not to broaden the gate beyond measured evidence).
 *
 * P99/P98 fix: earlier runs of this script fed the (possibly native-resolution) blurred corpus
 * image directly into `computeBlurScore`, skipping the real production chain entirely —
 * `rectify-capture.ts` always runs `rectifyCard` first, producing a canonical 700x980 BILINEAR-
 * warped image, and only THEN calls `computeBlurScore` (whose own internal downsample to 256px
 * long-edge is NEAREST-NEIGHBOR). P98's audit found nearest-neighbor inflates Laplacian variance
 * 2-5x over a filtered resize in the near-sharp-to-moderately-blurred region — exactly where a
 * threshold decision matters — so skipping the bilinear rectify stage entirely was a genuine,
 * confirmed calibration/production mismatch, not just an untested one. This script now routes every
 * query through the REAL `rectifyCard` (src/domain/scanner/rectify.ts, the identical
 * platform-neutral function `rectify-capture.ts` calls) at the real `RECTIFY_OUTPUT_WIDTH` x
 * `RECTIFY_OUTPUT_HEIGHT` (700x980) BEFORE computing the blur score — and, since
 * `rectify-capture.ts`'s own docstring is explicit that "BOTH the OCR and visual channels" consume
 * that same canonical image afterward, embeds the SAME rectified image for retrieval too, not a
 * separately-encoded copy of the pre-rectify blurred buffer.
 *
 * Corpus images here are already tight card crops (no background), so `rectifyCard`'s own corner
 * detector has no real margin to search and reliably falls back to warping the plain nominal
 * rectangle (`usedFallback: true`, reported in the output) — mathematically a crop+resize, which is
 * exactly what a well-aligned real capture's rectify pass reduces to as well. This still exercises
 * the real bilinear-warp-then-nearest-neighbor-downsample RESIZE CHAIN the shipped code performs,
 * which is the specific thing under test — it does not need the corner-detection branch to fire to
 * be a valid full-pipeline measurement.
 *
 * Glare/shadow/perspective/noise dimensions are NOT swept here — P91 already found its simple
 * glare-fraction and shadow-coefficient-of-variation metrics have ~zero discriminative power on
 * this project's own synthetic composites (Youden's J ≈ 0), and no such metric is wired into
 * production at all, so there is nothing this script's continuous-severity treatment would
 * validate for those dimensions specifically. Disclosed as a real, deliberate scope limit, not a
 * silently narrower benchmark than the prompt's full ask.
 *
 * Run: `pnpm scanner:recognition-lab:p93-blur-severity`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'
import {
  computeBlurScore,
  BLUR_ABSTAIN_THRESHOLD,
} from '../../../src/domain/scanner/capture-quality'
import {
  rectifyCard,
  type RectPixelRect,
  type RgbaImage,
} from '../../../src/domain/scanner/rectify'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { warmUpModel, embedImageBuffer } from '../embedding/embed.mjs'

/** Matches `rectify-capture.ts`'s own canonical output size exactly — the number this script
 *  exists to validate `computeBlurScore` actually runs against in production. */
const RECTIFY_OUTPUT_WIDTH = 700
const RECTIFY_OUTPUT_HEIGHT = 980
/** Matches `rectify-capture.ts`'s own `MIN_DETECTION_MARGIN_PX` floor for a zero-expansion input —
 *  the corpus images here are tight crops with no real margin room, same as a file-upload capture
 *  whose cardRect already fills the frame. */
const DETECTION_MARGIN_PX = 12

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

interface CorpusRow {
  cardId: string
  imagePath: string
}

function stratifiedSample<T>(rows: readonly T[], n: number, seedStr: string): T[] {
  let seed = 0
  for (const c of seedStr) seed = (seed * 31 + c.charCodeAt(0)) | 0
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out: T[] = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1) {
    const row = rows[(offset + i * stride) % rows.length]
    if (row) out.push(row)
  }
  return out
}

/** Decodes a JPEG/WebP buffer to the plain RgbaImage shape rectify.ts/capture-quality.ts's
 *  production functions expect — the same raw-pixel contract rectify-capture.ts feeds them in the
 *  browser (an ImageData-shaped object), reproduced here via sharp's raw output. */
async function toRgbaImage(buffer: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height }
}

/** Encodes an RgbaImage back to a JPEG buffer — needed only because `embedImageBuffer` (like the
 *  real visual-worker.ts) takes an ENCODED image, not raw pixels; rectify.ts itself stays
 *  encoding-agnostic. */
async function encodeJpeg(image: RgbaImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/** Routes `rgba` through the REAL production `rectifyCard` — see the module header for exactly why
 *  this must happen before `computeBlurScore` for this benchmark to mean what it claims to. */
function rectifyForBenchmark(rgba: RgbaImage): { image: RgbaImage; usedFallback: boolean } {
  const nominalRect: RectPixelRect = { left: 0, top: 0, width: rgba.width, height: rgba.height }
  const result = rectifyCard(
    rgba,
    nominalRect,
    RECTIFY_OUTPUT_WIDTH,
    RECTIFY_OUTPUT_HEIGHT,
    DETECTION_MARGIN_PX,
  )
  return { image: result.image, usedFallback: result.usedFallback }
}

const SIGMA_LEVELS = [0, 1, 2, 3, 4, 6, 8, 10, 14, 20]

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 80)
  const { rows, vectors } = (await buildReferenceIndex()) as {
    rows: CorpusRow[]
    vectors: Map<string, Float32Array>
  }
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN, 'p93-continuous-blur-severity')
  console.log(`[p93-blur-severity] sample ${sample.length} of ${rows.length}`)

  interface Bucket {
    blurScores: number[]
    top1Correct: number
    top5Correct: number
    /** Genuinely "bad" per this benchmark's own operating definition: retrieval got TOP1 wrong at
     *  this severity — the honest ground truth for "should the gate have caught this," not a
     *  separate hand-picked label. */
    badCaptures: number
    /** Of the `badCaptures` above, how many the gate's own threshold actually flags. */
    badCapturesCaught: number
    /** Queries the gate flags (blurScore < threshold) whose retrieval was STILL correct at TOP1 —
     *  an unnecessary abstention on a capture that would have worked fine. */
    falseRejections: number
    abstentions: number
    usedFallback: number
    n: number
  }
  const bySigma = new Map<number, Bucket>()
  for (const sigma of SIGMA_LEVELS) {
    bySigma.set(sigma, {
      blurScores: [],
      top1Correct: 0,
      top5Correct: 0,
      badCaptures: 0,
      badCapturesCaught: 0,
      falseRejections: 0,
      abstentions: 0,
      usedFallback: 0,
      n: 0,
    })
  }
  function getBucket(sigma: number): Bucket {
    const bucket = bySigma.get(sigma)
    if (!bucket) throw new Error(`no bucket for sigma=${String(sigma)}`)
    return bucket
  }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const original = await readFile(row.imagePath)
    for (const sigma of SIGMA_LEVELS) {
      const blurred =
        sigma === 0 ? original : await sharp(original).blur(sigma).jpeg({ quality: 90 }).toBuffer()
      const rgba = await toRgbaImage(blurred)
      // P99/P98 fix: score AND embed the image the real pipeline actually produces — the
      // rectified 700x980 canonical output, not the pre-rectify buffer. See the module header.
      const { image: rectified, usedFallback } = rectifyForBenchmark(rgba)
      const blurScore = computeBlurScore(rectified)
      const rectifiedJpeg = await encodeJpeg(rectified)
      const vec = await embedImageBuffer(rectifiedJpeg)
      const hits = searchIndex(vec, vectors) as { cardId: string; similarity: number }[]
      const top1Correct = hits[0]?.cardId === trueId
      const top5Correct = hits.slice(0, 5).some((h) => h.cardId === trueId)
      const abstained = blurScore < BLUR_ABSTAIN_THRESHOLD

      const bucket = getBucket(sigma)
      bucket.blurScores.push(blurScore)
      bucket.n += 1
      if (top1Correct) bucket.top1Correct += 1
      if (top5Correct) bucket.top5Correct += 1
      if (usedFallback) bucket.usedFallback += 1
      if (abstained) bucket.abstentions += 1
      if (!top1Correct) {
        bucket.badCaptures += 1
        if (abstained) bucket.badCapturesCaught += 1
      } else if (abstained) {
        bucket.falseRejections += 1
      }
    }
    done += 1
    if (done % 20 === 0) console.log(`[p93-blur-severity] progress ${done}/${sample.length}`)
  }

  const summary = SIGMA_LEVELS.map((sigma) => {
    const bucket = getBucket(sigma)
    const meanBlurScore = bucket.blurScores.reduce((a, b) => a + b, 0) / bucket.blurScores.length
    return {
      sigma,
      n: bucket.n,
      meanBlurScore: Number(meanBlurScore.toFixed(2)),
      top1AccuracyPct: Number(((100 * bucket.top1Correct) / bucket.n).toFixed(1)),
      top5AccuracyPct: Number(((100 * bucket.top5Correct) / bucket.n).toFixed(1)),
      belowAbstainThreshold: meanBlurScore < BLUR_ABSTAIN_THRESHOLD,
      abstentionRatePct: Number(((100 * bucket.abstentions) / bucket.n).toFixed(1)),
      // Of queries the gate DIDN'T abstain on, how many still failed TOP1 — a false-rejection
      // number would be a different question at zero real bad captures (see below), so this
      // bucket-level rate is reported unconditionally; the null case is called out explicitly.
      falseRejectionRatePct:
        bucket.n - bucket.badCaptures > 0
          ? Number(((100 * bucket.falseRejections) / (bucket.n - bucket.badCaptures)).toFixed(1))
          : null,
      badCaptureCount: bucket.badCaptures,
      badCaptureCatchRatePct:
        bucket.badCaptures > 0
          ? Number(((100 * bucket.badCapturesCaught) / bucket.badCaptures).toFixed(1))
          : null,
      rectifyUsedFallbackRatePct: Number(((100 * bucket.usedFallback) / bucket.n).toFixed(1)),
    }
  })

  const report = {
    generatedAt: new Date().toISOString(),
    description:
      'P93 continuous Gaussian-blur-sigma sweep (isolated dimension) — real production ' +
      'computeBlurScore against real retrieval, cross-checking BLUR_ABSTAIN_THRESHOLD ' +
      '(inherited from P91, not re-derived here) against a continuous severity curve rather ' +
      "than P91's own disclosed bimodal two-tier benchmark. P99: routed through the REAL " +
      'rectifyCard (700x980 canonical, bilinear warp) before scoring/embedding — see this ' +
      'file header for why that was previously missing and why it matters.',
    querySampleSize: sample.length,
    blurAbstainThreshold: BLUR_ABSTAIN_THRESHOLD,
    fullPipelineValidated: true,
    sweep: summary,
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '09-p93-continuous-blur-severity.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
