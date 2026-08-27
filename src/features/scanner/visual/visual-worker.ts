/**
 * Dedicated visual-recognition worker (prompt §26–§27, D-097): model load, image embedding and
 * reference-index search all run off the React main thread. One instance per active scanner
 * session, created lazily on first visual analysis, reused across every scan, terminated on
 * route exit — mirrors ocr-engine.ts's lifecycle discipline exactly.
 *
 * Same-origin only (prompt §24): `env.allowRemoteModels = false` and every asset path below is
 * `/scanner-assets/visual-v1/...`. `env.backends.onnx.wasm.wasmPaths` is set explicitly BEFORE
 * any inference call — left unset, transformers.js defaults to fetching onnxruntime-web's WASM
 * binary from `cdn.jsdelivr.net` (confirmed by reading its bundled source), which would silently
 * violate the same boundary OCR already holds.
 *
 * P78 runtime-initialization repair: WASM is the required baseline, WebGPU is optional
 * acceleration only (prompt §3/§10) — a WebGPU init failure falls back to WASM instead of making
 * the whole channel unavailable. Init is phased (processor / model / index) so a real-device
 * failure is attributable to one stage instead of one opaque message (prompt §11/§12).
 */
/// <reference lib="webworker" />
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers'
import { assertValidCoverage, CoverageInvariantError } from '../../../domain/scanner/index-coverage'
import {
  selectVisualBackend,
  composeUnavailableReason,
  normalizeBackendOverride,
  type VisualBackend,
  type VisualBackendOverride,
  type BackendAttempts,
} from '../../../domain/scanner/visual-backend-selection'
import {
  decodeVisualIndex,
  searchVisualIndex,
  l2Normalize,
  VisualIndexError,
  type DecodedVisualIndex,
  type VisualIndexManifest,
} from '../../../data/scanner/visual-index'

export type {
  VisualBackend,
  VisualBackendOverride,
  BackendAttemptStatus,
} from '../../../domain/scanner/visual-backend-selection'

const ASSET_BASE = '/scanner-assets/visual-v1'
const MODEL_ID = 'model' // local alias — see localModelPath below; not a Hugging Face repo id
const EMBEDDING_DIM = 384
// Mirrors scripts/scanner-visual-index/lib/model-pin.mjs's VISUAL_MODEL_REVISION (D-097) — kept
// as its own literal rather than a cross-import because that pin file lives outside src/ and this
// constant only needs to be compared, never re-derived (same duplication precedent as
// scripts/scanner-visual-benchmark/lib/embed.mjs). ANY change is a deliberate model bump.
const EXPECTED_MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701'

interface InitMessage {
  type: 'init'
  backendOverride?: VisualBackendOverride
}
interface EmbedAndSearchMessage {
  type: 'embed-and-search'
  requestId: number
  bitmap: ImageBitmap
  topK: number
}
type IncomingMessage = InitMessage | EmbedAndSearchMessage

/** Shared by ready/unavailable so the debug panel can always show what was actually attempted,
 *  win or lose (prompt §4/§11/§12). */
interface BackendDiagnostics {
  backendRequested: VisualBackendOverride
  backendAttempts: BackendAttempts
  webgpuError: string | null
  wasmError: string | null
  processorLoad: 'success' | 'failed'
  modelLoad: 'success' | 'failed'
  indexLoad: 'success' | 'failed' | 'not-reached'
}

