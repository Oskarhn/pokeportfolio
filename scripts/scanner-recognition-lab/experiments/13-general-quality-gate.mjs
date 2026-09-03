// P95 §4: a more general capture-quality abstention gate than P91's severe-blur-only detector
// (05-quality-gate.mjs), trained on the continuous-severity dataset (experiment 08) so it isn't
// calibrated against a bimodal-by-construction two-tier taxonomy. Three transparent, no-large-
// neural-model approaches, all card-id-separated (TRAIN/VALIDATION/HOLDOUT, no augmentation
// leakage — VALIDATION and HOLDOUT are drawn from cards the model/thresholds never trained on):
//   1. Rule tree — greedy top-N single-metric OR rule (generalizes P91's top-2 rule to N metrics,
//      N chosen on VALIDATION).
//   2. Logistic regression — standardized features, batch gradient descent + L2, dependency-free.
//   3. Calibration table — empirical bad-rate lookup binned on the single best-correlated metric.
// Threshold/model fit on TRAIN, any hyperparameter (rule count N, LR decision threshold, table
// bucket-count) selected on VALIDATION, everything evaluated exactly once on HOLDOUT.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { METRIC_DIRECTIONS_V2 } from '../quality/metrics-v2.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(here, '..', '.cache')
const REPORT_DIR = join(here, '..', 'reports')
const RECORDS_PATH = join(CACHE_DIR, 'continuous-severity-records.json')

const METRIC_NAMES = Object.keys(METRIC_DIRECTIONS_V2)

// Splits card-id-hash "tune" further into TRAIN/VALIDATION (70/30); "holdout" (already ~40% of
// all cards from experiment 08's own split) stays the final untouched HOLDOUT.
function trainValSplit(cardId, trainFraction = 0.7) {
  let h = 0
  for (const ch of cardId) h = (h * 17 + ch.charCodeAt(0)) | 0
  const frac = (Math.abs(h) % 10000) / 10000
  return frac < trainFraction ? 'train' : 'validation'
}

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
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const goodCaptureRejection = tn + fp > 0 ? fp / (tn + fp) : null
  const coverage = recordSet.length ? (tn + fn) / recordSet.length : null // fraction NOT flagged
  const acceptedAccuracy = tn + fn > 0 ? tn / (tn + fn) : null // of accepted, fraction actually good
  return {
    n: recordSet.length,
    tp,
    fp,
    tn,
    fn,
    recall,
    precision,
    goodCaptureRejection,
    coverage,
    acceptedAccuracy,
  }
}

// --- Model 1: rule tree (top-N metrics by TRAIN Youden's J, OR'd together) ---
function fitRuleTree(train, maxN = 5) {
  const perMetric = {}
  for (const [metric, direction] of Object.entries(METRIC_DIRECTIONS_V2)) {
    const values = train.map((r) => r.metrics[metric])
    const labels = train.map((r) => r.bad)
    perMetric[metric] = { direction, ...bestThreshold(values, labels, direction) }
  }
  const ranked = Object.entries(perMetric).sort((a, b) => b[1].j - a[1].j)
  return { perMetric, ranked, maxN }
}
function ruleTreePredict(record, perMetric, activeMetrics) {
  for (const metric of activeMetrics) {
    const t = perMetric[metric]
    const v = record.metrics[metric]
    if (t.direction === 'low-is-bad' ? v < t.threshold : v > t.threshold) return true
  }
  return false
}

