// P95 §12: actually benchmarks an alternative backbone against the shipped DINOv2-small, on the
// SAME card subset, across the same clean/geometry/iphone-like-moderate/hard-defect regimes every
// other P95 experiment uses. Only ConvNeXtV2-tiny-22k-224 has a ready ONNX conversion (see
// embedding/embed-convnextv2.mjs header for why MobileNetV3-small/EfficientFormer-L1 are NOT
// benchmarked — no ready ONNX export, converting either is out of scope per the prompt's own
// stop-the-rabbit-hole instruction). Scoped to a SUBSET of the corpus (not the full ~4,300) to keep
// re-embedding a brand-new model's reference index inside this session's time budget — disclosed,
// same scoping discipline P91 used for its reference-augmentation experiments.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCorpus } from '../retrieval/build-index.mjs'
import { searchIndex } from '../retrieval/build-index.mjs'
import * as dino from '../embedding/embed.mjs'
import * as convnext from '../embedding/embed-convnextv2.mjs'
import { applyNamedProfile } from '../augment/photometric.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'
import { composeContinuous, IPHONE_LIKE_LEVELS } from '../augment/continuous.mjs'

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

function freshTally() {
  return { top1: 0, top5: 0, total: 0, sims: [] }
}
function record(tally, hits, trueId) {
  tally.total += 1
  const rank = hits.findIndex((h) => h.cardId === trueId) + 1 || null
  if (rank === 1) tally.top1 += 1
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

async function buildMiniIndex(rows, embedder) {
  const vectors = new Map()
  for (const row of rows) {
    const buf = await readFile(row.imagePath)
    vectors.set(row.cardId, await embedder.embedImageBuffer(buf))
  }
  return vectors
}

async function benchmarkModel(name, embedder, corpusSubset, queries) {
  console.log(`[alt-model] warming up ${name}...`)
  await embedder.warmUpModel()
  console.log(
    `[alt-model] building ${corpusSubset.length}-card mini reference index for ${name}...`,
  )
  const t0 = Date.now()
  const vectors = await buildMiniIndex(corpusSubset, embedder)
  const indexBuildMs = Date.now() - t0

  const tallies = {
    clean: freshTally(),
    geometryOnly: freshTally(),
    iphoneLike: freshTally(),
    hardGlareShadowBlur: freshTally(),
    hardShadowNoise: freshTally(),
  }
  const latencies = []

  let done = 0
  for (const row of queries) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    async function evalQuery(queryBuf, key) {
      const t1 = Date.now()
      const qVec = await embedder.embedImageBuffer(queryBuf)
      latencies.push(Date.now() - t1)
      const hits = searchIndex(qVec, vectors)
      record(tallies[key], hits, trueId)
    }

    await evalQuery(buf, 'clean')
    const geomBuf = await applyNamedProfile('perspective-rotate', buf, trueId)
    await evalQuery(geomBuf, 'geometryOnly')
    const iphoneBuf = await composeContinuous(buf, trueId, IPHONE_LIKE_LEVELS)
    await evalQuery(iphoneBuf, 'iphoneLike')
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
      if (key) await evalQuery(cropped, key)
    }
    done += 1
    if (done % 50 === 0) console.log(`[alt-model] ${name} progress ${done}/${queries.length}`)
  }

  return {
    embeddingDim: embedder.EMBEDDING_DIM,
    indexBuildMs,
    meanEmbedLatencyMs: Number(
      (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1),
    ),
    results: Object.fromEntries(Object.entries(tallies).map(([k, t]) => [k, summarize(t)])),
  }
}

async function main() {
  const subsetN = Number(process.argv.find((a) => a.startsWith('--subset='))?.split('=')[1] ?? 400)
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 150)
  const rows = await loadCorpus()
  const corpusSubset = stratifiedSample(rows, subsetN, 'p95-alt-model-subset')
  const queries = stratifiedSample(corpusSubset, queryN, 'p95-alt-model-queries')
  console.log(`[alt-model] corpus subset=${corpusSubset.length}, queries=${queries.length}`)

  const dinoResult = await benchmarkModel('DINOv2-small (shipped)', dino, corpusSubset, queries)
  const convnextResult = await benchmarkModel(
    'ConvNeXtV2-tiny-22k-224',
    convnext,
    corpusSubset,
    queries,
  )

  const report = {
    generatedAt: new Date().toISOString(),
    corpusSubsetSize: corpusSubset.length,
    querySampleSize: queries.length,
    note: 'ConvNeXtV2-tiny uses L2-normalized classification LOGITS as its embedding (no pooled-feature ONNX export available) — a known-lossy stand-in for a true embedding; see embedding/embed-convnextv2.mjs header. MobileNetV3-small and EfficientFormer-L1 have no ready ONNX conversion and were not benchmarked (would require a separate PyTorch->ONNX export pipeline, out of scope per prompt).',
    models: {
      'DINOv2-small (shipped)': dinoResult,
      'ConvNeXtV2-tiny-22k-224': convnextResult,
    },
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '14-alternative-model-benchmark.json'),
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