interface ReadyResponse extends BackendDiagnostics {
  type: 'ready'
  backend: VisualBackend
  indexAvailable: boolean
  cardCount: number
  modelColdLoadMs: number
  /** Diagnostics-only (prompt §40) — never used for match logic, only surfaced in the debug
   *  panel and never persisted. */
  indexVersion: string | null
  indexSourceProjectRef: string | null
  indexLoadMs: number | null
  indexUnavailableReason: string | null
}
interface UnavailableResponse extends BackendDiagnostics {
  type: 'unavailable'
  reason: string
}
interface ResultResponse {
  type: 'result'
  requestId: number
  hits: { cardId: string; similarity: number }[]
  embedMs: number
  searchMs: number
  /** L2 norm of the raw (pre-normalization) embedding — diagnostics-only sanity signal (prompt
   *  §40 EMBEDDING_NORM); the searched vector itself is always unit-normalized regardless. */
  embeddingNorm: number
}
interface ErrorResponse {
  type: 'error'
  requestId: number
  message: string
}
type OutgoingMessage = ReadyResponse | UnavailableResponse | ResultResponse | ErrorResponse

async function detectWebgpuAvailable(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    const adapter = await gpu.requestAdapter()
    return adapter !== null && adapter !== undefined
  } catch {
    return false
  }
}

let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null
let index: DecodedVisualIndex | null = null
let backend: VisualBackend = 'wasm'

function post(message: OutgoingMessage, transfer: Transferable[] = []): void {
  ;(self as unknown as Worker).postMessage(message, transfer)
}

/**
 * Runtime manifest gate (P77 prompt §21): a manifest this browser's pin does not recognize, or
 * whose coverage numbers are internally impossible, must never be trusted — the visual channel
 * simply becomes unavailable and the scanner falls back to OCR + manual search (prompt §36),
 * never a crash. `lastIndexUnavailableReason` lets `init()` report WHY for the diagnostics panel
 * (prompt §40) without changing this function's null-on-failure contract.
 */
let lastIndexUnavailableReason: string | null = null

async function loadIndex(): Promise<DecodedVisualIndex | null> {
  lastIndexUnavailableReason = null
  const manifestResponse = await fetch(`${ASSET_BASE}/manifest.json`)
  if (!manifestResponse.ok) {
    lastIndexUnavailableReason = `manifest.json fetch failed (HTTP ${String(manifestResponse.status)})`
    return null
  }
  const manifest = (await manifestResponse.json()) as VisualIndexManifest
  if (manifest.embeddingDim !== EMBEDDING_DIM) {
    lastIndexUnavailableReason = `manifest embeddingDim ${String(manifest.embeddingDim)} != expected ${String(EMBEDDING_DIM)}`
    return null
  }
  if (manifest.modelRevision !== EXPECTED_MODEL_REVISION) {
    lastIndexUnavailableReason = `manifest modelRevision "${manifest.modelRevision}" != expected "${EXPECTED_MODEL_REVISION}"`
    return null
  }
  if (manifest.cardCount <= 0) {
    lastIndexUnavailableReason = 'manifest cardCount is not positive'
    return null
  }
  const [cardIdsResponse, embeddingsResponse] = await Promise.all([
    fetch(`${ASSET_BASE}/card-ids.json`),
    fetch(`${ASSET_BASE}/embeddings.bin`),
  ])
  if (!cardIdsResponse.ok || !embeddingsResponse.ok) {
    lastIndexUnavailableReason = 'card-ids.json or embeddings.bin fetch failed'
    return null
  }
  const cardIds = (await cardIdsResponse.json()) as string[]
  const embeddingsBuffer = new Int8Array(await embeddingsResponse.arrayBuffer())
  try {
    // Coverage sanity is defense-in-depth here (already asserted at generation time): a manifest
    // claiming cardsIndexed > totalCanonicalCards/cardsWithUsableImage (the 1224/1000 shape) or
    // whose id-list/manifest counts disagree must never be trusted, however it reached this asset
    // path.
    assertValidCoverage(manifest.coverage, cardIds.length, manifest.cardCount)
    return decodeVisualIndex(manifest, cardIds, embeddingsBuffer)
  } catch (error) {
    lastIndexUnavailableReason =
      error instanceof CoverageInvariantError || error instanceof VisualIndexError
        ? error.message
        : `index decode failed: ${(error as Error).message}`
    return null
  }
}

