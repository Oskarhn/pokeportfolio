// Experiment 06 (§19): calibrates the production visual-dominance guard's strong-match threshold
// (currently 0.82, `src/domain/scanner/engine.ts`'s `applyVisualDominanceGuard`, shipped in P88 —
// see D-102) against this session's larger ~4,300-card index instead of leaving it at a value
// calibrated from one earlier mean. For each query, records whether TOP1 was actually CORRECT
// (rank===1) and its similarity, across clean/geometry/hard profiles combined, then sweeps
// candidate thresholds to report the guard's rescue rate (correct-top1 queries the guard would
// correctly trust) vs its false-high rate (WRONG-top1 queries the guard would incorrectly trust).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

function stratifiedSample(rows, n, seedStr) {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

const THRESHOLDS = [0.7, 0.75, 0.78, 0.8, 0.82, 0.85, 0.88, 0.9, 0.92, 0.95]

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 400)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN, 'p91-dominance-threshold')
  console.log(`[dominance] sample ${sample.length} of ${rows.length}`)

  const observations = [] // { profile, top1Correct, top1Sim }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    async function evalQuery(buffer, profile) {
      const vec = await embedImageBuffer(buffer)
      const hits = searchIndex(vec, vectors)
      const top1Correct = hits[0]?.cardId === trueId
      observations.push({ profile, top1Correct, top1Sim: hits[0]?.similarity ?? null })
    }

    await evalQuery(buf, 'clean')
    const hardQueries = await hardAugmentAll(buf, trueId)
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      await evalQuery(cropped, hq.profile)
    }

    done += 1
    if (done % 50 === 0) console.log(`[dominance] progress ${done}/${sample.length}`)
  }

  const correctTop1 = observations.filter((o) => o.top1Correct)
  const wrongTop1 = observations.filter((o) => !o.top1Correct)

  const sweep = THRESHOLDS.map((threshold) => {
    const rescued = correctTop1.filter((o) => o.top1Sim >= threshold).length
    const falseHigh = wrongTop1.filter((o) => o.top1Sim >= threshold).length
    return {
      threshold,
      correctTop1RescueRate: correctTop1.length
        ? Number(((100 * rescued) / correctTop1.length).toFixed(1))
        : null,
      wrongTop1FalseHighRate: wrongTop1.length
        ? Number(((100 * falseHigh) / wrongTop1.length).toFixed(2))
        : null,
      rescuedCount: rescued,
      falseHighCount: falseHigh,
    }
  })

  // Per-profile breakdown for the CURRENT shipped threshold (0.82) specifically.
  const byProfile = {}
  for (const profile of [...new Set(observations.map((o) => o.profile))]) {
    const subset = observations.filter((o) => o.profile === profile)
    const correct = subset.filter((o) => o.top1Correct)
    const wrong = subset.filter((o) => !o.top1Correct)
    byProfile[profile] = {
      n: subset.length,
      top1AccuracyPct: subset.length
        ? Number(((100 * correct.length) / subset.length).toFixed(1))
        : null,
      at082: {
        correctTop1AboveThreshold: correct.filter((o) => o.top1Sim >= 0.82).length,
        correctTop1Total: correct.length,
        wrongTop1AboveThreshold: wrong.filter((o) => o.top1Sim >= 0.82).length,
        wrongTop1Total: wrong.length,
      },
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    totalObservations: observations.length,
    correctTop1Count: correctTop1.length,
    wrongTop1Count: wrongTop1.length,
    thresholdSweep: sweep,
    currentShippedThreshold: 0.82,
    byProfile,
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '06-dominance-threshold.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
