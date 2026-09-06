// P100 §3: the full ≥8-regime validation sweep the prompt requires (clean, held-out geometry,
// held-out mild perspective, held-out crop/translation, held-out blur, held-out exposure/white-
// balance, held-out glare, mixed moderate) — every regime from augment/heldout.mjs's
// HELDOUT_REGIMES, run against the two architectures the corrected benchmark (experiment 18) found
// to matter most: A (plain DINO) and B (dual-prototype). Cheaper than 18 (no rerank/keypoint
// precompute needed) so it can afford EVERY regime at a meaningful sample size, not just the four
// representative ones 18 uses for the full 4-architecture comparison.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { augmentAll } from '../augment/photometric.mjs'
import { HELDOUT_REGIMES, applyHeldoutRegime } from '../augment/heldout.mjs'
import { mean, searchMultiProto } from '../retrieval/vector-math.mjs'
import { hashReferenceIngredients, assertNoLeakage } from '../retrieval/leakage-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')
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

function bootstrapTop1CI(outcomes, resamples = BOOTSTRAP_RESAMPLES, seed = 54321) {
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
  return {
    lo: Number((rates[Math.floor(0.025 * resamples)] * 100).toFixed(1)),
    hi: Number((rates[Math.min(resamples - 1, Math.floor(0.975 * resamples))] * 100).toFixed(1)),
  }
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 250)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()

  const sample = stratifiedSample(rows, queryN, 'p100-heldout-sweep')
  console.log(
    `[heldout-sweep] sample ${sample.length} of ${rows.length}, ${HELDOUT_REGIMES.length} regimes`,
  )

  const tallies = {}
  for (const regime of HELDOUT_REGIMES) {
    tallies[regime] = { n: 0, dinoTop1: [], dualTop1: [], dinoTop5: 0, dualTop5: 0 }
  }

  let leakChecked = 0
  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    const pristineVec = vectors.get(trueId)
    const augmentedResults = await augmentAll(buf, trueId)
    const augmentedVecs = []
    for (const a of augmentedResults) augmentedVecs.push(await embedImageBuffer(a.buffer))
    const dualProtos = [pristineVec, mean(augmentedVecs)]

    const referenceHashes = hashReferenceIngredients([
      { label: 'pristine', buffer: buf },
      ...augmentedResults.map((a) => ({ label: a.profile, buffer: a.buffer })),
    ])

    for (const regime of HELDOUT_REGIMES) {
      const queryBuf = await applyHeldoutRegime(regime, buf, trueId)
      if (regime !== 'clean') {
        assertNoLeakage(trueId, regime, queryBuf, referenceHashes)
        leakChecked += 1
      }

      const qVec = await embedImageBuffer(queryBuf)
      const hitsA = searchIndex(qVec, vectors)
      const rankA = hitsA.findIndex((h) => h.cardId === trueId) + 1 || null

      const protoMap = new Map()
      for (const [id, v] of vectors) protoMap.set(id, id === trueId ? dualProtos : [v])
      const hitsB = searchMultiProto(qVec, protoMap, { aggregate: 'max' })
      const rankB = hitsB.findIndex((h) => h.cardId === trueId) + 1 || null

      const t = tallies[regime]
      t.n += 1
      t.dinoTop1.push(rankA === 1)
      t.dualTop1.push(rankB === 1)
      if (rankA !== null && rankA <= 5) t.dinoTop5 += 1
      if (rankB !== null && rankB <= 5) t.dualTop5 += 1
    }

    done += 1
    if (done % 25 === 0) console.log(`[heldout-sweep] progress ${done}/${sample.length}`)
  }

  console.log(
    `[heldout-sweep] leakage guard checked ${leakChecked} distorted queries — zero collisions`,
  )

  function pct(num, den) {
    return den > 0 ? Number(((100 * num) / den).toFixed(1)) : null
  }

  const results = {}
  for (const [regime, t] of Object.entries(tallies)) {
    const dinoTop1Count = t.dinoTop1.filter(Boolean).length
    const dualTop1Count = t.dualTop1.filter(Boolean).length
    results[regime] = {
      n: t.n,
      A_dino: {
        top1Pct: pct(dinoTop1Count, t.n),
        top1Ci95: bootstrapTop1CI(t.dinoTop1),
        top5Pct: pct(t.dinoTop5, t.n),
      },
      B_dualProto: {
        top1Pct: pct(dualTop1Count, t.n),
        top1Ci95: bootstrapTop1CI(t.dualTop1),
        top5Pct: pct(t.dualTop5, t.n),
      },
      dualMinusDinoTop1Pct: Number((pct(dualTop1Count, t.n) - pct(dinoTop1Count, t.n)).toFixed(1)),
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    corpusSize: rows.length,
    regimes: HELDOUT_REGIMES,
    bootstrapResamples: BOOTSTRAP_RESAMPLES,
    leakageGuardChecksPassed: leakChecked,
    results,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '19-full-heldout-regime-sweep.json'),
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
