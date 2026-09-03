// Experiment 04 (§7): DINO output-representation sweep. CLS-token-only is the shipped production
// representation (D-097) — this checks whether mean/max/GeM patch pooling, a CLS+mean blend, or
// center-patch pooling would have done better under the hard-defect regime, using a SMALLER
// reference subset (full patch tensors are ~365x larger per card than CLS alone; keeping the whole
// 4,300-card corpus in memory as patch tensors is avoidable and unnecessary to answer this specific
// question — disclosed scope, not the full corpus).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { embedImageRaw, poolVariants, warmUpModel, POOLING_VARIANTS } from '../embedding/embed.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

function stratifiedSample(rows, n, seedStr = 'p91-pooling') {
  const seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1)
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1)
    out.push(rows[(offset + i * stride) % rows.length])
  return out
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

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
  const subsetN = Number(process.argv.find((a) => a.startsWith('--subset='))?.split('=')[1] ?? 500)
  const corpus = JSON.parse(await readFile(join(here, '..', '.cache', 'corpus.json'), 'utf-8'))
  const subset = stratifiedSample(corpus, subsetN)
  console.log(`[pooling] subset ${subset.length} of ${corpus.length}`)

  await warmUpModel()

  // Build the reference index for EVERY pooling variant simultaneously (one embed pass, N pooled
  // views extracted per image — cheaper than N separate embed passes).
  const referenceByVariant = {}
  for (const v of POOLING_VARIANTS) referenceByVariant[v] = new Map()

  let done = 0
  for (const row of subset) {
    const buf = await readFile(row.imagePath)
    const raw = await embedImageRaw(buf)
    const pooled = poolVariants(raw)
    for (const v of POOLING_VARIANTS) referenceByVariant[v].set(row.cardId, pooled[v])
    done += 1
    if (done % 100 === 0) console.log(`[pooling] reference embed progress ${done}/${subset.length}`)
  }

  const profileKeys = {
    clean: null,
    'tilted-glare-shadow-blur': 'hardGlareShadowBlur',
    'skewed-partial-shadow-noisy': 'hardShadowNoise',
  }
  const tallies = {}
  for (const v of POOLING_VARIANTS)
    tallies[v] = {
      clean: freshTally(),
      hardGlareShadowBlur: freshTally(),
      hardShadowNoise: freshTally(),
    }

  done = 0
  for (const row of subset) {
    const trueId = row.cardId
    const buf = await readFile(row.imagePath)

    async function evalBuffer(buffer, profileKey) {
      const raw = await embedImageRaw(buffer)
      const pooled = poolVariants(raw)
      for (const v of POOLING_VARIANTS) {
        const qVec = pooled[v]
        const hits = []
        for (const [cardId, refVec] of referenceByVariant[v])
          hits.push({ cardId, similarity: dot(refVec, qVec) })
        hits.sort((a, b) => b.similarity - a.similarity)
        record(tallies[v][profileKey], hits, trueId)
      }
    }

    await evalBuffer(buf, 'clean')
    const hardQueries = await hardAugmentAll(buf, trueId, [
      'tilted-glare-shadow-blur',
      'skewed-partial-shadow-noisy',
    ])
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      await evalBuffer(cropped, profileKeys[hq.profile])
    }

    done += 1
    if (done % 50 === 0) console.log(`[pooling] eval progress ${done}/${subset.length}`)
  }

  const results = {}
  for (const v of POOLING_VARIANTS)
    results[v] = Object.fromEntries(Object.entries(tallies[v]).map(([k, t]) => [k, summarize(t)]))

  const report = {
    generatedAt: new Date().toISOString(),
    subsetSize: subset.length,
    poolingVariants: POOLING_VARIANTS,
    results,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, '04-pooling-sweep.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
