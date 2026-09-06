/**
 * P96/D-107 — permanent preprocessor parity harness. Compares the library's own AutoProcessor
 * path (which every desktop/Chromium scan has always used, and which every real committed
 * production embedding was generated with) against `preprocessRgbaForDino` (the new canvas-free
 * path this session built to keep visual recognition working on a worker without OffscreenCanvas —
 * see `src/domain/scanner/dino-preprocess.ts`'s own header for why this exists).
 *
 * Both paths run on the IDENTICAL decoded RGBA pixel buffer for every (card, shape-variant) pair —
 * this isolates the comparison to the preprocessing algorithm itself, not incidental differences
 * in how each path decodes a source image file. Six shape variants per card exercise the specific
 * cases this session was asked to prove safe: the card's native portrait orientation, a rotated
 * landscape version, odd (non-round) dimensions, an already-224-ish crop, a large real-iPhone-photo
 * scale, and an RGBA buffer carrying a non-opaque alpha channel (production always sends opaque
 * alpha — this variant proves alpha is genuinely ignored, not merely untested).
 *
 * Reuses the SAME real card images and the SAME real committed production visual index every
 * other scanner benchmark in this repository uses — no new corpus, no new network dependency.
 *
 * Run: `pnpm scanner:preprocess:parity [--n=120]`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { AutoModel, AutoProcessor, RawImage, Tensor, env } from '@huggingface/transformers'
import { preprocessRgbaForDino } from '../../src/domain/scanner/dino-preprocess'
import {
  decodeVisualIndex,
  searchVisualIndex,
  l2Normalize,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, 'reports')
const BENCHMARK_CACHE = join(here, '..', 'scanner-visual-benchmark', '.benchmark-cache')
const CORPUS_MANIFEST = join(BENCHMARK_CACHE, 'corpus.json')
const REPO_ROOT = join(here, '..', '..')
const INDEX_BASE = join(REPO_ROOT, 'public', 'scanner-assets', 'visual-v1', 'index')

// Pinned model identity — matches src/features/scanner/visual/visual-worker.ts's
// EXPECTED_MODEL_REVISION and scripts/scanner-visual-benchmark/lib/embed.mjs exactly (D-097).
const VISUAL_MODEL_ID = 'Xenova/dinov2-small'
const VISUAL_MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701'
const EMBEDDING_DIM = 384

env.allowRemoteModels = true
env.cacheDir = join(here, '..', 'scanner-visual-benchmark', '.benchmark-cache', 'hf-cache')

interface CorpusRow {
  /** A TCGdex slug (e.g. "base1-1") — a DIFFERENT namespace from the production index's own
   *  `cards.id` UUIDs, so this can never be cross-referenced against the index without a
   *  catalog-DB lookup this offline harness does not have (the same standing credential gap every
   *  M15 session since P75 has disclosed for F-03). Used only as a stable label for this script's
   *  own report, never compared against index card ids. */
  cardId: string
  name: string
  setId: string
  language: string
  imagePath: string
}

interface RgbaBuffer {
  data: Uint8ClampedArray
  width: number
  height: number
}

type VariantName =
  | 'portrait-native'
  | 'landscape-rotated'
  | 'odd-dimensions'
  | 'near-crop-size'
  | 'large-iphone-scale'
  | 'rgba-semi-transparent'

const VARIANTS: VariantName[] = [
  'portrait-native',
  'landscape-rotated',
  'odd-dimensions',
  'near-crop-size',
  'large-iphone-scale',
  'rgba-semi-transparent',
]

async function toRgba(pipeline: sharp.Sharp): Promise<RgbaBuffer> {
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  }
}

async function buildVariant(imagePath: string, variant: VariantName): Promise<RgbaBuffer> {
  const base = sharp(imagePath)
  switch (variant) {
    case 'portrait-native':
      return toRgba(base)
    case 'landscape-rotated':
      return toRgba(base.rotate(90))
    case 'odd-dimensions': {
      const meta = await sharp(imagePath).metadata()
      const w = Math.max(32, meta.width - 37)
      const h = Math.max(32, meta.height - 51)
      return toRgba(base.resize(w, h, { fit: 'fill' }))
    }
    case 'near-crop-size':
      return toRgba(base.resize(230, 230, { fit: 'fill' }))
    case 'large-iphone-scale':
      // Real iPhone main-camera photos land around 3024x4032 (portrait) — upscale the source card
      // art to a comparable scale, preserving its own aspect ratio (fit:'inside' on a generous
      // bounding box), the way a real rectified capture at full sensor resolution would arrive.
      return toRgba(base.resize(3024, 4032, { fit: 'inside' }))
    case 'rgba-semi-transparent': {
      const rgba = await toRgba(base)
      for (let i = 3; i < rgba.data.length; i += 4) rgba.data[i] = 128
      return rgba
    }
  }
}

