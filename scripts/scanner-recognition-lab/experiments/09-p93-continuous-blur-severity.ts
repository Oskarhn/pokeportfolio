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
import type { RgbaImage } from '../../../src/domain/scanner/rectify'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { warmUpModel, embedImageBuffer } from '../embedding/embed.mjs'

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

/** Decodes a JPEG/WebP buffer to the plain RgbaImage shape capture-quality.ts's production
 *  `computeBlurScore` expects — the same raw-pixel contract rectify-capture.ts feeds it in the
 *  browser (an ImageData-shaped object), reproduced here via sharp's raw output. */
async function toRgbaImage(buffer: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height }
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
    n: number
  }
  const bySigma = new Map<number, Bucket>()
  for (const sigma of SIGMA_LEVELS) bySigma.set(sigma, { blurScores: [], top1Correct: 0, n: 0 })
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
      const blurScore = computeBlurScore(rgba)
      const vec = await embedImageBuffer(blurred)
      const hits = searchIndex(vec, vectors) as { cardId: string; similarity: number }[]
      const top1Correct = hits[0]?.cardId === trueId

      const bucket = getBucket(sigma)
      bucket.blurScores.push(blurScore)
      bucket.n += 1
      if (top1Correct) bucket.top1Correct += 1
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
      belowAbstainThreshold: meanBlurScore < BLUR_ABSTAIN_THRESHOLD,
    }
  })

  const report = {
    generatedAt: new Date().toISOString(),
    description:
      'P93 continuous Gaussian-blur-sigma sweep (isolated dimension) — real production ' +
      'computeBlurScore against real retrieval, cross-checking BLUR_ABSTAIN_THRESHOLD ' +
      '(inherited from P91, not re-derived here) against a continuous severity curve rather ' +
      "than P91's own disclosed bimodal two-tier benchmark.",
    querySampleSize: sample.length,
    blurAbstainThreshold: BLUR_ABSTAIN_THRESHOLD,
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
