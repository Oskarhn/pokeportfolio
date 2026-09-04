// P95 §6: redoes P91's art-crop confusable experiment (07-art-crop-confusable.mjs), which was
// INCONCLUSIVE BY DESIGN because its queries were always clean (query == reference under clean
// conditions is a ceiling-effect tautology — see output_91.txt ART_CROP_RESULT). This version uses
// DISTORTED queries (geometry-only, the new §17 iPhone-like moderate profile, and a hard-defect
// profile) against each true card's own confusable-group candidate pool, comparing five
// representations: full-card, art-crop-only, dual-average (mean of full+art-crop SIMILARITY
// scores), dual-max, and reciprocal-rank-fusion of the two independent rankings. Runs against BOTH
// the confusable-restricted pool and the full ~4,300-card corpus (the prompt's own "then full
// corpus if promising" — always run both here since the marginal cost is small once both indexes
// exist).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex } from '../retrieval/build-index.mjs'
import { buildArtCropIndex } from '../retrieval/build-art-crop-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { applyNamedProfile } from '../augment/photometric.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { composeContinuous, IPHONE_LIKE_LEVELS } from '../augment/continuous.mjs'
import { artCrop } from '../quality/art-crop.mjs'
import { buildConfusableGroups } from '../retrieval/confusable-groups.mjs'

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

function searchWithin(cardIds, fullVec, artVec, fullVectors, artVectors) {
  const rows = []
  for (const id of cardIds) {
    rows.push({
      cardId: id,
      simFull: dot(fullVec, fullVectors.get(id)),
      simArt: dot(artVec, artVectors.get(id)),
    })
  }
  return rows
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

function rankOf(sortedIds, trueId) {
  const idx = sortedIds.indexOf(trueId)
  return idx === -1 ? null : idx + 1
}

function evalRepresentations(rows, trueId) {
  const byFull = [...rows].sort((a, b) => b.simFull - a.simFull).map((r) => r.cardId)
  const byArt = [...rows].sort((a, b) => b.simArt - a.simArt).map((r) => r.cardId)
  const byDualAvg = [...rows]
    .sort((a, b) => (b.simFull + b.simArt) / 2 - (a.simFull + a.simArt) / 2)
    .map((r) => r.cardId)
  const byDualMax = [...rows]
    .sort((a, b) => Math.max(b.simFull, b.simArt) - Math.max(a.simFull, a.simArt))
    .map((r) => r.cardId)

  const fullRank = new Map(byFull.map((id, i) => [id, i + 1]))
  const artRank = new Map(byArt.map((id, i) => [id, i + 1]))
  const RRF_K = 60
  const byRankFusion = [...rows]
    .map((r) => ({
      cardId: r.cardId,
      score: 1 / (RRF_K + fullRank.get(r.cardId)) + 1 / (RRF_K + artRank.get(r.cardId)),
    }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.cardId)

  return {
    full: rankOf(byFull, trueId),
    artCrop: rankOf(byArt, trueId),
    dualAverage: rankOf(byDualAvg, trueId),
    dualMax: rankOf(byDualMax, trueId),
    rankFusion: rankOf(byRankFusion, trueId),
  }
}

function freshTally() {
  const reps = ['full', 'artCrop', 'dualAverage', 'dualMax', 'rankFusion']
  const t = { n: 0 }
  for (const r of reps) t[r] = { top1: 0, top5: 0 }
  return t
}
function record(tally, ranks) {
  tally.n += 1
  for (const [rep, rank] of Object.entries(ranks)) {
    if (rank && rank <= 1) tally[rep].top1 += 1
    if (rank && rank <= 5) tally[rep].top5 += 1
  }
}
function summarize(t) {
  const out = { n: t.n }
  for (const rep of ['full', 'artCrop', 'dualAverage', 'dualMax', 'rankFusion']) {
    out[rep] = {
      top1Pct: t.n ? Number(((100 * t[rep].top1) / t.n).toFixed(1)) : null,
      top5Pct: t.n ? Number(((100 * t[rep].top5) / t.n).toFixed(1)) : null,
    }
  }
  return out
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 400)
  const { rows, vectors: fullVectors } = await buildReferenceIndex()
  const { vectors: artVectors } = await buildArtCropIndex()
  await warmUpModel()

  const groups = buildConfusableGroups(rows)
  const cardToGroupCards = new Map()
  for (const [, cardIds] of groups) for (const id of cardIds) cardToGroupCards.set(id, cardIds)

  const groupedRows = rows.filter((r) => cardToGroupCards.has(r.cardId))
  const sample = stratifiedSample(groupedRows, queryN, 'p95-art-crop-confusable')
  console.log(`[art-crop] sample ${sample.length} confusable-group cards of ${groupedRows.length}`)

  const allCardIds = rows.map((r) => r.cardId)

  const conditions = ['geometryOnly', 'iphoneLikeModerate', 'hardGlareShadowBlur']
  const restrictedTallies = Object.fromEntries(conditions.map((c) => [c, freshTally()]))
  const fullCorpusTallies = Object.fromEntries(conditions.map((c) => [c, freshTally()]))

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)
    const groupCards = cardToGroupCards.get(trueId)

    async function evalCondition(queryBuf, condition) {
      const fullVec = await embedImageBuffer(queryBuf)
      const artVec = await embedImageBuffer(await artCrop(queryBuf))

      const restrictedRows = searchWithin(groupCards, fullVec, artVec, fullVectors, artVectors)
      record(restrictedTallies[condition], evalRepresentations(restrictedRows, trueId))

      const fullRows = searchWithin(allCardIds, fullVec, artVec, fullVectors, artVectors)
      record(fullCorpusTallies[condition], evalRepresentations(fullRows, trueId))
    }

    const geomBuf = await applyNamedProfile('perspective-rotate', buf, trueId)
    await evalCondition(geomBuf, 'geometryOnly')

    const iphoneBuf = await composeContinuous(buf, trueId, IPHONE_LIKE_LEVELS)
    await evalCondition(iphoneBuf, 'iphoneLikeModerate')

    const hardQueries = await hardAugmentAll(buf, trueId, ['tilted-glare-shadow-blur'])
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      await evalCondition(cropped, 'hardGlareShadowBlur')
    }

    done += 1
    if (done % 25 === 0) console.log(`[art-crop] progress ${done}/${sample.length}`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    confusableGroupedCorpusSize: groupedRows.length,
    corpusSize: rows.length,
    representations: ['full', 'artCrop', 'dualAverage', 'dualMax', 'rankFusion'],
    confusableRestrictedPool: Object.fromEntries(
      Object.entries(restrictedTallies).map(([c, t]) => [c, summarize(t)]),
    ),
    fullCorpus: Object.fromEntries(
      Object.entries(fullCorpusTallies).map(([c, t]) => [c, summarize(t)]),
    ),
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '11-distorted-art-crop-confusable.json'),
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
