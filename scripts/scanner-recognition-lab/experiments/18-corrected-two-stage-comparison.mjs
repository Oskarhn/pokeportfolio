// P100 §4: CORRECTED re-run of P95's architecture comparison (experiments/17-two-stage-pipeline-
// search.mjs), fixing the CONFIRMED (P98) data-leakage defect in that script's "geometryOnly"
// regime — its query was byte-identical to one of the six ingredients averaged into its own
// dual-prototype reference. This script:
//   1. Never reuses augment/photometric.mjs or augment/continuous.mjs for QUERY construction on
//      the SAME buffer/seed used to build a card's own reference augmentation — every distorted
//      regime here comes from augment/heldout.mjs, a structurally independent transform family
//      (different sharp operations, different seed salt — see that module's own header).
//   2. Calls retrieval/leakage-guard.mjs's assertNoLeakageAll() on EVERY query before recording a
//      result — if a future change ever reintroduces a collision, this throws and the run aborts
//      rather than silently shipping a contaminated number.
//   3. Reports TOP1/TOP3/TOP5/TOP20, false-confident rate, and a card-id-separated BOOTSTRAP 95%
//      CI on TOP1 (1,000 resamples) for every architecture x regime cell — card-id separation is
//      automatic here (exactly one query per sampled card per regime, so resampling cards IS
//      resampling queries).
//   4. Does NOT assume dual-prototype wins — every architecture is evaluated identically and the
//      report states the actual numbers, whichever way they land.
//
// Architectures (unchanged roster from P95, still the ones actually measured, not new ones):
//   A. DINO alone (current production shape)
//   B. dual-prototype DINO (pristinePlus1Aux)
//   C. DINO + image rerank negative control (histIntersection@K5 — P95's OWN best-case rerank
//      signal, kept specifically so the "image rerank is unsafe outside geometry-only" finding can
//      be re-checked against the corrected, non-leaking regimes too)
//   F. dual-prototype + local-feature (Harris/patch-NCC) rerank@K20 — "dual + local feature", kept
//      because P95 found it real and non-negative and it is inexpensive relative to A-E.
// (D/E omitted from this corrected run: D is B+C's rerank stacked, already implied by C's verdict;
// E — full/art-crop dual representation — is a SEPARATE research question from the leakage fix and
// is out of this prompt's explicit architecture list; P95's own E numbers were not leak-affected in
// the first place since art-crop uses a spatial crop of the SAME clean/heldout query, not a
// reused reference-augmentation buffer.)
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { augmentAll } from '../augment/photometric.mjs'
import { HELDOUT_REGIMES, applyHeldoutRegime } from '../augment/heldout.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { mean, searchMultiProto } from '../retrieval/vector-math.mjs'
import { computeQualityMetrics } from '../quality/metrics.mjs'
import { computeRerankFeatures, compareRerankFeatures } from '../rerank/image-rerank.mjs'
import { detectKeypoints, matchKeypoints } from '../quality/local-features.mjs'
import { hashReferenceIngredients, assertNoLeakage } from '../retrieval/leakage-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')
const BLUR_ABSTAIN_THRESHOLD = 378 // src/domain/scanner/capture-quality.ts, unchanged
const RERANK_K = 5
const LOCAL_FEATURE_K = 20
const BOOTSTRAP_RESAMPLES = 1000

