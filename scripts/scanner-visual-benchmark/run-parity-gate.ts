/**
 * P84 §2-§6: the REQUIRED generator/browser embedding-contract parity gate.
 *
 * Question: are the INDEX-GENERATOR embedding path (embed.mjs's embedImageBuffer, used by
 * build-index.ts to produce the committed 19,501-card index) and the BROWSER RUNTIME embedding
 * path (visual-worker.ts's embedAndSearch) actually contract-compatible, or has nobody ever
 * proven it end-to-end?
 *
 * The two paths differ in exactly one structural way, confirmed by direct code reading (P84 §1):
 *   GENERATOR:  file bytes (webp/jpeg) -> RawImage.fromBlob(blob) -> [Node: sharp decode
 *               internally] -> processor(image) -> model(inputs) -> last_hidden_state.data[0:384]
 *   BROWSER:    ImageBitmap -> OffscreenCanvas drawImage + getImageData -> raw RGBA bytes ->
 *               new RawImage(rgba, w, h, 4) [skips fromBlob's decode entirely] ->
 *               processor(image) -> model(inputs) -> last_hidden_state.data[0:384]
 *
 * Reassuring prior fact (confirmed reading node_modules/@huggingface/transformers's own source,
 * not assumed): in a REAL browser, RawImage.fromBlob ALSO does exactly
 * `canvas.getContext('2d').drawImage(...); ctx.getImageData(...)` — i.e. visual-worker.ts's manual
 * `bitmapToRgba` + `new RawImage(...)` is structurally the SAME operation a browser's own
 * `RawImage.fromBlob` would perform. The one thing that is NOT proven anywhere in this repo's
 * history is whether decoding a real card image via a raw-RGBA-buffer construction produces an
 * embedding equivalent to decoding the SAME image via the file-bytes path Node's sharp-backed
 * `fromBlob` uses for every committed index row. This script proves (or disproves) exactly that,
 * plus the INT8-vs-FP32 quantization question (P84 §5) and a same-corpus self-retrieval gate
 * (P84 §6), all against REAL card images from the cached 240-card benchmark corpus (P76-era, real
 * TCGdex downloads) — the closest real-image stand-in available without hosted DB credentials
 * (same disclosed gap every M15 session since P77 has recorded: the cached corpus's ids are
 * TCGdex-style, not the real catalog's hosted UUIDs, so this cannot validate against the ACTUAL
 * committed 19,501-row index by id — see REAL_INDEX_SELF_RETRIEVAL section below for what IS
 * checked against the real committed index).
 *
 * Run: `pnpm tsx scripts/scanner-visual-benchmark/run-parity-gate.ts [--limit=N]`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers'
import { buildCorpus } from './lib/fetch-references.mjs'
import { embedImageBuffer, warmUpModel, VISUAL_MODEL_ID } from './lib/embed.mjs'
import {
  quantizeEmbedding,
  l2Normalize,
  VISUAL_INDEX_INT8_SCALE,
} from '../../src/data/scanner/visual-index'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, 'reports')

env.allowRemoteModels = true
env.cacheDir = join(here, '.benchmark-cache', 'hf-cache')

interface CorpusRow {
  cardId: string
  imagePath: string
}

/** Mirrors visual-worker.ts's embedAndSearch EXACTLY, except the RGBA source comes from sharp's
 *  raw decode (a stand-in for a browser's OffscreenCanvas getImageData) instead of an ImageBitmap
 *  drawn to canvas — the one piece a headless Node script cannot literally reproduce. Uses the
 *  SAME model/processor singletons embed.mjs already warms up (loadModel/loadProcessor are
 *  module-private in embed.mjs, so this script keeps its own singleton pair pointed at the exact
 *  same model id/revision/dtype/cache dir to avoid a second, divergent download). */
let browserModelPromise: ReturnType<typeof AutoModel.from_pretrained> | null = null
let browserProcessorPromise: ReturnType<typeof AutoProcessor.from_pretrained> | null = null
function loadBrowserModel() {
  browserModelPromise ??= AutoModel.from_pretrained(VISUAL_MODEL_ID, { dtype: 'q8' })
  return browserModelPromise
}
function loadBrowserProcessor() {
  browserProcessorPromise ??= AutoProcessor.from_pretrained(VISUAL_MODEL_ID)
  return browserProcessorPromise
}

interface RawEmbedResult {
  vector: Float32Array
  lastHiddenStateDims: readonly number[] | null
}

/** The BROWSER-PATH-EQUIVALENT embed function: takes RAW RGBA pixel bytes (what a canvas
 *  getImageData call would hand visual-worker.ts's bitmapToRgba) and constructs a RawImage
 *  DIRECTLY, skipping any file-format decode — structurally identical to
 *  `new RawImage(new Uint8ClampedArray(bitmapToRgba(bitmap)), bitmap.width, bitmap.height, 4)`. */
