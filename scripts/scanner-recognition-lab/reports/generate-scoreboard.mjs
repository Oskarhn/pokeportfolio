// Reads every experiment's JSON report and writes one concise markdown scoreboard (§3). Run after
// the experiments you care about have produced their reports/*.json files.
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf-8'))
}

async function main() {
  const lines = []
  lines.push('# P91 Scanner Recognition R&D — Scoreboard')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  const baseline = await readJsonIfExists(join(here, '01-baseline.json'))
  if (baseline) {
    lines.push(
      '## 01 — Baseline (production-equivalent CLS, pristine reference, single-crop query)',
    )
    lines.push('')
    lines.push(
      `Corpus: ${baseline.corpusSize} cards. Query sample: ${baseline.querySampleSize}. Confusable groups: ${baseline.confusableGroups} (covering ${baseline.confusableCardCoverage} cards).`,
    )
    lines.push('')
    lines.push('| Profile | TOP1 | TOP3 | TOP5 | TOP20 | mean true-sim | mean nearest-wrong-sim |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const [profile, r] of Object.entries(baseline.overall)) {
      lines.push(
        `| ${profile} | ${r.top1Pct}% | ${r.top3Pct}% | ${r.top5Pct}% | ${r.top20Pct}% | ${r.meanTrueSim} | ${r.meanNearestWrongSim} |`,
      )
    }
    lines.push('')
  }

  const norm = await readJsonIfExists(join(here, '02-photometric-normalization.json'))
  if (norm) {
    lines.push('## 02 — Photometric normalization sweep (hard-defect profiles only)')
    lines.push('')
    for (const [profile, variants] of Object.entries(norm.results)) {
      lines.push(`### ${profile}`)
      lines.push('')
      lines.push('| Variant | TOP1 | TOP5 | mean true-sim |')
      lines.push('|---|---|---|---|')
      for (const [variant, r] of Object.entries(variants))
        lines.push(`| ${variant} | ${r.top1Pct}% | ${r.top5Pct}% | ${r.meanTrueSim} |`)
      lines.push('')
    }
  }

  const robust = await readJsonIfExists(join(here, '03-robust-reference.json'))
  if (robust) {
    lines.push('## 03 — Reference-side augmentation / robust-centroid strategies')
    lines.push('')
    lines.push(
      '| Strategy | clean TOP1 | geometry TOP1 | glare/shadow/blur TOP1 | shadow/noise TOP1 |',
    )
    lines.push('|---|---|---|---|---|')
    for (const strategy of robust.strategies) {
      const r = robust.results[strategy]
      lines.push(
        `| ${strategy} | ${r.clean.top1Pct}% | ${r.geometryOnly.top1Pct}% | ${r.hardGlareShadowBlur.top1Pct}% | ${r.hardShadowNoise.top1Pct}% |`,
      )
    }
    lines.push('')
  }

  const pooling = await readJsonIfExists(join(here, '04-pooling-sweep.json'))
  if (pooling) {
    lines.push('## 04 — DINO output-representation (pooling) sweep')
    lines.push('')
    lines.push('| Variant | clean TOP1 | glare/shadow/blur TOP1 | shadow/noise TOP1 |')
    lines.push('|---|---|---|---|')
    for (const v of pooling.poolingVariants) {
      const r = pooling.results[v]
      lines.push(
        `| ${v} | ${r.clean.top1Pct}% | ${r.hardGlareShadowBlur.top1Pct}% | ${r.hardShadowNoise.top1Pct}% |`,
      )
    }
    lines.push('')
  }

  const quality = await readJsonIfExists(join(here, '05-quality-gate.json'))
  if (quality) {
    lines.push('## 05 — Capture-quality abstention gate')
    lines.push('')
    lines.push(
      `Tune N=${quality.tuneN}, Holdout N=${quality.holdoutN}. Top discriminating metrics: ${quality.topTwoDiscriminatingMetrics.join(', ')}.`,
    )
    lines.push('')
    lines.push('| Split | recall (BAD_CAPTURE_RECALL) | precision | good-capture false-rejection |')
    lines.push('|---|---|---|---|')
    lines.push(
      `| tune | ${quality.tuneSplitEvaluation.recall} | ${quality.tuneSplitEvaluation.precision} | ${quality.tuneSplitEvaluation.goodFalseRejection} |`,
    )
    lines.push(
      `| holdout | ${quality.holdoutSplitEvaluation.recall} | ${quality.holdoutSplitEvaluation.precision} | ${quality.holdoutSplitEvaluation.goodFalseRejection} |`,
    )
    lines.push('')
    lines.push(
      `WRONG_RESULTS_SUPPRESSED on holdout BAD queries: ${quality.wrongResultsSuppressedOnHoldoutBad}%`,
    )
    lines.push('')
  }

  const dominance = await readJsonIfExists(join(here, '06-dominance-threshold.json'))
  if (dominance) {
    lines.push('## 06 — Visual-dominance guard threshold calibration')
    lines.push('')
    lines.push('| Threshold | correct-TOP1 rescue rate | wrong-TOP1 false-high rate |')
    lines.push('|---|---|---|')
    for (const s of dominance.thresholdSweep)
      lines.push(`| ${s.threshold} | ${s.correctTop1RescueRate}% | ${s.wrongTop1FalseHighRate}% |`)
    lines.push('')
  }

  const artCrop = await readJsonIfExists(join(here, '07-art-crop-confusable.json'))
  if (artCrop) {
    lines.push('## 07 — Art-crop dual-score confusable-sibling discrimination (clean queries only)')
    lines.push('')
    lines.push(
      `Groups evaluated: ${artCrop.groupsEvaluated}, total queries: ${artCrop.totalQueries}`,
    )
    lines.push('')
    lines.push('| Representation | TOP1-among-siblings |')
    lines.push('|---|---|')
    for (const [k, r] of Object.entries(artCrop.results)) lines.push(`| ${k} | ${r.top1Pct}% |`)
    lines.push('')
  }

  const outPath = join(here, 'SCOREBOARD.md')
  await writeFile(outPath, lines.join('\n'))
  console.log(`Wrote ${outPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
