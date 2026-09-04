// P95 §11: compares the seven architectures the prompt names, using ONLY mechanisms this session
// (or P91) actually measured — no new untested component is introduced here:
//   A. current DINO (pristine single-prototype reference, shipped production shape)
//   B. dual-prototype DINO (pristinePlus1Aux, P91's strongest reference-augmentation strategy)
//   C. DINO + image rerank (histIntersection @ K=5 — experiment 10's only signal/K combination
//      that was ever net-positive, on geometryOnly/confusable specifically)
//   D. dual-prototype + image rerank (same rerank signal on top of B)
//   E. DINO + full/art-crop dual representation (dualMax, experiment 11's best full-corpus
//      representation in the moderate regime)
//   F. multi-prototype + LOCAL-FEATURE rerank (dual-proto DINO shortlist reranked by experiment
//      15's Harris+patch-NCC matcher — the session's actual best-performing rerank mechanism)
//   G. each of A-F + the shipped severe-blur abstention gate (src/domain/scanner/capture-
//      quality.ts's BLUR_ABSTAIN_THRESHOLD=378 on laplacianVariance, reproduced here in JS since
//      this lab's scripts are plain Node, not the TS domain layer — same formula/threshold/
//      resolution, not a new gate)
// Reported per architecture: TOP1, TOP5, false-confident-result-rate (a WRONG, non-abstained
// TOP1), abstention rate, and mean per-query latency.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { buildArtCropIndex } from '../retrieval/build-art-crop-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { applyNamedProfile, augmentAll } from '../augment/photometric.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { composeContinuous, IPHONE_LIKE_LEVELS } from '../augment/continuous.mjs'
import { mean, searchMultiProto } from '../retrieval/vector-math.mjs'
import { artCrop } from '../quality/art-crop.mjs'
import { computeQualityMetrics } from '../quality/metrics.mjs'
import { computeRerankFeatures, compareRerankFeatures } from '../rerank/image-rerank.mjs'
import { detectKeypoints, matchKeypoints } from '../quality/local-features.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')
const BLUR_ABSTAIN_THRESHOLD = 378 // src/domain/scanner/capture-quality.ts, unchanged
const RERANK_K = 5
const LOCAL_FEATURE_K = 20

