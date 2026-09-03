// P95 §9-10: DINO true-card K coverage per regime (TOP5/10/20/50/100/200), and the same for
// P91's strongest multi-prototype reference strategy (pristinePlus1Aux, §10) — a reranker or
// stricter shortlist is only useful if the true card is IN the shortlist at all. Regimes: clean,
// geometry-only (P91's tilted-offcenter), the new §17 iPhone-like moderate profile, and P91's two
// catastrophic hard-defect profiles (for completeness/contrast — already known 0% at any K from
// P91, but coverage-at-K is a different question than TOP1).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { applyNamedProfile } from '../augment/photometric.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { composeContinuous, IPHONE_LIKE_LEVELS } from '../augment/continuous.mjs'
import { mean, searchMultiProto } from '../retrieval/vector-math.mjs'
import { augmentAll } from '../augment/photometric.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

const K_VALUES = [1, 5, 10, 20, 50, 100, 200]

function stratifiedSample(rows, n, seedStr) {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

function coverageSummary(ranks) {
  const n = ranks.length
  const out = { n }
  for (const k of K_VALUES) {
    const covered = ranks.filter((r) => r !== null && r <= k).length
    out[`top${k}Pct`] = Number(((100 * covered) / n).toFixed(1))
  }
  const found = ranks.filter((r) => r !== null)
  out.meanRankWhenFound = found.length
    ? Number((found.reduce((a, b) => a + b, 0) / found.length).toFixed(1))
    : null
  out.medianRankWhenFound = found.length
    ? found.sort((a, b) => a - b)[Math.floor(found.length / 2)]
    : null
  return out
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 300)
  const { rows, vectors } = await buildReferenceIndex()
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN, 'p95-k-coverage')
  console.log(`[k-coverage] sample ${sample.length} of ${rows.length}`)

  const singleProtoRanks = {
    clean: [],
    geometryOnly: [],
    iphoneLike: [],
    hardGlareShadowBlur: [],
    hardShadowNoise: [],
  }
  const multiProtoRanks = {
    clean: [],
    geometryOnly: [],
    iphoneLike: [],
    hardGlareShadowBlur: [],
    hardShadowNoise: [],
  }

  let done = 0
  for (const row of sample) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    // Build this card's own dual-prototype reference set (pristine + centroid-of-6-augmentations)
    // — same recipe as P91's pristinePlus1Aux, applied only to the sampled card's own row (P91's
    // own disclosed scoping: full-corpus re-embedding is a separate, larger operation — see §16).
    const pristineVec = vectors.get(trueId)
    const augmentedResults = await augmentAll(buf, trueId)
    const augmentedVecs = []
    for (const a of augmentedResults) augmentedVecs.push(await embedImageBuffer(a.buffer))
    const centroidOfAug = mean(augmentedVecs)
    const dualProtos = [pristineVec, centroidOfAug]

    async function evalQuery(qVec, key) {
      const singleHits = searchIndex(qVec, vectors)
      const singleRank = singleHits.findIndex((h) => h.cardId === trueId) + 1 || null
      singleProtoRanks[key].push(singleRank)

      const protoMap = new Map()
      for (const [id, v] of vectors) protoMap.set(id, id === trueId ? dualProtos : [v])
      const multiHits = searchMultiProto(qVec, protoMap, { aggregate: 'max' })
      const multiRank = multiHits.findIndex((h) => h.cardId === trueId) + 1 || null
      multiProtoRanks[key].push(multiRank)
    }

    const cleanVec = await embedImageBuffer(buf)
    await evalQuery(cleanVec, 'clean')

    const geomBuf = await applyNamedProfile('perspective-rotate', buf, trueId)
    const geomVec = await embedImageBuffer(geomBuf)
    await evalQuery(geomVec, 'geometryOnly')

    const iphoneBuf = await composeContinuous(buf, trueId, IPHONE_LIKE_LEVELS)
    const iphoneVec = await embedImageBuffer(iphoneBuf)
    await evalQuery(iphoneVec, 'iphoneLike')

    const hardQueries = await hardAugmentAll(buf, trueId)
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      const qVec = await embedImageBuffer(cropped)
      const key =
        hq.profile === 'tilted-glare-shadow-blur'
          ? 'hardGlareShadowBlur'
          : hq.profile === 'skewed-partial-shadow-noisy'
            ? 'hardShadowNoise'
            : null
      if (key) await evalQuery(qVec, key)
    }

    done += 1
    if (done % 50 === 0) console.log(`[k-coverage] progress ${done}/${sample.length}`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySampleSize: sample.length,
    corpusSize: rows.length,
    kValues: K_VALUES,
    singlePrototype: Object.fromEntries(
      Object.entries(singleProtoRanks).map(([k, ranks]) => [k, coverageSummary(ranks)]),
    ),
    dualPrototype_pristinePlus1Aux: Object.fromEntries(
      Object.entries(multiProtoRanks).map(([k, ranks]) => [k, coverageSummary(ranks)]),
    ),
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '09-k-coverage.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