let modelPromise: ReturnType<typeof AutoModel.from_pretrained> | null = null
let processorPromise: ReturnType<typeof AutoProcessor.from_pretrained> | null = null
function loadModel() {
  modelPromise ??= AutoModel.from_pretrained(VISUAL_MODEL_ID, { dtype: 'q8' })
  return modelPromise
}
function loadProcessor() {
  processorPromise ??= AutoProcessor.from_pretrained(VISUAL_MODEL_ID)
  return processorPromise
}

function extractClsL2Normalized(output: {
  last_hidden_state: { data: ArrayLike<number> }
}): Float32Array {
  const raw = Float32Array.from(output.last_hidden_state.data).slice(0, EMBEDDING_DIM)
  return l2Normalize(raw)
}

/** OLD path: the library's own AutoProcessor, given the RGBA pixels as a RawImage (do_convert_rgb
 *  drops the alpha channel internally, matching production exactly). */
async function embedOldPath(rgba: RgbaBuffer): Promise<Float32Array> {
  const model = await loadModel()
  const processor = await loadProcessor()
  const image = new RawImage(rgba.data, rgba.width, rgba.height, 4)
  const inputs = (await processor(image)) as Record<string, unknown>
  const output = (await model(inputs)) as { last_hidden_state: { data: ArrayLike<number> } }
  return extractClsL2Normalized(output)
}

/** NEW path: this session's canvas-free reimplementation. */
async function embedNewPath(rgba: RgbaBuffer): Promise<Float32Array> {
  const model = await loadModel()
  const preprocessed = preprocessRgbaForDino({
    data: rgba.data,
    width: rgba.width,
    height: rgba.height,
  })
  const pixel_values = new Tensor('float32', preprocessed.data, [1, ...preprocessed.dims])
  const output = (await model({ pixel_values })) as {
    last_hidden_state: { data: ArrayLike<number> }
  }
  return extractClsL2Normalized(output)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let max = 0
  for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
  return max
}

interface VariantResult {
  cardId: string
  variant: VariantName
  cosineSimilarity: number
  maxAbsElementDiff: number
  oldTop1CardId: string
  newTop1CardId: string
  top1Agree: boolean
  oldTop5CardIds: string[]
  newTop5CardIds: string[]
  top5SetsIdentical: boolean
  top5Overlap: number
}