async function embedRawRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<RawEmbedResult> {
  const model = await loadBrowserModel()
  const processor = await loadBrowserProcessor()
  const image = new RawImage(rgba, width, height, 4)
  const inputs = (await processor(image)) as Record<string, unknown>
  const output = (await model(inputs)) as {
    last_hidden_state: { data: ArrayLike<number>; dims?: readonly number[] }
  }
  const raw = Float32Array.from(output.last_hidden_state.data).slice(0, 384)
  return { vector: l2Normalize(raw), lastHiddenStateDims: output.last_hidden_state.dims ?? null }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    na += (a[i] ?? 0) ** 2
    nb += (b[i] ?? 0) ** 2
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[idx] ?? NaN
}
function summarizeDistribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return {
    n: values.length,
    mean: Number(mean.toFixed(6)),
    median: Number(percentile(sorted, 0.5).toFixed(6)),
    min: Number(sorted[0]?.toFixed(6)),
    max: Number(sorted[sorted.length - 1]?.toFixed(6)),
    p10: Number(percentile(sorted, 0.1).toFixed(6)),
    p90: Number(percentile(sorted, 0.9).toFixed(6)),
  }
}

function rankOf(orderedIds: string[], trueId: string): number | null {
  const idx = orderedIds.indexOf(trueId)
  return idx === -1 ? null : idx + 1
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 999

  console.log('[parity-gate] loading cached corpus...')
  const fullCorpus = (await buildCorpus({ maxPerSet: 999 })) as CorpusRow[]
  const corpus = fullCorpus.slice(0, limit)
  console.log(`[parity-gate] using ${corpus.length}/${fullCorpus.length} cached real card images`)

  console.log('[parity-gate] warming up generator-path model...')
  await warmUpModel()
  console.log('[parity-gate] warming up browser-path-equivalent model...')
  await loadBrowserModel()
  await loadBrowserProcessor()

  const generatorEmbeddings = new Map<string, Float32Array>()
  const browserSimEmbeddings = new Map<string, Float32Array>()
  const cosineSimilarities: number[] = []
  let dinoOutputDims: readonly number[] | null = null
  let dinoOutputDimsLogged = false

  for (const row of corpus) {
    const buffer = await readFile(row.imagePath)

    // GENERATOR PATH: exact production index-build call.
    const generatorRaw = await embedImageBuffer(buffer)
    const generatorVec = l2Normalize(new Float32Array(generatorRaw))
    generatorEmbeddings.set(row.cardId, generatorVec)

    // BROWSER-PATH-EQUIVALENT: decode the SAME file bytes to raw RGBA via sharp (a real decode,
    // structurally the same output shape a canvas getImageData call produces — 8-bit RGBA,
    // straight alpha, no color-managed reinterpretation applied beyond what the decoder itself
    // does), then feed that raw buffer directly into RawImage, skipping fromBlob's own decode.
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    const browserResult = await embedRawRgba(rgba, info.width, info.height)
    browserSimEmbeddings.set(row.cardId, browserResult.vector)
    if (!dinoOutputDimsLogged && browserResult.lastHiddenStateDims) {
      dinoOutputDims = browserResult.lastHiddenStateDims
      dinoOutputDimsLogged = true
    }

    cosineSimilarities.push(cosineSimilarity(generatorVec, browserResult.vector))
  }

  // ---- Self-retrieval gate (P84 §6, against the 240-card LOCAL corpus — the real 19,501-card
  // hosted index cannot be tested this way without the original source images or hosted DB
  // credentials, same disclosed gap P77/P80 already recorded) ----
  const cardIdsInOrder = [...generatorEmbeddings.keys()]
  function searchGeneratorIndex(query: Float32Array) {
    return cardIdsInOrder
      .map((cardId) => {
        const ref = generatorEmbeddings.get(cardId)
        if (!ref) return { cardId, similarity: -1 }
        return { cardId, similarity: cosineSimilarity(ref, query) }
      })
      .sort((a, b) => b.similarity - a.similarity)
  }

  let selfTop1 = 0
  let selfTop3 = 0
  let selfTop5 = 0
  const selfRanks: number[] = []
  for (const row of corpus) {
    const browserVec = browserSimEmbeddings.get(row.cardId)
    if (!browserVec) continue
    const ranked = searchGeneratorIndex(browserVec).map((h) => h.cardId)
    const rank = rankOf(ranked, row.cardId)
    if (rank !== null) {
      selfRanks.push(rank)
      if (rank <= 1) selfTop1 += 1
      if (rank <= 3) selfTop3 += 1
      if (rank <= 5) selfTop5 += 1
    }
  }

  // Pristine-vs-pristine self retrieval within the generator path ALONE (does the exact same
  // generator-path embedding of a pristine reference retrieve itself when searched against the
  // corpus's own generator-built index?) — the cleanest possible sanity floor.
  let generatorSelfTop1 = 0
  for (const row of corpus) {
    const vec = generatorEmbeddings.get(row.cardId)
    if (!vec) continue
    const ranked = searchGeneratorIndex(vec).map((h) => h.cardId)
    if (ranked[0] === row.cardId) generatorSelfTop1 += 1
  }

  // ---- INT8 vs FP32 agreement (P84 §5), re-proven against THIS session's own generator-path
  // embeddings, over the SAME quantizeEmbedding function the real 19,501-card index used ----
  let int8Top1Agreement = 0
  const int8CosineDeltas: number[] = []
  for (const row of corpus) {
    const fp32 = generatorEmbeddings.get(row.cardId)
    if (!fp32) continue
    const int8 = quantizeEmbedding(fp32)
    const dequantized = new Float32Array(int8.length)
    for (let i = 0; i < int8.length; i += 1)
      dequantized[i] = (int8[i] ?? 0) / VISUAL_INDEX_INT8_SCALE
    int8CosineDeltas.push(1 - cosineSimilarity(fp32, dequantized))

    const fp32Ranked = searchGeneratorIndex(fp32).map((h) => h.cardId)[0]
    // Search using the FP32 corpus as reference (int8-vs-fp32 top1 agreement asks: does quantizing
    // the QUERY change which reference it top-1-matches against a fixed reference pool).
    const int8Ranked = searchGeneratorIndex(dequantized).map((h) => h.cardId)[0]
    if (fp32Ranked === int8Ranked) int8Top1Agreement += 1
  }

  // ---- REAL committed 19,501-card index self-consistency (decode/search correctness only — NOT
  // embedding-generation parity, which this script cannot test against the real index without the
  // original source images) ----
  const realIndexCheck = await checkRealIndexSelfConsistency()

  const report = {
    generatedAt: new Date().toISOString(),
    corpusSize: corpus.length,
    dinoOutputLastHiddenStateDims: dinoOutputDims,
    generatorBrowserCosineSimilarity: summarizeDistribution(cosineSimilarities),
    generatorPathPristineSelfTop1Pct: Number(
      ((100 * generatorSelfTop1) / corpus.length).toFixed(2),
    ),
    browserSimVsGeneratorIndexSelfRetrieval: {
      top1Pct: Number(((100 * selfTop1) / corpus.length).toFixed(2)),
      top3Pct: Number(((100 * selfTop3) / corpus.length).toFixed(2)),
      top5Pct: Number(((100 * selfTop5) / corpus.length).toFixed(2)),
      rankDistribution: summarizeDistribution(selfRanks),
    },
    int8VsFp32: {
      top1AgreementPct: Number(((100 * int8Top1Agreement) / corpus.length).toFixed(2)),
      cosineDelta: summarizeDistribution(int8CosineDeltas),
    },
    realIndexSelfConsistency: realIndexCheck,
    note:
      'generatorBrowserCosineSimilarity and browserSimVsGeneratorIndexSelfRetrieval are measured ' +
      'against the 240-card LOCAL benchmark corpus (real TCGdex images, P76-era cache) because ' +
      'this session has no hosted-DB credentials and no cached copy of the images that built the ' +
      'REAL 19,501-card committed index (same disclosed gap as P77/P80). realIndexSelfConsistency ' +
      'instead directly exercises the REAL committed index/embeddings.bin for internal ' +
      'decode/search correctness (every row retrieves itself via its own stored vector) — this is ' +
      'a search-mechanism check, not an embedding-generation-parity check.',
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, 'parity-gate-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

async function checkRealIndexSelfConsistency() {
  const { decodeVisualIndex, searchVisualIndex } =
    await import('../../src/data/scanner/visual-index')
  const indexDir = join(here, '..', 'scanner-visual-index', 'generated', 'visual-v1')
  const manifest = JSON.parse(
    await readFile(join(indexDir, 'manifest.json'), 'utf-8'),
  ) as import('../../src/data/scanner/visual-index').VisualIndexManifest
  const cardIds = JSON.parse(await readFile(join(indexDir, 'card-ids.json'), 'utf-8')) as string[]
  const embeddingsBuffer = await readFile(join(indexDir, 'embeddings.bin'))
  const embeddingsBytes = new Int8Array(
    embeddingsBuffer.buffer,
    embeddingsBuffer.byteOffset,
    embeddingsBuffer.byteLength,
  )
  const decoded = decodeVisualIndex(manifest, cardIds, embeddingsBytes)

  // Sample a deterministic, spread-out subset (every Nth row) rather than every 19,501 rows —
  // brute-force search is O(cardCount) per query, so a full self-retrieval sweep would be O(n^2).
  const sampleEvery = Math.max(1, Math.floor(decoded.cardIds.length / 500))
  let top1 = 0
  let checked = 0
  const dim = decoded.manifest.embeddingDim
  for (let row = 0; row < decoded.cardIds.length; row += sampleEvery) {
    const start = row * dim
    const queryVector = decoded.embeddings.slice(start, start + dim)
    const hits = searchVisualIndex(decoded, queryVector, 1)
    checked += 1
    if (hits[0]?.cardId === decoded.cardIds[row]) top1 += 1
  }
  return {
    indexCardCount: decoded.cardIds.length,
    sampled: checked,
    top1Pct: Number(((100 * top1) / checked).toFixed(2)),
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