async function loadProcessor(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    processor = await AutoProcessor.from_pretrained(MODEL_ID)
    return { ok: true }
  } catch (error) {
    processor = null
    return { ok: false, error: (error as Error).message }
  }
}

/** One backend attempt. Never leaves a partial model reference behind on failure (prompt §16
 *  memory policy): a failed load always resets `model` to null before the caller can retry on a
 *  different backend, so a WebGPU failure can never hold a half-initialized session in memory
 *  while the WASM retry's own (much larger) buffers load. */
async function loadModelOnBackend(
  device: VisualBackend,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    model = await AutoModel.from_pretrained(MODEL_ID, { dtype: 'q8', device })
    return { ok: true }
  } catch (error) {
    model = null
    return { ok: false, error: (error as Error).message }
  }
}

async function init(message: InitMessage): Promise<void> {
  const startedAt = performance.now()
  const backendRequested = normalizeBackendOverride(message.backendOverride)

  // No remote model loading, ever (prompt §24): everything resolves under same-origin
  // /scanner-assets/visual-v1/. `allowLocalModels` defaults to FALSE in a Web Worker context
  // (transformers.js's own env.ts: `allowLocalModels: !(IS_BROWSER_ENV || IS_WEBWORKER_ENV || ...)`
  // — confirmed by reading the installed 4.2.0 source directly, prompt §6) — left unset, both
  // flags end up false and `from_pretrained` throws "both local and remote models are disabled"
  // before ever touching the ONNX runtime or WASM/WebGPU backend selection below. This was the
  // FIRST of two real, confirmed root causes of the real-device VISUAL_MODEL_STATE=failed report
  // (P78): reproduced on desktop Chromium with no COOP/COEP change, so it was never a
  // crossOriginIsolated/threading issue.
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = `${ASSET_BASE}/`
  // Both Safari and non-Safari asset pairs load fine on every tested engine (Chromium desktop,
  // both `webgpu` and `wasm` device paths) once script-src grants `blob:` (vite.config.ts,
  // P78's SECOND root cause — onnxruntime-web's WASM factory dynamically imports its own glue
  // module from a blob: URL) — this pairing itself is unchanged from P76/P77.
  const isSafari = detectIsSafariUserAgent()
  if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.wasmPaths = isSafari
      ? {
          mjs: `${ASSET_BASE}/ort/ort-wasm-simd-threaded.mjs`,
          wasm: `${ASSET_BASE}/ort/ort-wasm-simd-threaded.wasm`,
        }
      : {
          mjs: `${ASSET_BASE}/ort/ort-wasm-simd-threaded.asyncify.mjs`,
          wasm: `${ASSET_BASE}/ort/ort-wasm-simd-threaded.asyncify.wasm`,
        }
  }

  const processorResult = await loadProcessor()
  if (!processorResult.ok) {
    post({
      type: 'unavailable',
      reason: `processor load failed: ${processorResult.error}`,
      backendRequested,
      backendAttempts: { webgpu: 'not-attempted', wasm: 'not-attempted' },
      webgpuError: null,
      wasmError: null,
      processorLoad: 'failed',
      modelLoad: 'failed',
      indexLoad: 'not-reached',
    })
    return
  }

  // Backend selection itself is pure orchestration, delegated to
  // domain/scanner/visual-backend-selection.ts (prompt §3/§10, R2-R9) — see its own docs for the
  // fallback rules; this worker supplies the only two non-pure dependencies (real adapter
  // detection, real model load).
  const selection = await selectVisualBackend(backendRequested, {
    detectWebgpuAvailable,
    loadModel: loadModelOnBackend,
  })
  const { chosen, attempts, webgpuError, wasmError } = selection

  const backendDiagnostics: BackendDiagnostics = {
    backendRequested,
    backendAttempts: attempts,
    webgpuError,
    wasmError,
    processorLoad: 'success',
    modelLoad: chosen !== null ? 'success' : 'failed',
    indexLoad: 'not-reached',
  }

  if (chosen === null) {
    post({
      type: 'unavailable',
      reason: composeUnavailableReason(attempts, webgpuError, wasmError),
      ...backendDiagnostics,
    })
    return
  }
  backend = chosen

  const indexLoadStart = performance.now()
  index = await loadIndex().catch((error: unknown) => {
    lastIndexUnavailableReason = `index load threw: ${(error as Error).message}`
    return null
  })
  const indexLoadMs = Math.round(performance.now() - indexLoadStart)

  post({
    type: 'ready',
    ...backendDiagnostics,
    indexLoad: index !== null ? 'success' : 'failed',
    backend,
    indexAvailable: index !== null,
    cardCount: index?.cardIds.length ?? 0,
    modelColdLoadMs: Math.round(performance.now() - startedAt),
    indexVersion: index?.manifest.version ?? null,
    indexSourceProjectRef: index?.manifest.sourceProjectRef ?? null,
    indexLoadMs: index !== null ? indexLoadMs : null,
    indexUnavailableReason: index === null ? lastIndexUnavailableReason : null,
  })
}

