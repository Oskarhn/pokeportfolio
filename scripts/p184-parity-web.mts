/**
 * P184 web/native parity: the WEB scanner's recognition logic (its own Tesseract full-frame OCR
 * path, its own pinned DINOv2 model + committed visual index through the shared preprocessing, and
 * its own `matchScannerObservation` fusion) run in Node over the SAME image files the device scans,
 * against the SAME local catalog. The result is compared with the device's own trace
 * (.build/p184-evidence/scenario-eval.json) by scripts/p184/parity-compare.mjs.
 *
 * What this is and is not: the web scanner's primary OCR path crops regions from a live capture
 * guide (canvas + rectification) and cannot be replayed on a still photo without that geometry, so
 * the OCR side is the web scanner's documented FULL-FRAME FALLBACK path (`splitFullFrameCardText`).
 * The visual channel uses the same model file (hash-verified), the same
 * `preprocessRgbaForDino` and the same index search the web worker uses in its canvas-free path.
 * Fusion is the identical shared engine. Floating-point similarity is NOT expected to match.
 *
 *   pnpm exec tsx scripts/p184-parity-web.mts <apiPort> <email> <password> <outFile> <imageDir|manifest> ...
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorker } from 'tesseract.js'
import { matchScannerObservation } from '../src/domain/scanner/engine'
import { preprocessRgbaForDino } from '../src/domain/scanner/dino-preprocess'
import type {
  ScannerCandidateRecord,
  ScannerObservation,
  VisualEvidenceByCard,
} from '../src/domain/scanner/types'
import { decodeVisualIndex, l2Normalize, searchVisualIndex } from '../src/data/scanner/visual-index'
import { splitFullFrameCardText, cleanSignal } from '../src/features/scanner/analyze'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appAssets = join(repoRoot, 'apps', 'mobile-spike', 'assets', 'scanner', 'visual-v1')
const sharp = require('sharp') as typeof import('sharp')
const ort = require('onnxruntime-node') as typeof import('onnxruntime-node')

const [apiPort, email, password, outFile, ...imagePaths] = process.argv.slice(2)
if (!apiPort || !email || !password || !outFile || imagePaths.length === 0) {
  throw new Error('usage: <apiPort> <email> <password> <outFile> <image>...')
}
const API = `http://127.0.0.1:${apiPort}`
const DECODE_MAX_LONG_EDGE = 1600
const VISUAL_TOP_K = 30

// ---- local API (isolated stack): sign in as the synthetic fixture user, read the catalog -------
const publicEnv = JSON.parse(
  readFileSync(
    join(repoRoot, 'apps', 'mobile-spike', '.local-backend', 'p184', 'public-env.json'),
    'utf8',
  ),
) as { publishableKey: string }
const auth = (await (
  await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publicEnv.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
).json()) as { access_token: string }
const headers = {
  apikey: publicEnv.publishableKey,
  authorization: `Bearer ${auth.access_token}`,
  'content-type': 'application/json',
}

interface SearchRow {
  card_id: string
  name: string
  local_id: string
  rarity: string | null
  category: string | null
  illustrator: string | null
  image_base_url: string | null
  language: 'en' | 'ja'
  set_id: string
  set_name: string
  variant_count: number
}
async function searchCards(query: string): Promise<ScannerCandidateRecord[]> {
  const res = await fetch(`${API}/rest/v1/rpc/search_cards`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_query: query, p_language: 'en', p_limit: 25, p_offset: 0 }),
  })
  const rows = (await res.json()) as SearchRow[]
  return rows.map((r) => ({
    cardId: r.card_id,
    name: r.name,
    localId: r.local_id,
    rarity: r.rarity,
    category: r.category,
    illustrator: r.illustrator,
    imageBaseUrl: r.image_base_url,
    language: r.language,
    setId: r.set_id,
    setName: r.set_name,
    variantCount: r.variant_count,
  }))
}
interface CardRow {
  id: string
  name: string
  local_id: string
  rarity: string | null
  category: string | null
  illustrator: string | null
  image_base_url: string | null
  language: 'en' | 'ja'
  set_id: string
  card_sets: { name: string } | null
}
async function cardsByIds(ids: string[]): Promise<ScannerCandidateRecord[]> {
  if (ids.length === 0) return []
  const select =
    'id,name,local_id,rarity,category,illustrator,image_base_url,language,set_id,card_sets(name)'
  const res = await fetch(
    `${API}/rest/v1/cards?select=${encodeURIComponent(select)}&id=in.(${ids.join(',')})&is_active=eq.true&language=eq.en`,
    { headers },
  )
  const rows = (await res.json()) as CardRow[]
  return rows.map((r) => ({
    cardId: r.id,
    name: r.name,
    localId: r.local_id,
    rarity: r.rarity,
    category: r.category,
    illustrator: r.illustrator,
    imageBaseUrl: r.image_base_url,
    language: r.language,
    setId: r.set_id,
    setName: r.card_sets?.name ?? '',
    variantCount: 0,
  }))
}

// ---- pinned assets: verified before use, exactly like the device -------------------------------
const manifest = JSON.parse(readFileSync(join(appAssets, 'index', 'manifest.json'), 'utf8'))
const cardIds = JSON.parse(
  readFileSync(join(appAssets, 'index', 'card-ids.json'), 'utf8'),
) as string[]
const embeddingBytes = new Uint8Array(readFileSync(join(appAssets, 'index', 'embeddings.bin')))
const modelPath = join(appAssets, 'model', 'onnx', 'model_quantized.onnx')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
if (sha(readFileSync(modelPath)) !== manifest.modelSha256) throw new Error('model hash mismatch')
if (sha(embeddingBytes) !== manifest.embeddingsSha256) throw new Error('index hash mismatch')
const index = decodeVisualIndex(
  manifest,
  cardIds,
  new Int8Array(embeddingBytes.buffer, embeddingBytes.byteOffset, embeddingBytes.byteLength),
)
const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
const ocrWorker = await createWorker('eng', 1, {
  langPath: join(repoRoot, 'public', 'scanner-assets', 'v7'),
  gzip: true,
  logger: () => undefined,
})
await ocrWorker.setParameters({ tessedit_pageseg_mode: '3' as never })

const results: unknown[] = []
for (const path of imagePaths) {
  const image = sharp(path).rotate() // EXIF orientation, like the device decoder
  const meta = await image.metadata()
  const scale = Math.max(meta.width ?? 1, meta.height ?? 1) > DECODE_MAX_LONG_EDGE
  const resized = scale
    ? image.resize({ width: DECODE_MAX_LONG_EDGE, height: DECODE_MAX_LONG_EDGE, fit: 'inside' })
    : image
  const { data, info } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const rgba = { data: new Uint8ClampedArray(data), width: info.width, height: info.height }

  // Web OCR: full-frame fallback path.
  const ocr = await ocrWorker.recognize(path)
  const split = splitFullFrameCardText(ocr.data.text ?? '')
  const observation: ScannerObservation = {
    rawNameText: cleanSignal(split.name, 1),
    rawCollectorNumberText: cleanSignal(split.number, 1),
    rawSetText: null,
    languageHint: 'en',
  }

  // Web visual: same model, same shared preprocessing, same index search.
  const pre = preprocessRgbaForDino(rgba)
  const out = await session.run({
    [session.inputNames[0] as string]: new ort.Tensor('float32', pre.data, [1, ...pre.dims]),
  })
  const raw = Float32Array.from(
    (out[session.outputNames[0] as string] as { data: ArrayLike<number> }).data,
  ).slice(0, manifest.embeddingDim)
  const hits = searchVisualIndex(index, l2Normalize(raw), VISUAL_TOP_K)
  const visualScores: VisualEvidenceByCard = new Map(hits.map((h) => [h.cardId, h.similarity]))

  // Same retrieval as the native pipeline: text recall UNION the visual shortlist.
  const byId = new Map<string, ScannerCandidateRecord>()
  const textQuery = [observation.rawNameText, observation.rawCollectorNumberText]
    .filter((s) => s !== null && s !== undefined)
    .join(' ')
    .trim()
  if (textQuery.length >= 2) for (const c of await searchCards(textQuery)) byId.set(c.cardId, c)
  for (const c of await cardsByIds(hits.map((h) => h.cardId).filter((id) => !byId.has(id))))
    byId.set(c.cardId, c)

  const match = matchScannerObservation(observation, [...byId.values()], visualScores)
  results.push({
    file: path.split(/[\\/]/).pop(),
    ocr: { name: observation.rawNameText, number: observation.rawCollectorNumberText },
    visualTop: hits
      .slice(0, 5)
      .map((h) => ({ cardId: h.cardId, similarity: Math.round(h.similarity * 1e4) / 1e4 })),
    tier: match.tier.toUpperCase().replace('NONE', 'NO_MATCH'),
    topCandidateIds: match.candidates.slice(0, 5).map((c) => c.card.cardId),
    topCandidateNames: match.candidates.slice(0, 5).map((c) => `${c.card.name} #${c.card.localId}`),
  })
  console.log(
    `${String(results.length)}/${String(imagePaths.length)} ${path.split(/[\\/]/).pop() ?? ''} -> ${(results[results.length - 1] as { tier: string }).tier}`,
  )
}
await ocrWorker.terminate()
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`)
