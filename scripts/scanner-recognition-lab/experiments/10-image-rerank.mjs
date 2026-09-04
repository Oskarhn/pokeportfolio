// P95 §5/§8: the FIRST real experiment to actually exercise P91's built-but-never-run
// rerank/image-rerank.mjs. Two-stage pipeline: DINO embed+search -> top-K shortlist -> rerank the
// shortlist against each candidate's own reference image using six dependency-free signals (P91's
// three — NCC/SSIM-lite/histogram-intersection — plus P95's three additions — edge-NCC, edge-SSIM,
// color moments). Reference-side rerank features are precomputed ONCE for the whole ~4,300-card
// corpus (a few minutes) so the per-query cost of testing K=5..100 stays small. If the true card is
// not in the DINO top-K at all, no reranker can recover it — that is reported explicitly per
// regime/K, not silently absorbed into a lower rerank accuracy number.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { applyNamedProfile } from '../augment/photometric.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { composeContinuous, IPHONE_LIKE_LEVELS } from '../augment/continuous.mjs'
import { buildConfusableGroups } from '../retrieval/confusable-groups.mjs'
import {
  computeExtendedRerankFeatures,
  compareExtendedRerankFeatures,
} from '../rerank/image-rerank.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', '.cache')
const REPORT_OUT = join(here, '..', 'reports')