/**
 * `@huggingface/transformers` v4.2.0 does not re-export its internal `apis` feature-detection
 * object from the package root (confirmed by inspecting the actual runtime module — only `env`
 * is exported), so this replicates its exact Safari check (same source) rather than depending on
 * an unavailable import.
 */
function detectIsSafariUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false
  const userAgent = navigator.userAgent
  const vendor = navigator.vendor || ''
  const isAppleVendor = vendor.indexOf('Apple') > -1
  const notOtherBrowser =
    !userAgent.match(/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i) &&
    !userAgent.includes('Chrome') &&
    !userAgent.includes('Android')
  return isAppleVendor && notOtherBrowser
}

async function embedAndSearch(message: EmbedAndSearchMessage): Promise<void> {
  if (!model || !processor) {
    post({ type: 'error', requestId: message.requestId, message: 'Visual model not initialized.' })
    return
  }
  try {
    const embedStart = performance.now()
    const image = new RawImage(
      new Uint8ClampedArray(bitmapToRgba(message.bitmap)),
      message.bitmap.width,
      message.bitmap.height,
      4,
    )
    const inputs = (await processor(image)) as Record<string, unknown>
    const output = (await model(inputs)) as { last_hidden_state: { data: ArrayLike<number> } }
    const raw = Float32Array.from(output.last_hidden_state.data).slice(0, EMBEDDING_DIM)
    // Norm of the RAW embedding, captured before l2Normalize mutates it in place — diagnostics
    // sanity signal only (prompt §40 EMBEDDING_NORM), never used in the actual search.
    let normSquared = 0
    for (let i = 0; i < raw.length; i += 1) normSquared += (raw[i] ?? 0) ** 2
    const embeddingNorm = Math.sqrt(normSquared)
    const queryVector = l2Normalize(raw)
    const embedMs = performance.now() - embedStart

    if (!index) {
      post({
        type: 'result',
        requestId: message.requestId,
        hits: [],
        embedMs,
        searchMs: 0,
        embeddingNorm,
      })
      return
    }
    const searchStart = performance.now()
    const hits = searchVisualIndex(index, queryVector, message.topK)
    const searchMs = performance.now() - searchStart
    post({
      type: 'result',
      requestId: message.requestId,
      hits: hits.map((h) => ({ cardId: h.cardId, similarity: h.similarity })),
      embedMs,
      searchMs,
      embeddingNorm,
    })
  } catch (error) {
    post({ type: 'error', requestId: message.requestId, message: (error as Error).message })
  } finally {
    message.bitmap.close()
  }
}

function bitmapToRgba(bitmap: ImageBitmap): ArrayBuffer {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('OffscreenCanvas 2D context unavailable in worker.')
  context.drawImage(bitmap, 0, 0)
  return context.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer
}

self.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const message = event.data
  if (message.type === 'init') {
    void init(message)
    return
  }
  void embedAndSearch(message)
})