async function main(): Promise<void> {
  const nArg = process.argv.find((a) => a.startsWith('--n='))
  const targetCardCount = nArg ? Number(nArg.slice('--n='.length)) : 120

  console.log('[parity] loading real committed production visual index...')
  const pointer = JSON.parse(await readFile(join(INDEX_BASE, 'current.json'), 'utf8')) as {
    contentId: string
  }
  const genDir = join(INDEX_BASE, 'generations', pointer.contentId)
  const manifest = JSON.parse(
    await readFile(join(genDir, 'manifest.json'), 'utf8'),
  ) as VisualIndexManifest
  const cardIds = JSON.parse(await readFile(join(genDir, 'card-ids.json'), 'utf8')) as string[]
  const embeddingsBuffer = await readFile(join(genDir, 'embeddings.bin'))
  const embeddingsBytes = new Int8Array(
    embeddingsBuffer.buffer,
    embeddingsBuffer.byteOffset,
    embeddingsBuffer.length,
  )
  const index = decodeVisualIndex(manifest, cardIds, embeddingsBytes)
  console.log(
    `[parity] index loaded: ${index.cardIds.length} cards, content id ${pointer.contentId}`,
  )
  if (manifest.modelRevision !== VISUAL_MODEL_REVISION) {
    throw new Error(
      `Index was built with model revision ${manifest.modelRevision}, this harness is pinned to ` +
        `${VISUAL_MODEL_REVISION} — refusing to compare apples to oranges.`,
    )
  }

  console.log('[parity] loading benchmark corpus manifest...')
  const corpus = JSON.parse(await readFile(CORPUS_MANIFEST, 'utf8')) as CorpusRow[]
  // Deterministic stratified sample: every Nth row, so the sample spans the corpus's own set
  // diversity rather than clustering on whatever happened to be fetched first. The corpus's own
  // `cardId` is a TCGdex slug, a different namespace from the index's `cards.id` UUIDs (see
  // CorpusRow's own doc) — retrieval agreement below is measured between the OLD and NEW
  // pipelines' own query results against the real index, not against a ground-truth id lookup
  // this offline harness has no credentials to perform.
  const stride = Math.max(1, Math.floor(corpus.length / targetCardCount))
  const sample = corpus.filter((_, i) => i % stride === 0).slice(0, targetCardCount)
  console.log(
    `[parity] ${corpus.length} corpus cards available; sampling ${sample.length} of them ` +
      `(x ${VARIANTS.length} shape variants = ${sample.length * VARIANTS.length} evaluations) against ` +
      `the real ${index.cardIds.length}-card production index`,
  )

  await loadModel()
  await loadProcessor()

  const results: VariantResult[] = []
  let done = 0
  for (const row of sample) {
    for (const variant of VARIANTS) {
      const rgba = await buildVariant(row.imagePath, variant)
      const [oldEmbedding, newEmbedding] = await Promise.all([
        embedOldPath(rgba),
        embedNewPath(rgba),
      ])
      const cosine = cosineSimilarity(oldEmbedding, newEmbedding)
      const maxDiff = maxAbsDiff(oldEmbedding, newEmbedding)
      const oldHits = searchVisualIndex(index, oldEmbedding, 5)
      const newHits = searchVisualIndex(index, newEmbedding, 5)
      const oldTop5 = oldHits.map((h) => h.cardId)
      const newTop5 = newHits.map((h) => h.cardId)
      const overlap = oldTop5.filter((id) => newTop5.includes(id)).length
      results.push({
        cardId: row.cardId,
        variant,
        cosineSimilarity: cosine,
        maxAbsElementDiff: maxDiff,
        oldTop1CardId: oldTop5[0] ?? '',
        newTop1CardId: newTop5[0] ?? '',
        top1Agree: oldTop5[0] === newTop5[0],
        oldTop5CardIds: oldTop5,
        newTop5CardIds: newTop5,
        top5SetsIdentical: overlap === 5,
        top5Overlap: overlap / 5,
      })
      done += 1
      if (done % 25 === 0)
        console.log(`[parity] ${done}/${sample.length * VARIANTS.length} evaluated`)
    }
  }

  const n = results.length
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const summary = {
    imagesEvaluated: sample.length,
    variantsPerImage: VARIANTS.length,
    totalEvaluations: n,
    meanCosineSimilarity: mean(results.map((r) => r.cosineSimilarity)),
    minCosineSimilarity: Math.min(...results.map((r) => r.cosineSimilarity)),
    meanMaxAbsElementDiff: mean(results.map((r) => r.maxAbsElementDiff)),
    maxMaxAbsElementDiff: Math.max(...results.map((r) => r.maxAbsElementDiff)),
    top1AgreementRate: results.filter((r) => r.top1Agree).length / n,
    top5IdenticalRate: results.filter((r) => r.top5SetsIdentical).length / n,
    meanTop5Overlap: mean(results.map((r) => r.top5Overlap)),
    byVariant: Object.fromEntries(
      VARIANTS.map((variant) => {
        const subset = results.filter((r) => r.variant === variant)
        return [
          variant,
          {
            n: subset.length,
            meanCosineSimilarity: mean(subset.map((r) => r.cosineSimilarity)),
            top1AgreementRate: subset.filter((r) => r.top1Agree).length / subset.length,
            top5IdenticalRate: subset.filter((r) => r.top5SetsIdentical).length / subset.length,
          },
        ]
      }),
    ),
  }

  await mkdir(REPORT_DIR, { recursive: true })
  const reportPath = join(REPORT_DIR, 'parity-report.json')
  await writeFile(reportPath, JSON.stringify({ summary, results }, null, 2))

  console.log('')
  console.log('=== PREPROCESSOR PARITY SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nFull report written to ${reportPath}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