function stratifiedSample(rows, n, seedStr) {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

const ARCHITECTURES = [
  'A_dino',
  'B_dualProto',
  'C_dinoRerank',
  'D_dualProtoRerank',
  'E_dualRepresentation',
  'F_dualProtoLocalFeature',
]

function freshTally() {
  const t = { n: 0, top1: 0, top5: 0 }
  for (const a of ARCHITECTURES)
    t[a] = { top1: 0, top5: 0, abstain: 0, falseConfident: 0, latencyMs: [] }
  return t
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 150)
  const { rows, vectors } = await buildReferenceIndex()
  const { vectors: artVectors } = await buildArtCropIndex()
  await warmUpModel()

  console.log(
    '[two-stage] precomputing rerank features + keypoints for the full corpus (one-time)...',
  )
  const t0 = Date.now()
  const refRerankFeatures = new Map()
  const refKeypoints = new Map()
  let precomputed = 0
  for (const row of rows) {
    const buf = await readFile(row.imagePath)
    refRerankFeatures.set(row.cardId, await computeRerankFeatures(buf))
    refKeypoints.set(row.cardId, await detectKeypoints(buf))
    precomputed += 1
    if (precomputed % 1000 === 0)
      console.log(`[two-stage] precomputed ${precomputed}/${rows.length}`)
  }
  console.log(`[two-stage] precompute done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const sample = stratifiedSample(rows, queryN, 'p95-two-stage')
  console.log(`[two-stage] sample ${sample.length} of ${rows.length}`)

  const regimeTallies = {
    clean: freshTally(),
    geometryOnly: freshTally(),
    iphoneLike: freshTally(),
    hardGlareShadowBlur: freshTally(),
  }

  async function evalQuery(queryBuf, trueId, regime, dualProtos) {
    const tally = regimeTallies[regime]
    tally.n += 1

    const blurScore = (await computeQualityMetrics(queryBuf)).laplacianVariance
    const abstainForBlur = blurScore < BLUR_ABSTAIN_THRESHOLD

    // A: plain DINO
    let t = Date.now()
    const qVec = await embedImageBuffer(queryBuf)
    const hitsA = searchIndex(qVec, vectors)
    const latA = Date.now() - t
    const rankA = hitsA.findIndex((h) => h.cardId === trueId) + 1 || null

    // B: dual-prototype (this card's own row upgraded)
    t = Date.now()
    const protoMap = new Map()
    for (const [id, v] of vectors) protoMap.set(id, id === trueId ? dualProtos : [v])
    const hitsB = searchMultiProto(qVec, protoMap, { aggregate: 'max' })
    const latB = latA + (Date.now() - t)
    const rankB = hitsB.findIndex((h) => h.cardId === trueId) + 1 || null

    // C: A + histIntersection rerank @ K=5
    t = Date.now()
    const qRerankFeat = await computeRerankFeatures(queryBuf)
    const topKA = hitsA.slice(0, RERANK_K)
    let bestC = null,
      bestCScore = -Infinity
    for (const h of topKA) {
      const score = compareRerankFeatures(
        qRerankFeat,
        refRerankFeatures.get(h.cardId),
      ).histIntersection
      if (score > bestCScore) {
        bestCScore = score
        bestC = h.cardId
      }
    }
    const latC = latA + (Date.now() - t)
    const rankC = bestC === trueId ? 1 : null

    // D: B + histIntersection rerank @ K=5
    t = Date.now()
    const topKB = hitsB.slice(0, RERANK_K)
    let bestD = null,
      bestDScore = -Infinity
    for (const h of topKB) {
      const score = compareRerankFeatures(
        qRerankFeat,
        refRerankFeatures.get(h.cardId),
      ).histIntersection
      if (score > bestDScore) {
        bestDScore = score
        bestD = h.cardId
      }
    }
    const latD = latB + (Date.now() - t)
    const rankD = bestD === trueId ? 1 : null

    // E: DINO + full/art-crop dualMax representation, full corpus
    t = Date.now()
    const artQVec = await embedImageBuffer(await artCrop(queryBuf))
    const hitsE = [...vectors.keys()]
      .map((id) => ({
        cardId: id,
        similarity: Math.max(dot(qVec, vectors.get(id)), dot(artQVec, artVectors.get(id))),
      }))
      .sort((a, b) => b.similarity - a.similarity)
    const latE = Date.now() - t
    const rankE = hitsE.findIndex((h) => h.cardId === trueId) + 1 || null

    // F: dual-proto shortlist + local-feature (Harris/patch-NCC) rerank @ K=20
    t = Date.now()
    const topKF = hitsB.slice(0, LOCAL_FEATURE_K)
    const queryKeypoints = await detectKeypoints(queryBuf)
    let bestF = null,
      bestFScore = -1
    for (const h of topKF) {
      const { goodMatchCount } = matchKeypoints(queryKeypoints, refKeypoints.get(h.cardId))
      if (goodMatchCount > bestFScore) {
        bestFScore = goodMatchCount
        bestF = h.cardId
      }
    }
    const latF = latB + (Date.now() - t)
    const rankF = bestF === trueId ? 1 : null

    const perArch = {
      A_dino: { rank: rankA, latency: latA },
      B_dualProto: { rank: rankB, latency: latB },
      C_dinoRerank: { rank: rankC, latency: latC },
      D_dualProtoRerank: { rank: rankD, latency: latD },
      E_dualRepresentation: { rank: rankE, latency: latE },
      F_dualProtoLocalFeature: { rank: rankF, latency: latF },
    }

    for (const [arch, { rank, latency }] of Object.entries(perArch)) {
      const top1 = rank === 1
      const top5 = rank !== null && rank <= 5
      if (top1) tally[arch].top1 += 1
      if (top5) tally[arch].top5 += 1
      tally[arch].latencyMs.push(latency)
      if (abstainForBlur) {
        tally[arch].abstain += 1
      } else if (!top1) {
        tally[arch].falseConfident += 1
      }
    }
  }

  function dot(a, b) {
    let s = 0
    for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
    return s
  }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    const pristineVec = vectors.get(trueId)
    const augmentedResults = await augmentAll(buf, trueId)
    const augmentedVecs = []
    for (const a of augmentedResults) augmentedVecs.push(await embedImageBuffer(a.buffer))
    const dualProtos = [pristineVec, mean(augmentedVecs)]

    await evalQuery(buf, trueId, 'clean', dualProtos)

    const geomBuf = await applyNamedProfile('perspective-rotate', buf, trueId)
    await evalQuery(geomBuf, trueId, 'geometryOnly', dualProtos)

    const iphoneBuf = await composeContinuous(buf, trueId, IPHONE_LIKE_LEVELS)
    await evalQuery(iphoneBuf, trueId, 'iphoneLike', dualProtos)

    const hardQueries = await hardAugmentAll(buf, trueId, ['tilted-glare-shadow-blur'])
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      await evalQuery(cropped, trueId, 'hardGlareShadowBlur', dualProtos)
    }

    done += 1
    if (done % 25 === 0) console.log(`[two-stage] progress ${done}/${sample.length}`)
  }

  function pct(num, den) {
    return den > 0 ? Number(((100 * num) / den).toFixed(1)) : null
  }
  function meanArr(arr) {
    return arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null
  }

  const results = {}
  for (const [regime, tally] of Object.entries(regimeTallies)) {
    results[regime] = { n: tally.n, architectures: {} }
    for (const arch of ARCHITECTURES) {
      const a = tally[arch]
      results[regime].architectures[arch] = {
        top1Pct: pct(a.top1, tally.n),
        top5Pct: pct(a.top5, tally.n),
        abstentionRatePct: pct(a.abstain, tally.n),
        falseConfidentRatePct: pct(a.falseConfident, tally.n),
        meanLatencyMs: meanArr(a.latencyMs),
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    corpusSize: rows.length,
    architectures: ARCHITECTURES,
    blurAbstainThreshold: BLUR_ABSTAIN_THRESHOLD,
    rerankK: RERANK_K,
    localFeatureK: LOCAL_FEATURE_K,
    results,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '17-two-stage-pipeline-search.json'),
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
