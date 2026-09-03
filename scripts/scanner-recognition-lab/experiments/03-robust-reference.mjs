// Experiment 03 (§8-10): REFERENCE-side augmentation, the track P84 never tested (it only tried
// QUERY-side variants and found 0% rescue — D-101 §3/§4). For each sampled card, builds 7 candidate
// reference vectors (pristine + 6 deterministic photometric/geometric augmentations of the
// REFERENCE image itself), then compares several single- and multi-prototype aggregation
// strategies against the SAME baseline query construction as experiment 01.
//
// Scoping honestly disclosed: only the QUERY SAMPLE's own reference rows are upgraded to the
// robust strategy under test; every other card in the ~4,300-card index stays pristine-only. This
// tests "does upgrading THIS card's own reference help retrieve it correctly" without the
// ~38-minute cost of re-embedding 6 augmentations for the full corpus — it does NOT test whether
// upgrading every card's reference would also change which WRONG cards get pulled in as false
// positives (that would require the full-corpus upgrade; noted as a follow-up, not run here).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { augmentAll } from '../augment/photometric.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import {
  mean,
  trimmedMean,
  medoid,
  searchMultiProto,
  l2normalize,
} from '../retrieval/vector-math.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

function stratifiedSample(rows, n, seedStr = 'p91-robust-ref') {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

const STRATEGIES = [
  'pristineOnly',
  'centroidAll',
  'trimmedMeanAll',
  'medoidAll',
  'pristinePlus1Aux', // 2 prototypes: pristine + centroid-of-augmented
  'pristinePlus2Aux', // 3 prototypes: pristine + medoid-of-augmented + trimmedMean-of-augmented
  'pristinePlus4Aux', // 5 prototypes: pristine + 4 individually-chosen augmented views
  'maxSimAllProtos', // multi-proto max over all 7 raw vectors
  'avgTop2AllProtos', // multi-proto avg-of-top-2 over all 7 raw vectors
]

function freshTally() {
  return { top1: 0, top5: 0, total: 0, sims: [] }
}
function record(tally, hits, trueId) {
  tally.total += 1
  const rank = hits.findIndex((h) => h.cardId === trueId) + 1 || null
  if (rank && rank <= 1) tally.top1 += 1
  if (rank && rank <= 5) tally.top5 += 1
  tally.sims.push(hits.find((h) => h.cardId === trueId)?.similarity ?? -1)
}
function summarize(t) {
  const meanSim = t.sims.reduce((a, b) => a + b, 0) / t.sims.length
  return {
    n: t.total,
    top1Pct: Number(((100 * t.top1) / t.total).toFixed(1)),
    top5Pct: Number(((100 * t.top5) / t.total).toFixed(1)),
    meanTrueSim: Number(meanSim.toFixed(4)),
  }
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 200)
  const { rows, vectors: baseVectors } = await buildReferenceIndex()
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN)
  console.log(`[robust-ref] sample ${sample.length} of ${rows.length}`)

  const profileKeys = {
    clean: null,
    'tilted-offcenter': 'geometryOnly',
    'tilted-glare-shadow-blur': 'hardGlareShadowBlur',
    'skewed-partial-shadow-noisy': 'hardShadowNoise',
  }
  const tallies = {}
  for (const strategy of STRATEGIES) {
    tallies[strategy] = {
      clean: freshTally(),
      geometryOnly: freshTally(),
      hardGlareShadowBlur: freshTally(),
      hardShadowNoise: freshTally(),
    }
  }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    const pristineVec = baseVectors.get(trueId)
    const augmentedResults = await augmentAll(buf, trueId)
    const augmentedVecs = []
    for (const a of augmentedResults) augmentedVecs.push(await embedImageBuffer(a.buffer))

    const allProtos = [pristineVec, ...augmentedVecs]
    const centroid = mean(allProtos)
    const trimmed = trimmedMean(allProtos, 1)
    const med = medoid(allProtos)
    const centroidOfAug = mean(augmentedVecs)
    const medoidOfAug = medoid(augmentedVecs)
    const trimmedOfAug = trimmedMean(augmentedVecs, 1)

    const strategyVectors = {
      pristineOnly: { type: 'single', vec: pristineVec },
      centroidAll: { type: 'single', vec: centroid },
      trimmedMeanAll: { type: 'single', vec: trimmed },
      medoidAll: { type: 'single', vec: med },
      pristinePlus1Aux: { type: 'multi', protos: [pristineVec, centroidOfAug] },
      pristinePlus2Aux: { type: 'multi', protos: [pristineVec, medoidOfAug, trimmedOfAug] },
      pristinePlus4Aux: {
        type: 'multi',
        protos: [
          pristineVec,
          augmentedVecs[1],
          augmentedVecs[2],
          augmentedVecs[3],
          augmentedVecs[4],
        ],
      },
      maxSimAllProtos: { type: 'multi', protos: allProtos, aggregate: 'max' },
      avgTop2AllProtos: { type: 'multi', protos: allProtos, aggregate: 'avgTop2' },
    }

    // Build per-strategy vectors map (only trueId's row differs from baseVectors; every other
    // card stays pristine — see file header for why).
    async function evalQuery(qVec, profileKey) {
      for (const strategy of STRATEGIES) {
        const sv = strategyVectors[strategy]
        let hits
        if (sv.type === 'single') {
          const vectors = new Map(baseVectors)
          vectors.set(trueId, sv.vec)
          hits = searchIndex(qVec, vectors)
        } else {
          const protoMap = new Map()
          for (const [id, v] of baseVectors) protoMap.set(id, id === trueId ? sv.protos : [v])
          hits = searchMultiProto(qVec, protoMap, { aggregate: sv.aggregate ?? 'max' })
        }
        record(tallies[strategy][profileKey], hits, trueId)
      }
    }

    const cleanVec = await embedImageBuffer(buf)
    await evalQuery(cleanVec, 'clean')

    const hardQueries = await hardAugmentAll(buf, trueId)
    for (const hq of hardQueries) {
      const key = profileKeys[hq.profile]
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      const qVec = await embedImageBuffer(cropped)
      await evalQuery(qVec, key)
    }

    done += 1
    if (done % 25 === 0) console.log(`[robust-ref] progress ${done}/${sample.length}`)
  }

  const results = {}
  for (const strategy of STRATEGIES) {
    results[strategy] = Object.fromEntries(
      Object.entries(tallies[strategy]).map(([k, t]) => [k, summarize(t)]),
    )
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    corpusSize: rows.length,
    strategies: STRATEGIES,
    results,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '03-robust-reference.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
