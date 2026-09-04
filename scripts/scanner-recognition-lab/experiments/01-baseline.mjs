// Experiment 01: reproduce the project's own documented baseline (D-101 §2) on the NEW ~4,300-card
// P91 corpus, PLUS confusable-group-aware scoring the 240-card corpus could never measure (§6/§19).
// Query methodology matches hard-augment's own "simple crop" (crop to the nominal/guide rect,
// exactly what a pre-rectify pipeline stage would feed the embedder) so results are the closest
// apples-to-apples comparison available to D-101's calibrated table without re-running rectify.ts
// itself (that stays scoped to production code, not duplicated into this R&D lab).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { buildConfusableGroups, buildCardToGroup } from '../retrieval/confusable-groups.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

function stratifiedSample(rows, n, seedStr = 'p91-baseline') {
  // Deterministic pseudo-random stratified-by-position sample (even stride + fixed offset) — no
  // RNG dependency, fully reproducible from the corpus order alone.
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1) {
    out.push(rows[(offset + i * stride) % rows.length])
  }
  return out
}

function freshTally() {
  return { top1: 0, top3: 0, top5: 0, top20: 0, total: 0, sims: [], wrongSims: [] }
}
function record(tally, hits, trueId) {
  tally.total += 1
  const rank = hits.findIndex((h) => h.cardId === trueId) + 1 || null
  if (rank) {
    if (rank <= 1) tally.top1 += 1
    if (rank <= 3) tally.top3 += 1
    if (rank <= 5) tally.top5 += 1
    if (rank <= 20) tally.top20 += 1
  }
  const trueSim = hits.find((h) => h.cardId === trueId)?.similarity ?? -1
  const nearestWrong = hits.find((h) => h.cardId !== trueId)
  tally.sims.push(trueSim)
  tally.wrongSims.push(nearestWrong ? nearestWrong.similarity : null)
  return { rank, trueSim, nearestWrong }
}
function mean(arr) {
  const v = arr.filter((x) => x !== null && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
function summarize(tally) {
  return {
    n: tally.total,
    top1Pct: Number(((100 * tally.top1) / tally.total).toFixed(1)),
    top3Pct: Number(((100 * tally.top3) / tally.total).toFixed(1)),
    top5Pct: Number(((100 * tally.top5) / tally.total).toFixed(1)),
    top20Pct: Number(((100 * tally.top20) / tally.total).toFixed(1)),
    meanTrueSim: Number((mean(tally.sims) ?? -1).toFixed(4)),
    meanNearestWrongSim: Number((mean(tally.wrongSims) ?? -1).toFixed(4)),
  }
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 300)

  console.log('[baseline] loading reference index...')
  const { rows, vectors } = await buildReferenceIndex()
  console.log(`[baseline] reference index: ${vectors.size} cards`)

  const groups = buildConfusableGroups(rows)
  const cardToGroup = buildCardToGroup(groups)
  console.log(
    `[baseline] confusable groups: ${groups.size} groups covering ${cardToGroup.size} cards`,
  )

  await warmUpModel()
  const sample = stratifiedSample(rows, queryN)
  console.log(`[baseline] query sample: ${sample.length} of ${rows.length} cards`)

  const tallies = {
    clean: freshTally(),
    geometryOnly: freshTally(),
    hardGlareShadowBlur: freshTally(),
    hardShadowNoise: freshTally(),
  }
  const confusableTallies = {
    clean: freshTally(),
    geometryOnly: freshTally(),
    hardGlareShadowBlur: freshTally(),
    hardShadowNoise: freshTally(),
  }
  let wrongInSameGroupCount = {
    clean: 0,
    geometryOnly: 0,
    hardGlareShadowBlur: 0,
    hardShadowNoise: 0,
  }

  const perQueryDetail = []

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    // clean: pristine reference image itself, embedded fresh (not read from the cached index) —
    // measures embedding-pipeline-only self-retrieval noise (should be ~100%).
    const cleanVec = await embedImageBuffer(buf)
    const cleanHits = searchIndex(cleanVec, vectors)
    record(tallies.clean, cleanHits, trueId)
    if (cardToGroup.has(trueId)) {
      record(confusableTallies.clean, cleanHits, trueId)
      const nearestWrong = cleanHits.find((h) => h.cardId !== trueId)
      if (nearestWrong && cardToGroup.get(nearestWrong.cardId) === cardToGroup.get(trueId)) {
        wrongInSameGroupCount.clean += 1
      }
    }

    const hardQueries = await hardAugmentAll(buf, trueId)
    for (const hq of hardQueries) {
      const key =
        hq.profile === 'tilted-offcenter'
          ? 'geometryOnly'
          : hq.profile === 'tilted-glare-shadow-blur'
            ? 'hardGlareShadowBlur'
            : 'hardShadowNoise'
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      const qVec = await embedImageBuffer(cropped)
      const hits = searchIndex(qVec, vectors)
      record(tallies[key], hits, trueId)
      if (cardToGroup.has(trueId)) {
        record(confusableTallies[key], hits, trueId)
        const nearestWrong = hits.find((h) => h.cardId !== trueId)
        if (nearestWrong && cardToGroup.get(nearestWrong.cardId) === cardToGroup.get(trueId)) {
          wrongInSameGroupCount[key] += 1
        }
      }
    }

    done += 1
    if (done % 50 === 0) console.log(`[baseline] progress ${done}/${sample.length}`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    corpusSize: rows.length,
    querySampleSize: sample.length,
    confusableGroups: groups.size,
    confusableCardCoverage: cardToGroup.size,
    overall: Object.fromEntries(Object.entries(tallies).map(([k, t]) => [k, summarize(t)])),
    confusableOnly: Object.fromEntries(
      Object.entries(confusableTallies).map(([k, t]) => [
        k,
        {
          ...summarize(t),
          wrongInSameConfusableGroupRate: t.total
            ? Number(((100 * wrongInSameGroupCount[k]) / t.total).toFixed(1))
            : null,
        },
      ]),
    ),
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '01-baseline.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
