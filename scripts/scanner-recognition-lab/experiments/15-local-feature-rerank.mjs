// P95 §7: MEASURES the lightweight local-feature rerank approach P84/P91 both reasoned away
// without benchmarking. Harris-corner + patch-NCC keypoint matching (quality/local-features.mjs),
// applied ONLY on top of a DINO shortlist (K=20, matching the prompt's "pipeline only on top K"),
// across the four regimes the prompt names explicitly: good geometry, blur, glare, and same-name/
// confusable. If this is useless, that closes the question with data — matching P91's own
// discipline of treating a decisive negative as a real, valuable result.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { applyNamedProfile } from '../augment/photometric.mjs'
import { buildConfusableGroups } from '../retrieval/confusable-groups.mjs'
import { detectKeypoints, matchKeypoints } from '../quality/local-features.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')
const K = 20

function stratifiedSample(rows, n, seedStr) {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

function freshTally() {
  return { n: 0, dinoTop1: 0, localFeatureTop1: 0, trueInK: 0 }
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 150)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()

  console.log('[local-feature] precomputing Harris keypoints for the full corpus (one-time)...')
  const t0 = Date.now()
  const refKeypoints = new Map()
  let precomputed = 0
  for (const row of rows) {
    const buf = await readFile(row.imagePath)
    refKeypoints.set(row.cardId, await detectKeypoints(buf))
    precomputed += 1
    if (precomputed % 1000 === 0)
      console.log(`[local-feature] precomputed ${precomputed}/${rows.length}`)
  }
  console.log(`[local-feature] precompute done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const groups = buildConfusableGroups(rows)
  const cardToGroupCards = new Map()
  for (const [, cardIds] of groups) for (const id of cardIds) cardToGroupCards.set(id, cardIds)

  const sample = stratifiedSample(rows, queryN, 'p95-local-feature')
  console.log(`[local-feature] sample ${sample.length} of ${rows.length}`)

  const tallies = {
    goodGeometry: freshTally(),
    blur: freshTally(),
    glare: freshTally(),
    confusable: freshTally(),
  }

  async function evalQuery(queryBuf, trueId, regime, candidateVectors) {
    const qVec = await embedImageBuffer(queryBuf)
    const hits = searchIndex(qVec, candidateVectors)
    const tally = tallies[regime]
    tally.n += 1
    if (hits[0]?.cardId === trueId) tally.dinoTop1 += 1

    const topK = hits.slice(0, Math.min(K, hits.length))
    if (topK.some((h) => h.cardId === trueId)) tally.trueInK += 1

    const queryKeypoints = await detectKeypoints(queryBuf)
    let bestCard = null
    let bestScore = -1
    let bestNcc = -1
    for (const h of topK) {
      const candKeypoints = refKeypoints.get(h.cardId)
      const { goodMatchCount, meanGoodMatchNcc } = matchKeypoints(queryKeypoints, candKeypoints)
      if (
        goodMatchCount > bestScore ||
        (goodMatchCount === bestScore && meanGoodMatchNcc > bestNcc)
      ) {
        bestScore = goodMatchCount
        bestNcc = meanGoodMatchNcc
        bestCard = h.cardId
      }
    }
    if (bestCard === trueId) tally.localFeatureTop1 += 1
  }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    const geomBuf = await applyNamedProfile('perspective-rotate', buf, trueId)
    await evalQuery(geomBuf, trueId, 'goodGeometry', vectors)

    const blurBuf = await applyNamedProfile('blur-jpeg', buf, trueId)
    await evalQuery(blurBuf, trueId, 'blur', vectors)

    const glareBuf = await applyNamedProfile('glare-overlay', buf, trueId)
    await evalQuery(glareBuf, trueId, 'glare', vectors)

    const groupCards = cardToGroupCards.get(trueId)
    if (groupCards && groupCards.length >= 2) {
      const restrictedVectors = new Map()
      for (const id of groupCards) restrictedVectors.set(id, vectors.get(id))
      await evalQuery(geomBuf, trueId, 'confusable', restrictedVectors)
    }

    done += 1
    if (done % 25 === 0) console.log(`[local-feature] progress ${done}/${sample.length}`)
  }

  function pct(num, den) {
    return den > 0 ? Number(((100 * num) / den).toFixed(1)) : null
  }

  const results = {}
  for (const [regime, t] of Object.entries(tallies)) {
    if (t.n === 0) continue
    results[regime] = {
      n: t.n,
      kUsed: K,
      trueInKPct: pct(t.trueInK, t.n),
      dinoTop1Pct: pct(t.dinoTop1, t.n),
      localFeatureRerankTop1Pct: pct(t.localFeatureTop1, t.n),
      deltaPct:
        pct(t.localFeatureTop1, t.n) !== null && pct(t.dinoTop1, t.n) !== null
          ? Number((pct(t.localFeatureTop1, t.n) - pct(t.dinoTop1, t.n)).toFixed(1))
          : null,
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    corpusSize: rows.length,
    method:
      'Harris-corner + 11x11-patch-NCC keypoint matching, Lowe-ratio-style best/second-best test, dependency-free (quality/local-features.mjs)',
    kUsed: K,
    results,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '15-local-feature-rerank.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