// --- Model 2: logistic regression (standardized features, batch gradient descent + L2) ---
function standardize(records, featureNames, stats = null) {
  const X = records.map((r) => featureNames.map((m) => r.metrics[m]))
  if (!stats) {
    stats = featureNames.map((_, i) => {
      const col = X.map((row) => row[i])
      const mean = col.reduce((a, b) => a + b, 0) / col.length
      const std = Math.sqrt(col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length) || 1
      return { mean, std }
    })
  }
  const Xs = X.map((row) => row.map((v, i) => (v - stats[i].mean) / stats[i].std))
  return { Xs, stats }
}
function trainLogisticRegression(Xs, ys, { lr = 0.3, iters = 3000, l2 = 0.01 } = {}) {
  const n = Xs.length
  const d = Xs[0].length
  let weights = new Array(d).fill(0)
  let bias = 0
  for (let iter = 0; iter < iters; iter += 1) {
    const gradW = new Array(d).fill(0)
    let gradB = 0
    for (let i = 0; i < n; i += 1) {
      let z = bias
      for (let j = 0; j < d; j += 1) z += weights[j] * Xs[i][j]
      const p = 1 / (1 + Math.exp(-z))
      const err = p - ys[i]
      for (let j = 0; j < d; j += 1) gradW[j] += err * Xs[i][j]
      gradB += err
    }
    for (let j = 0; j < d; j += 1) weights[j] -= lr * (gradW[j] / n + l2 * weights[j])
    bias -= lr * (gradB / n)
  }
  return { weights, bias }
}
function logisticPredictProb(x, model) {
  let z = model.bias
  for (let j = 0; j < x.length; j += 1) z += model.weights[j] * x[j]
  return 1 / (1 + Math.exp(-z))
}

// --- Model 3: calibration table (empirical bad-rate bins on the single best metric) ---
function fitCalibrationTable(train, metric, direction, numBins = 10) {
  const values = train.map((r) => r.metrics[metric]).sort((a, b) => a - b)
  const edges = []
  for (let b = 1; b < numBins; b += 1) edges.push(values[Math.floor((b * values.length) / numBins)])
  function binOf(v) {
    let bin = 0
    while (bin < edges.length && v > edges[bin]) bin += 1
    return bin
  }
  const bins = Array.from({ length: numBins }, () => ({ total: 0, bad: 0 }))
  for (const r of train) {
    const bin = binOf(r.metrics[metric])
    bins[bin].total += 1
    if (r.bad) bins[bin].bad += 1
  }
  const badRates = bins.map((b) => (b.total ? b.bad / b.total : 0))
  return { metric, direction, edges, badRates, binOf }
}

