// Experiment 05 (§15-21): capture-quality abstention gate. Ground truth for "bad capture" is
// TRUE_CARD_RANK is null or >20 against the full ~4,300-card reference index — a failure the
// production shortlist (VISUAL_SHORTLIST_SIZE=30) could not recover from regardless of matcher
// logic downstream. Every quality feature comes from quality/metrics.mjs and uses ONLY the
// captured (cropped) query image — never the true card identity, never the retrieval result
// itself — exactly what a real pre-shutter or post-capture gate would have available.
//
// Train/validation discipline (§21): split BY CARD ID (60% tune / 40% holdout, deterministic hash
// of cardId) so no card's own augmentations leak across the split. Thresholds are picked by a
// simple, transparent per-metric Youden's-J search on the TUNE split only, then evaluated once,
// unmodified, on the HOLDOUT split.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { computeQualityMetrics } from '../quality/metrics.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

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

const METRIC_DIRECTIONS = {
  laplacianVariance: 'low-is-bad',
  tenengrad: 'low-is-bad',
  glareFraction: 'high-is-bad',
  clippedFraction: 'high-is-bad',
  shadowCv: 'high-is-bad',
  contrastStd: 'low-is-bad',
}

/** Youden's J (TPR - FPR) grid search over every observed value as a candidate threshold. */
function bestThreshold(values, labels, direction) {
  const candidates = [...new Set(values)].sort((a, b) => a - b)
  const positives = labels.filter((l) => l).length
  const negatives = labels.length - positives
  let best = { threshold: candidates[0], j: -Infinity, tpr: 0, fpr: 0 }
  for (const t of candidates) {
    let tp = 0,
      fp = 0
    for (let i = 0; i < values.length; i += 1) {
      const flagged = direction === 'low-is-bad' ? values[i] < t : values[i] > t
      if (flagged && labels[i]) tp += 1
      if (flagged && !labels[i]) fp += 1
    }
    const tpr = positives > 0 ? tp / positives : 0
    const fpr = negatives > 0 ? fp / negatives : 0
    const j = tpr - fpr
    if (j > best.j) best = { threshold: t, j, tpr, fpr }
  }
  return best
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 500)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN, 'p91-quality-gate')
  console.log(`[quality] sample ${sample.length} of ${rows.length}`)

  const records = [] // { split, profile, trueId, metrics, rank, top1Sim, top2Sim, margin, bad }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const split = hashSplit(trueId)
    const buf = await readFile(row.imagePath)

    async function evalQuery(queryBuffer, profile) {
      const metrics = await computeQualityMetrics(queryBuffer)
      const qVec = await embedImageBuffer(queryBuffer)
      const hits = searchIndex(qVec, vectors)
      const rank = hits.findIndex((h) => h.cardId === trueId) + 1 || null
      const top1Sim = hits[0]?.similarity ?? null
      const top2Sim = hits[1]?.similarity ?? null
      const margin = top1Sim !== null && top2Sim !== null ? top1Sim - top2Sim : null
      const bad = rank === null || rank > 20
      records.push({ split, profile, trueId, metrics, rank, top1Sim, top2Sim, margin, bad })
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
    if (done % 50 === 0) console.log(`[quality] progress ${done}/${sample.length}`)
  }

  const tuneRecords = records.filter((r) => r.split === 'tune')
  const holdoutRecords = records.filter((r) => r.split === 'holdout')
  console.log(`[quality] tune=${tuneRecords.length} holdout=${holdoutRecords.length}`)

  // Per-metric standalone Youden's-J thresholds, fit on TUNE only.
  const perMetricThresholds = {}
  for (const [metric, direction] of Object.entries(METRIC_DIRECTIONS)) {
    const values = tuneRecords.map((r) => r.metrics[metric])
    const labels = tuneRecords.map((r) => r.bad)
    perMetricThresholds[metric] = { direction, ...bestThreshold(values, labels, direction) }
  }

  // Margin/top1-similarity thresholds too (§17-19): low-is-bad for both.
  const marginValues = tuneRecords.filter((r) => r.margin !== null).map((r) => r.margin)
  const marginLabels = tuneRecords.filter((r) => r.margin !== null).map((r) => r.bad)
  const marginThreshold = bestThreshold(marginValues, marginLabels, 'low-is-bad')
  const top1Values = tuneRecords.filter((r) => r.top1Sim !== null).map((r) => r.top1Sim)
  const top1Labels = tuneRecords.filter((r) => r.top1Sim !== null).map((r) => r.bad)
  const top1Threshold = bestThreshold(top1Values, top1Labels, 'low-is-bad')

  // Combined rule (§15 rule tree): OR the two most separating quality metrics + the top1-sim
  // threshold (chosen by highest individual J on TUNE, not hand-picked).
  const rankedMetrics = Object.entries(perMetricThresholds).sort((a, b) => b[1].j - a[1].j)
  const topTwoMetrics = rankedMetrics.slice(0, 2).map(([name]) => name)
  console.log(`[quality] top-2 discriminating metrics on TUNE: ${topTwoMetrics.join(', ')}`)

  function combinedRuleFlags(record) {
    for (const metric of topTwoMetrics) {
      const t = perMetricThresholds[metric]
      const v = record.metrics[metric]
      if (t.direction === 'low-is-bad' ? v < t.threshold : v > t.threshold) return true
    }
    if (record.top1Sim !== null && record.top1Sim < top1Threshold.threshold) return true
    return false
  }

  function evaluate(recordSet, predictFn) {
    let tp = 0,
      fp = 0,
      tn = 0,
      fn = 0
    for (const r of recordSet) {
      const predicted = predictFn(r)
      if (predicted && r.bad) tp += 1
      else if (predicted && !r.bad) fp += 1
      else if (!predicted && !r.bad) tn += 1
      else fn += 1
    }
    const recall = tp + fn > 0 ? tp / (tp + fn) : null // BAD_CAPTURE_RECALL
    const precision = tp + fp > 0 ? tp / (tp + fp) : null // BAD_CAPTURE_PRECISION
    const goodFalseRejection = tn + fp > 0 ? fp / (tn + fp) : null // GOOD captures wrongly gated
    return { n: recordSet.length, tp, fp, tn, fn, recall, precision, goodFalseRejection }
  }

  const holdoutEval = evaluate(holdoutRecords, combinedRuleFlags)
  const tuneEval = evaluate(tuneRecords, combinedRuleFlags)

  // WRONG_RESULTS_SUPPRESSED: of holdout BAD queries the gate correctly flags, how many would
  // otherwise have shown a wrong TOP1 to the user (top1Sim not null — a result existed to show).
  const holdoutBad = holdoutRecords.filter((r) => r.bad)
  const holdoutBadFlagged = holdoutBad.filter(combinedRuleFlags)
  const wrongResultsSuppressed =
    holdoutBad.length > 0 ? holdoutBadFlagged.length / holdoutBad.length : null

  // Per-profile breakdown on holdout, for honesty about which regimes the gate actually helps.
  const byProfile = {}
  for (const profile of [
    'clean',
    'tilted-offcenter',
    'tilted-glare-shadow-blur',
    'skewed-partial-shadow-noisy',
  ]) {
    const subset = holdoutRecords.filter((r) => r.profile === profile)
    byProfile[profile] = {
      badRate: subset.length
        ? Number(((100 * subset.filter((r) => r.bad).length) / subset.length).toFixed(1))
        : null,
      ...evaluate(subset, combinedRuleFlags),
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    tuneN: tuneRecords.length,
    holdoutN: holdoutRecords.length,
    perMetricThresholdsTunedOnTuneSplit: perMetricThresholds,
    marginThresholdTunedOnTuneSplit: marginThreshold,
    top1SimThresholdTunedOnTuneSplit: top1Threshold,
    topTwoDiscriminatingMetrics: topTwoMetrics,
    tuneSplitEvaluation: tuneEval,
    holdoutSplitEvaluation: holdoutEval,
    wrongResultsSuppressedOnHoldoutBad:
      wrongResultsSuppressed !== null ? Number((100 * wrongResultsSuppressed).toFixed(1)) : null,
    holdoutByProfile: byProfile,
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '05-quality-gate.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
