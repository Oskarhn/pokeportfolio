// Experiment 07 (§28): does an art-crop (central artwork only, borders/text removed) auxiliary
// representation help distinguish same-Pokemon-different-printing confusable siblings specifically
// — a different question from P84's already-negative "does an inset crop rescue hard-defect
// queries" (D-101 §3). This restricts the candidate pool to each sampled card's OWN confusable
// group (its real same-name siblings from other sets/reprints — see retrieval/confusable-groups.mjs)
// under CLEAN query conditions, and compares full-card-only, art-crop-only, and an averaged dual
// score at telling the true printing apart from its own siblings.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex } from '../retrieval/build-index.mjs'
import { buildConfusableGroups } from '../retrieval/confusable-groups.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { artCrop } from '../quality/art-crop.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

function stratifiedSample(arr, n, seedStr) {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % arr.length
  const stride = Math.max(1, Math.floor(arr.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < arr.length; i += 1)
    out.push(arr[(offset + i * stride) % arr.length])
  return out
}

async function main() {
  const sampleN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 300)
  const { rows, vectors: fullCardVectors } = await buildReferenceIndex()
  const groups = buildConfusableGroups(rows)
  await warmUpModel()

  const rowById = new Map(rows.map((r) => [r.cardId, r]))
  const eligibleGroups = [...groups.entries()].filter(
    ([, ids]) => ids.length >= 2 && ids.length <= 8,
  )
  const sampledGroups = stratifiedSample(
    eligibleGroups,
    Math.min(sampleN, eligibleGroups.length),
    'p91-art-crop',
  )
  console.log(
    `[art-crop] evaluating ${sampledGroups.length} of ${eligibleGroups.length} eligible confusable groups`,
  )

  const artCropCache = new Map() // cardId -> Float32Array

  async function getArtCropVec(cardId) {
    if (artCropCache.has(cardId)) return artCropCache.get(cardId)
    const row = rowById.get(cardId)
    const buf = await readFile(row.imagePath)
    const cropped = await artCrop(buf)
    const vec = await embedImageBuffer(cropped)
    artCropCache.set(cardId, vec)
    return vec
  }

  const tallies = {
    fullCardOnly: { top1: 0, total: 0 },
    artCropOnly: { top1: 0, total: 0 },
    dualAverage: { top1: 0, total: 0 },
    dualMax: { top1: 0, total: 0 },
  }

  let done = 0
  for (const [, memberIds] of sampledGroups) {
    // Pre-fetch art-crop vectors for every member (cached across groups sharing cards).
    const artVecs = new Map()
    for (const id of memberIds) artVecs.set(id, await getArtCropVec(id))

    for (const trueId of memberIds) {
      const trueFullVec = fullCardVectors.get(trueId)
      const trueArtVec = artVecs.get(trueId)

      function rankAmongPeers(scoreFn) {
        const scored = memberIds.map((id) => ({ id, score: scoreFn(id) }))
        scored.sort((a, b) => b.score - a.score)
        return scored[0].id === trueId
      }

      const fullOk = rankAmongPeers((id) => dot(fullCardVectors.get(id), trueFullVec))
      const artOk = rankAmongPeers((id) => dot(artVecs.get(id), trueArtVec))
      const dualAvgOk = rankAmongPeers(
        (id) => (dot(fullCardVectors.get(id), trueFullVec) + dot(artVecs.get(id), trueArtVec)) / 2,
      )
      const dualMaxOk = rankAmongPeers((id) =>
        Math.max(dot(fullCardVectors.get(id), trueFullVec), dot(artVecs.get(id), trueArtVec)),
      )

      tallies.fullCardOnly.total += 1
      tallies.fullCardOnly.top1 += fullOk ? 1 : 0
      tallies.artCropOnly.total += 1
      tallies.artCropOnly.top1 += artOk ? 1 : 0
      tallies.dualAverage.total += 1
      tallies.dualAverage.top1 += dualAvgOk ? 1 : 0
      tallies.dualMax.total += 1
      tallies.dualMax.top1 += dualMaxOk ? 1 : 0
    }

    done += 1
    if (done % 50 === 0) console.log(`[art-crop] progress ${done}/${sampledGroups.length} groups`)
  }

  const summary = Object.fromEntries(
    Object.entries(tallies).map(([k, t]) => [
      k,
      { n: t.total, top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)) },
    ]),
  )

  const report = {
    generatedAt: new Date().toISOString(),
    groupsEvaluated: sampledGroups.length,
    totalQueries: tallies.fullCardOnly.total,
    note: "CLEAN query conditions only, candidate pool restricted to each true card's own confusable-group siblings (self-vs-siblings ranking, not full-corpus retrieval)",
    results: summary,
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '07-art-crop-confusable.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