async function main() {
  const records = JSON.parse(await readFile(RECORDS_PATH, 'utf-8'))
  const tuneRecords = records.filter((r) => r.split === 'tune')
  const holdout = records.filter((r) => r.split === 'holdout')
  const train = tuneRecords.filter((r) => trainValSplit(r.cardId) === 'train')
  const validation = tuneRecords.filter((r) => trainValSplit(r.cardId) === 'validation')
  console.log(
    `[gate] train=${train.length} validation=${validation.length} holdout=${holdout.length}`,
  )

  // --- Rule tree: pick N (1..6) on VALIDATION ---
  const ruleFit = fitRuleTree(train)
  let bestRuleN = 1
  let bestRuleValRecall = -1
  const ruleValCurve = []
  for (let n = 1; n <= 6; n += 1) {
    const activeMetrics = ruleFit.ranked.slice(0, n).map(([m]) => m)
    const evalResult = evaluate(validation, (r) =>
      ruleTreePredict(r, ruleFit.perMetric, activeMetrics),
    )
    ruleValCurve.push({
      n,
      recall: evalResult.recall,
      precision: evalResult.precision,
      goodCaptureRejection: evalResult.goodCaptureRejection,
    })
    // Prefer higher recall subject to goodCaptureRejection staying under 10%.
    if (
      (evalResult.goodCaptureRejection ?? 1) <= 0.1 &&
      (evalResult.recall ?? 0) > bestRuleValRecall
    ) {
      bestRuleValRecall = evalResult.recall
      bestRuleN = n
    }
  }
  const ruleActiveMetrics = ruleFit.ranked.slice(0, bestRuleN).map(([m]) => m)
  const rulePredict = (r) => ruleTreePredict(r, ruleFit.perMetric, ruleActiveMetrics)

  // --- Logistic regression: fit on TRAIN, pick decision threshold on VALIDATION ---
  const { Xs: trainXs, stats } = standardize(train, METRIC_NAMES)
  const ys = train.map((r) => (r.bad ? 1 : 0))
  const lrModel = trainLogisticRegression(trainXs, ys)
  const { Xs: valXs } = standardize(validation, METRIC_NAMES, stats)
  const valProbs = valXs.map((x) => logisticPredictProb(x, lrModel))
  const lrThresholdFit = bestThreshold(
    valProbs,
    validation.map((r) => r.bad),
    'high-is-bad',
  )
  function lrPredict(record) {
    const { Xs } = standardize([record], METRIC_NAMES, stats)
    return logisticPredictProb(Xs[0], lrModel) > lrThresholdFit.threshold
  }

  // --- Calibration table: single best metric (by TRAIN Youden's J), bucket bad-rate threshold
  //     picked on VALIDATION to match the rule tree's own recall target for comparability ---
  const bestMetricName = ruleFit.ranked[0][0]
  const bestMetricDirection = METRIC_DIRECTIONS_V2[bestMetricName]
  const calTable = fitCalibrationTable(train, bestMetricName, bestMetricDirection)
  let bestCalBadRateThreshold = 0.5
  let bestCalValRecall = -1
  for (const t of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
    function calPredictAt(record, thresh) {
      const bin = calTable.binOf(record.metrics[bestMetricName])
      return calTable.badRates[bin] >= thresh
    }
    const evalResult = evaluate(validation, (r) => calPredictAt(r, t))
    if (
      (evalResult.goodCaptureRejection ?? 1) <= 0.1 &&
      (evalResult.recall ?? 0) > bestCalValRecall
    ) {
      bestCalValRecall = evalResult.recall
      bestCalBadRateThreshold = t
    }
  }
  function calPredict(record) {
    const bin = calTable.binOf(record.metrics[bestMetricName])
    return calTable.badRates[bin] >= bestCalBadRateThreshold
  }

  const models = {
    ruleTree: {
      predict: rulePredict,
      meta: { activeMetrics: ruleActiveMetrics, n: bestRuleN, valCurve: ruleValCurve },
    },
    logisticRegression: {
      predict: lrPredict,
      meta: {
        weights: lrModel.weights,
        bias: lrModel.bias,
        threshold: lrThresholdFit.threshold,
        featureOrder: METRIC_NAMES,
      },
    },
    calibrationTable: {
      predict: calPredict,
      meta: {
        metric: bestMetricName,
        direction: bestMetricDirection,
        badRateThreshold: bestCalBadRateThreshold,
        badRates: calTable.badRates,
      },
    },
  }

  const results = {}
  for (const [name, model] of Object.entries(models)) {
    results[name] = {
      train: evaluate(train, model.predict),
      validation: evaluate(validation, model.predict),
      holdout: evaluate(holdout, model.predict),
      meta: model.meta,
    }
  }

  // Overfit check: train vs holdout recall/precision gap.
  const overfitCheck = Object.fromEntries(
    Object.entries(results).map(([name, r]) => [
      name,
      {
        trainRecall: r.train.recall,
        holdoutRecall: r.holdout.recall,
        recallGap:
          r.train.recall !== null && r.holdout.recall !== null
            ? Number((r.train.recall - r.holdout.recall).toFixed(3))
            : null,
        trainPrecision: r.train.precision,
        holdoutPrecision: r.holdout.precision,
        precisionGap:
          r.train.precision !== null && r.holdout.precision !== null
            ? Number((r.train.precision - r.holdout.precision).toFixed(3))
            : null,
      },
    ]),
  )

  // Per-condition holdout breakdown (baseline vs single-axis vs pair), so a general gate's
  // uneven coverage across regimes is visible, matching P91's honest-disclosure discipline.
  const byTag = {}
  for (const [name, model] of Object.entries(models)) {
    byTag[name] = {}
    const tagGroups = new Map()
    for (const r of holdout) {
      const key = r.tag.startsWith('single:')
        ? r.tag
        : r.tag.startsWith('pair:')
          ? 'pair'
          : 'baseline'
      if (!tagGroups.has(key)) tagGroups.set(key, [])
      tagGroups.get(key).push(r)
    }
    for (const [tag, recs] of tagGroups) {
      byTag[name][tag] = {
        badRate: recs.length
          ? Number(((100 * recs.filter((r) => r.bad).length) / recs.length).toFixed(1))
          : null,
        ...evaluate(recs, model.predict),
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    trainN: train.length,
    validationN: validation.length,
    holdoutN: holdout.length,
    results,
    overfitCheck,
    holdoutByTag: byTag,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '13-general-quality-gate.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ results, overfitCheck }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