const K_VALUES = [5, 10, 20, 50, 100]
const SIGNALS = ['ncc', 'ssim', 'histIntersection', 'edgeNcc', 'edgeSsim', 'colorMoments']

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
  const t = { n: 0, trueInK: {}, rerankTop1: {} }
  for (const k of K_VALUES) {
    t.trueInK[k] = 0
    t.rerankTop1[k] = {}
    for (const s of SIGNALS) t.rerankTop1[k][s] = 0
  }
  t.dinoTop1 = 0
  return t
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 150)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()

  console.log('[rerank] precomputing extended rerank features for the full corpus (one-time)...')
  const t0 = Date.now()
  const refFeatures = new Map()
  let precomputed = 0
  for (const row of rows) {
    const buf = await readFile(row.imagePath)
    refFeatures.set(row.cardId, await computeExtendedRerankFeatures(buf))
    precomputed += 1
    if (precomputed % 1000 === 0) console.log(`[rerank] precomputed ${precomputed}/${rows.length}`)
  }
  console.log(`[rerank] precompute done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const groups = buildConfusableGroups(rows)
  const cardToGroupCards = new Map()
  for (const [, cardIds] of groups) for (const id of cardIds) cardToGroupCards.set(id, cardIds)

  const sample = stratifiedSample(rows, queryN, 'p95-image-rerank')
  console.log(`[rerank] sample ${sample.length} of ${rows.length}`)

  const regimeTallies = {
    clean: freshTally(),
    geometryOnly: freshTally(),
    iphoneLike: freshTally(),
    hardGlareShadowBlur: freshTally(),
    hardShadowNoise: freshTally(),
    confusableGeometryOnly: freshTally(),
  }
  const latencies = { dinoOnlyMs: [], twoStageMs: {} }
  for (const k of K_VALUES) latencies.twoStageMs[k] = []

  async function evalQuery(queryBuf, trueId, regime) {
    const tDino0 = Date.now()
    const qVec = await embedImageBuffer(queryBuf)
    const hits = searchIndex(qVec, vectors)
    const tDino1 = Date.now()
    latencies.dinoOnlyMs.push(tDino1 - tDino0)

    const tally = regimeTallies[regime]
    tally.n += 1
    if (hits[0]?.cardId === trueId) tally.dinoTop1 += 1

    const qFeat = await computeExtendedRerankFeatures(queryBuf)
    const maxK = Math.max(...K_VALUES)
    const shortlist = hits.slice(0, maxK)

    for (const k of K_VALUES) {
      const tK0 = Date.now()
      const topK = shortlist.slice(0, k)
      if (topK.some((h) => h.cardId === trueId)) tally.trueInK[k] += 1

      for (const signal of SIGNALS) {
        let bestCard = null
        let bestScore = -Infinity
        for (const h of topK) {
          const cFeat = refFeatures.get(h.cardId)
          const cmp = compareExtendedRerankFeatures(qFeat, cFeat)
          if (cmp[signal] > bestScore) {
            bestScore = cmp[signal]
            bestCard = h.cardId
          }
        }
        if (bestCard === trueId) tally.rerankTop1[k][signal] += 1
      }
      const tK1 = Date.now()
      latencies.twoStageMs[k].push(tDino1 - tDino0 + (tK1 - tK0))
    }
  }

  async function evalConfusableRestricted(queryBuf, trueId) {
    const groupCards = cardToGroupCards.get(trueId)
    if (!groupCards || groupCards.length < 2) return
    const restrictedVectors = new Map()
    for (const id of groupCards) restrictedVectors.set(id, vectors.get(id))
    const qVec = await embedImageBuffer(queryBuf)
    const hits = searchIndex(qVec, restrictedVectors)
    const tally = regimeTallies.confusableGeometryOnly
    tally.n += 1
    if (hits[0]?.cardId === trueId) tally.dinoTop1 += 1
    const qFeat = await computeExtendedRerankFeatures(queryBuf)
    for (const k of K_VALUES) {
      const topK = hits.slice(0, Math.min(k, hits.length))
      if (topK.some((h) => h.cardId === trueId)) tally.trueInK[k] += 1
      for (const signal of SIGNALS) {
        let bestCard = null
        let bestScore = -Infinity
        for (const h of topK) {
          const cFeat = refFeatures.get(h.cardId)
          const cmp = compareExtendedRerankFeatures(qFeat, cFeat)
          if (cmp[signal] > bestScore) {
            bestScore = cmp[signal]
            bestCard = h.cardId
          }
        }
        if (bestCard === trueId) tally.rerankTop1[k][signal] += 1
      }
    }
  }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    await evalQuery(buf, trueId, 'clean')

    const geomBuf = await applyNamedProfile('perspective-rotate', buf, trueId)
    await evalQuery(geomBuf, trueId, 'geometryOnly')
    await evalConfusableRestricted(geomBuf, trueId)

    const iphoneBuf = await composeContinuous(buf, trueId, IPHONE_LIKE_LEVELS)
    await evalQuery(iphoneBuf, trueId, 'iphoneLike')

    const hardQueries = await hardAugmentAll(buf, trueId)
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      const key =
        hq.profile === 'tilted-glare-shadow-blur'
          ? 'hardGlareShadowBlur'
          : hq.profile === 'skewed-partial-shadow-noisy'
            ? 'hardShadowNoise'
            : null
      if (key) await evalQuery(cropped, trueId, key)
    }

    done += 1
    if (done % 25 === 0) console.log(`[rerank] progress ${done}/${sample.length}`)
  }

  function pct(num, den) {
    return den > 0 ? Number(((100 * num) / den).toFixed(1)) : null
  }
  function meanArr(arr) {
    return arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null
  }

  const results = {}
  for (const [regime, tally] of Object.entries(regimeTallies)) {
    if (tally.n === 0) continue
    const perK = {}
    for (const k of K_VALUES) {
      const trueInKPct = pct(tally.trueInK[k], tally.n)
      const bySignal = {}
      for (const s of SIGNALS) {
        bySignal[s] = {
          rerankTop1Pct: pct(tally.rerankTop1[k][s], tally.n),
          deltaFromDinoPct:
            pct(tally.rerankTop1[k][s], tally.n) !== null && pct(tally.dinoTop1, tally.n) !== null
              ? Number(
                  (pct(tally.rerankTop1[k][s], tally.n) - pct(tally.dinoTop1, tally.n)).toFixed(1),
                )
              : null,
        }
      }
      perK[k] = { trueInKPct, bySignal }
    }
    results[regime] = { n: tally.n, dinoTop1Pct: pct(tally.dinoTop1, tally.n), perK }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    corpusSize: rows.length,
    kValues: K_VALUES,
    signals: SIGNALS,
    results,
    latency: {
      dinoOnlyMeanMs: meanArr(latencies.dinoOnlyMs),
      twoStageMeanMsByK: Object.fromEntries(
        K_VALUES.map((k) => [k, meanArr(latencies.twoStageMs[k])]),
      ),
      note: 'Server-side Node/CPU latency for this lab, NOT an iPhone/browser measurement — relative deltas (K=5 vs K=100) are the meaningful signal here, not absolute ms.',
    },
  }
  await mkdir(REPORT_OUT, { recursive: true })
  await writeFile(join(REPORT_OUT, '10-image-rerank.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
