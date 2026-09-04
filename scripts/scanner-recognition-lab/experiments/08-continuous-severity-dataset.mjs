// P95 §2-3: continuous-severity dataset. Independent single-factor sweeps (6 axes x levels 1-5)
// plus a stratified set of pairwise interactions, against the SAME real ~4,300-card reference
// index every P91/P95 experiment uses. Every record carries the full P95 quality-metric vector
// (quality/metrics-v2.mjs) AND the retrieval outcome (rank/top1/top5/trueSim/nearestWrongSim/
// margin) so 09-quality-metric-correlation.mjs and 10-general-quality-gate.mjs can both consume
// this one dataset without re-embedding. Card-id-hash split (tune/holdout) baked in at generation
// time so no downstream script can accidentally leak.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { composeContinuous, AXES, SCALES, BRIGHTNESS_NORMAL_LEVEL } from '../augment/continuous.mjs'
import { computeQualityMetricsV2 } from '../quality/metrics-v2.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')
const CACHE_DIR = join(here, '..', '.cache')
const RECORDS_PATH = join(CACHE_DIR, 'continuous-severity-records.json')

function hashSplit(cardId, tuneFraction = 0.6) {
  let h = 0
  for (const ch of cardId) h = (h * 31 + ch.charCodeAt(0)) | 0
  const frac = (Math.abs(h) % 10000) / 10000
  return frac < tuneFraction ? 'tune' : 'holdout'
}

function stratifiedSample(rows, n, seedStr) {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

const PAIRS = [
  ['blur', 'glare'],
  ['shadow', 'noise'],
  ['perspective', 'brightness'],
  ['blur', 'shadow'],
  ['glare', 'noise'],
  ['perspective', 'blur'],
]
const PAIR_LEVELS = [2, 4] // moderate, severe — applied to BOTH axes of the pair simultaneously

async function main() {
  const nPerLevel = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 120)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()
  const sample = stratifiedSample(rows, nPerLevel, 'p95-continuous-severity')
  console.log(
    `[continuous] ${sample.length} cards x (1 baseline + 6 axes x 5 levels + 6 pairs x 2) queries`,
  )

  const records = []

  async function evalOne(row, tag, levelsApplied) {
    const raw = await readFile(row.imagePath)
    const queryBuf = await composeContinuous(raw, row.cardId, levelsApplied)
    const metrics = await computeQualityMetricsV2(queryBuf)
    const qVec = await embedImageBuffer(queryBuf)
    const hits = searchIndex(qVec, vectors)
    const rank = hits.findIndex((h) => h.cardId === row.cardId) + 1 || null
    const top1Sim = hits[0]?.similarity ?? null
    const top2Sim = hits[1]?.similarity ?? null
    const trueSim = hits.find((h) => h.cardId === row.cardId)?.similarity ?? null
    const nearestWrongSim = hits[0]?.cardId === row.cardId ? top2Sim : top1Sim
    records.push({
      cardId: row.cardId,
      split: hashSplit(row.cardId),
      tag,
      levelsApplied,
      metrics,
      rank,
      top1Correct: rank === 1,
      top5Correct: rank !== null && rank <= 5,
      bad: rank === null || rank > 20,
      trueSim,
      nearestWrongSim,
      margin: top1Sim !== null && top2Sim !== null ? top1Sim - top2Sim : null,
    })
  }

  let done = 0
  const total = sample.length * (1 + AXES.length * 5 + PAIRS.length * PAIR_LEVELS.length)

  for (const row of sample) {
    await evalOne(row, 'baseline', {})
    done += 1
  }
  console.log(`[continuous] baseline done (${done}/${total})`)

  for (const axis of AXES) {
    for (let level = 1; level <= 5; level += 1) {
      for (const row of sample) {
        const levelsApplied = axis === 'brightness' ? { brightness: level } : { [axis]: level }
        await evalOne(row, `single:${axis}`, levelsApplied)
        done += 1
      }
      console.log(`[continuous] single:${axis} level=${level} done (${done}/${total})`)
    }
  }

  for (const [axisA, axisB] of PAIRS) {
    for (const level of PAIR_LEVELS) {
      for (const row of sample) {
        const levelsApplied = { [axisA]: level, [axisB]: level }
        await evalOne(row, `pair:${axisA}+${axisB}`, levelsApplied)
        done += 1
      }
      console.log(`[continuous] pair:${axisA}+${axisB} level=${level} done (${done}/${total})`)
    }
  }

  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(RECORDS_PATH, JSON.stringify(records))
  console.log(`[continuous] wrote ${records.length} records to ${RECORDS_PATH}`)

  // Small summary report, keyed by tag+level, so a human can sanity-check the sweep without
  // loading the full records file.
  const byTag = new Map()
  for (const r of records) {
    const key = r.tag === 'baseline' ? 'baseline' : `${r.tag}:${JSON.stringify(r.levelsApplied)}`
    if (!byTag.has(key)) byTag.set(key, [])
    byTag.get(key).push(r)
  }
  const summary = {}
  for (const [key, recs] of byTag) {
    summary[key] = {
      n: recs.length,
      top1Pct: Number(((100 * recs.filter((r) => r.top1Correct).length) / recs.length).toFixed(1)),
      top5Pct: Number(((100 * recs.filter((r) => r.top5Correct).length) / recs.length).toFixed(1)),
      badPct: Number(((100 * recs.filter((r) => r.bad).length) / recs.length).toFixed(1)),
      meanTrueSim: Number(
        (recs.reduce((a, r) => a + (r.trueSim ?? 0), 0) / recs.length).toFixed(4),
      ),
      meanNearestWrongSim: Number(
        (recs.reduce((a, r) => a + (r.nearestWrongSim ?? 0), 0) / recs.length).toFixed(4),
      ),
    }
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '08-continuous-severity-dataset.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sampleSize: sample.length,
        totalRecords: records.length,
        summary,
      },
      null,
      2,
    ),
  )
  console.log(`[continuous] DONE — ${records.length} total query evaluations`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