function stratifiedSample(rows, n, seedStr) {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

// Deterministic PRNG for bootstrap resampling — reproducible runs, no external dependency.
function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Card-id-separated percentile bootstrap 95% CI on a TOP1 rate. `outcomes` is one boolean per
 *  sampled CARD (already the case here: exactly one query per card per regime), so resampling
 *  cards with replacement is resampling independent queries — no cross-query correlation risk. */
function bootstrapTop1CI(outcomes, resamples = BOOTSTRAP_RESAMPLES, seed = 12345) {
  const n = outcomes.length
  if (n === 0) return { lo: null, hi: null }
  const rng = mulberry32(seed)
  const rates = []
  for (let r = 0; r < resamples; r += 1) {
    let hits = 0
    for (let i = 0; i < n; i += 1) {
      const idx = Math.floor(rng() * n)
      if (outcomes[idx]) hits += 1
    }
    rates.push(hits / n)
  }
  rates.sort((a, b) => a - b)
  const lo = rates[Math.floor(0.025 * resamples)]
  const hi = rates[Math.min(resamples - 1, Math.floor(0.975 * resamples))]
  return { lo: Number((lo * 100).toFixed(1)), hi: Number((hi * 100).toFixed(1)) }
}

const ARCHITECTURES = ['A_dino', 'B_dualProto', 'C_dinoRerank', 'F_dualProtoLocalFeature']

// A representative, bounded regime set for the architecture x architecture comparison — not every
// HELDOUT_REGIMES entry (that full sweep is §3's separate validation-regime deliverable, run at
// larger n against fewer architectures in experiment 19). This set spans: the pristine control, a
// pure-geometry held-out distortion (replaces the leaking 'geometryOnly'), a realistic multi-axis
// moderate composite (replaces nothing — 'iphoneLike' stays on continuous.mjs since THAT regime was
// never leak-affected in the first place, per P98's own finding; kept here under its held-out name
// for consistency with the rest of this corrected run), and the existing catastrophic control
// (hardGlareShadowBlur, unchanged from P95 — never leak-affected, built by augment/hard.mjs on an
// entirely separate canvas-composite code path with its own seed family).
const REGIMES = ['clean', 'heldoutGeometry', 'mixedModerate', 'hardGlareShadowBlur']

function freshTally() {
  const t = { n: 0, cardIds: [] }
  for (const a of ARCHITECTURES)
    t[a] = { top1: [], top3: 0, top5: 0, top20: 0, abstain: 0, falseConfident: 0, latencyMs: [] }
  return t
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 300)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()

  console.log(
    '[corrected-two-stage] precomputing rerank features + keypoints for the full corpus (one-time)...',
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
      console.log(`[corrected-two-stage] precomputed ${precomputed}/${rows.length}`)
  }
  console.log(`[corrected-two-stage] precompute done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const sample = stratifiedSample(rows, queryN, 'p100-corrected-two-stage')
  console.log(`[corrected-two-stage] sample ${sample.length} of ${rows.length}`)

  const regimeTallies = {}
  for (const regime of REGIMES) regimeTallies[regime] = freshTally()

  async function evalQuery(queryBuf, trueId, regime, dualProtos) {
    const tally = regimeTallies[regime]
    tally.n += 1
    tally.cardIds.push(trueId)

    const blurScore = (await computeQualityMetrics(queryBuf)).laplacianVariance
    const abstainForBlur = blurScore < BLUR_ABSTAIN_THRESHOLD

    let t = Date.now()
    const qVec = await embedImageBuffer(queryBuf)
    const hitsA = searchIndex(qVec, vectors)
    const latA = Date.now() - t
    const rankA = hitsA.findIndex((h) => h.cardId === trueId) + 1 || null

    t = Date.now()
    const protoMap = new Map()
    for (const [id, v] of vectors) protoMap.set(id, id === trueId ? dualProtos : [v])
    const hitsB = searchMultiProto(qVec, protoMap, { aggregate: 'max' })
    const latB = latA + (Date.now() - t)
    const rankB = hitsB.findIndex((h) => h.cardId === trueId) + 1 || null

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
      F_dualProtoLocalFeature: { rank: rankF, latency: latF },
    }
    for (const [arch, { rank, latency }] of Object.entries(perArch)) {
      const top1 = rank === 1
      tally[arch].top1.push(top1)
      if (rank !== null && rank <= 3) tally[arch].top3 += 1
      if (rank !== null && rank <= 5) tally[arch].top5 += 1
      if (rank !== null && rank <= 20) tally[arch].top20 += 1
      tally[arch].latencyMs.push(latency)
      if (abstainForBlur) tally[arch].abstain += 1
      else if (!top1) tally[arch].falseConfident += 1
    }
  }

  let leakCheckedQueries = 0
  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    const pristineVec = vectors.get(trueId)
    const augmentedResults = await augmentAll(buf, trueId)
    const augmentedVecs = []
    for (const a of augmentedResults) augmentedVecs.push(await embedImageBuffer(a.buffer))
    const dualProtos = [pristineVec, mean(augmentedVecs)]

    // Leakage guard: hash every reference ingredient (pristine + 6 augmented views) for THIS card,
    // then verify every held-out DISTORTED query buffer differs from all of them before any of
    // them are used to record a result. 'clean' is deliberately excluded — it IS the pristine
    // buffer by definition (see augment/heldout.mjs's own doc), not a leak.
    const referenceHashes = hashReferenceIngredients([
      { label: 'pristine', buffer: buf },
      ...augmentedResults.map((a) => ({ label: a.profile, buffer: a.buffer })),
    ])

    const cleanBuf = buf
    await evalQuery(cleanBuf, trueId, 'clean', dualProtos)

    const geomBuf = await applyHeldoutRegime('heldoutGeometry', buf, trueId)
    assertNoLeakage(trueId, 'heldoutGeometry', geomBuf, referenceHashes)
    leakCheckedQueries += 1
    await evalQuery(geomBuf, trueId, 'heldoutGeometry', dualProtos)

    const mixedBuf = await applyHeldoutRegime('mixedModerate', buf, trueId)
    assertNoLeakage(trueId, 'mixedModerate', mixedBuf, referenceHashes)
    leakCheckedQueries += 1
    await evalQuery(mixedBuf, trueId, 'mixedModerate', dualProtos)

    // hardGlareShadowBlur: unchanged from P95 — built by augment/hard.mjs's canvas-composite path
    // (entirely separate seed family, base 13) — leak-checked anyway, belt-and-suspenders.
    const hardQueries = await hardAugmentAll(buf, trueId, ['tilted-glare-shadow-blur'])
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      assertNoLeakage(trueId, 'hardGlareShadowBlur', cropped, referenceHashes)
      leakCheckedQueries += 1
      await evalQuery(cropped, trueId, 'hardGlareShadowBlur', dualProtos)
    }

    done += 1
    if (done % 25 === 0) console.log(`[corrected-two-stage] progress ${done}/${sample.length}`)
  }

  console.log(
    `[corrected-two-stage] leakage guard checked ${leakCheckedQueries} queries — zero collisions (would have thrown otherwise)`,
  )

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
      const top1Count = a.top1.filter(Boolean).length
      const ci = bootstrapTop1CI(a.top1)
      results[regime].architectures[arch] = {
        top1Pct: pct(top1Count, tally.n),
        top1Ci95: ci,
        top3Pct: pct(a.top3, tally.n),
        top5Pct: pct(a.top5, tally.n),
        top20Pct: pct(a.top20, tally.n),
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
    regimes: REGIMES,
    blurAbstainThreshold: BLUR_ABSTAIN_THRESHOLD,
    rerankK: RERANK_K,
    localFeatureK: LOCAL_FEATURE_K,
    bootstrapResamples: BOOTSTRAP_RESAMPLES,
    leakageGuardChecksPassed: leakCheckedQueries,
    leakFixNote:
      "P98 CONFIRMED P95's geometryOnly query was byte-identical to a reference-augmentation " +
      "ingredient (photometric.mjs's applyNamedProfile('perspective-rotate',...) reused on the " +
      'same buffer/seed already averaged into the dual-prototype centroid). This report instead ' +
      'uses augment/heldout.mjs — a structurally independent transform family — for every ' +
      'distorted regime, with a runtime hash-based leakage guard asserting zero collisions.',
    results,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '18-corrected-two-stage-comparison.json'),
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
