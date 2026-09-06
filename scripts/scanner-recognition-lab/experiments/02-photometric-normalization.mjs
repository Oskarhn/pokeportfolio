// Experiment 02 (§11): does any query-side photometric normalization rescue the hard-defect
// regime? P84 already tested ONE normalization and five crop/inset query variants and found 0%
// rescue (D-101 §3); this sweeps EIGHT distinct normalization transforms independently to check
// whether P84's negative result was specific to its one chosen transform.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { applyNormalization, NORMALIZATION_VARIANTS } from '../quality/normalize.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

function stratifiedSample(rows, n, seedStr = 'p91-normalization') {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 150)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN)
  console.log(
    `[norm] sample ${sample.length} of ${rows.length}; variants: ${NORMALIZATION_VARIANTS.join(', ')}`,
  )

  const profiles = ['tilted-glare-shadow-blur', 'skewed-partial-shadow-noisy']
  const tallies = {}
  for (const profile of profiles) {
    tallies[profile] = {}
    for (const variant of NORMALIZATION_VARIANTS)
      tallies[profile][variant] = { top1: 0, top5: 0, total: 0, sims: [] }
  }

  let done = 0
  for (const row of sample) {
    const buf = await readFile(row.imagePath)
    const trueId = row.cardId
    const hardQueries = await hardAugmentAll(buf, trueId, profiles)
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      for (const variant of NORMALIZATION_VARIANTS) {
        const normalized = await applyNormalization(variant, cropped)
        const vec = await embedImageBuffer(normalized)
        const hits = searchIndex(vec, vectors)
        const t = tallies[hq.profile][variant]
        t.total += 1
        const rank = hits.findIndex((h) => h.cardId === trueId) + 1 || null
        if (rank && rank <= 1) t.top1 += 1
        if (rank && rank <= 5) t.top5 += 1
        const trueSim = hits.find((h) => h.cardId === trueId)?.similarity ?? -1
        t.sims.push(trueSim)
      }
    }
    done += 1
    if (done % 25 === 0) console.log(`[norm] progress ${done}/${sample.length}`)
  }

  const summary = {}
  for (const profile of profiles) {
    summary[profile] = {}
    for (const variant of NORMALIZATION_VARIANTS) {
      const t = tallies[profile][variant]
      const meanSim = t.sims.reduce((a, b) => a + b, 0) / t.sims.length
      summary[profile][variant] = {
        n: t.total,
        top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)),
        top5Pct: Number(((100 * t.top5) / t.total).toFixed(1)),
        meanTrueSim: Number(meanSim.toFixed(4)),
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    corpusSize: rows.length,
    results: summary,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '02-photometric-normalization.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
