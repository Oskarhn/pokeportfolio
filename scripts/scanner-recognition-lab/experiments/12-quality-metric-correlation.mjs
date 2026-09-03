// P95 §3: correlates every pixel-only capture-quality metric (quality/metrics-v2.mjs) AND each
// axis's own ground-truth synthetic severity level against actual retrieval failure, using the
// continuous-severity dataset experiment 08 already generated. Pearson correlation throughout
// (point-biserial for the 0/1 outcomes, which is mathematically identical to Pearson on a binary
// variable). TUNE-split records only, matching 08/13's split discipline — this is descriptive
// analysis, not a fitted model, but keeping it on one split avoids implicitly peeking at holdout
// before 13-general-quality-gate.mjs evaluates there.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(here, '..', '.cache')
const REPORT_DIR = join(here, '..', 'reports')
const RECORDS_PATH = join(CACHE_DIR, 'continuous-severity-records.json')

function pearson(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0,
    denX = 0,
    denY = 0
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX
    const dy = ys[i] - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }
  const den = Math.sqrt(denX * denY)
  return den > 0 ? Number((num / den).toFixed(4)) : null
}

const METRIC_NAMES = [
  'laplacianVariance',
  'tenengrad',
  'edgeDensity',
  'glareFraction',
  'clippedFraction',
  'darkClippedFraction',
  'shadowCv',
  'contrastStd',
  'brightnessMean',
  'meanBlockStd',
  'blockStdSpread',
]

const TARGETS = {
  reciprocalRank: (r) => (r.rank ? 1 / r.rank : 0),
  top1Correct: (r) => (r.top1Correct ? 1 : 0),
  top5Correct: (r) => (r.top5Correct ? 1 : 0),
  bad: (r) => (r.bad ? 1 : 0),
  trueSim: (r) => r.trueSim ?? 0,
  nearestWrongSim: (r) => r.nearestWrongSim ?? 0,
  margin: (r) => r.margin ?? 0,
}

async function main() {
  const records = JSON.parse(await readFile(RECORDS_PATH, 'utf-8'))
  const tune = records.filter((r) => r.split === 'tune')
  console.log(`[correlation] ${tune.length} tune-split records (of ${records.length} total)`)

  const metricCorrelations = {}
  for (const metric of METRIC_NAMES) {
    metricCorrelations[metric] = {}
    const xs = tune.map((r) => r.metrics[metric])
    for (const [targetName, fn] of Object.entries(TARGETS)) {
      const ys = tune.map(fn)
      metricCorrelations[metric][targetName] = pearson(xs, ys)
    }
  }

  // Rank metrics by |correlation with reciprocalRank| — the single most direct "predicts
  // inversion" signal (reciprocalRank=1 means perfect TOP1, ~0 means lost/deep-ranked).
  const rankedByReciprocalRank = Object.entries(metricCorrelations)
    .map(([metric, corrs]) => ({ metric, r: corrs.reciprocalRank }))
    .filter((x) => x.r !== null)
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))

  // Ground-truth synthetic severity level per axis (single-factor records only) vs the same
  // targets — "how much does the axis's OWN dial position predict failure," independent of any
  // pixel metric's ability to detect it.
  const axisSeverityCorrelations = {}
  const axes = ['blur', 'shadow', 'glare', 'noise', 'perspective', 'brightness']
  for (const axis of axes) {
    const axisRecords = tune.filter(
      (r) => r.tag === `single:${axis}` || (r.tag === 'baseline' && axis !== 'brightness'),
    )
    // baseline records carry no explicit level for this axis; treat as level 0 (brightness
    // baseline is level 3/"normal" — excluded above since 0 would misrepresent it).
    const xs = axisRecords.map((r) => r.levelsApplied[axis] ?? 0)
    axisSeverityCorrelations[axis] = {}
    for (const [targetName, fn] of Object.entries(TARGETS)) {
      const ys = axisRecords.map(fn)
      axisSeverityCorrelations[axis][targetName] = pearson(xs, ys)
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    tuneRecordCount: tune.length,
    metricNames: METRIC_NAMES,
    metricCorrelations,
    rankedMetricsByReciprocalRankCorrelation: rankedByReciprocalRank,
    axisGroundTruthSeverityCorrelations: axisSeverityCorrelations,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '12-quality-metric-correlation.json'),
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
