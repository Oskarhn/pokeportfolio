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
import {
  classifyVisualAssetUrl,
  summarizeFetchLog,
  nonNetworkRemainder,
  type RecordedFetch,
  type VisualPhaseTimings,
  type VisualWorkerProgressPhase,
} from './phase-timing'

export type {
  VisualBackend,
  VisualBackendOverride,
  BackendAttemptStatus,
} from '../../../domain/scanner/visual-backend-selection'

const ASSET_BASE = '/scanner-assets/visual-v1'
/** P81 §8: a Cache-Storage-API cache this worker owns and reads/writes directly, INDEPENDENT of
 *  whether the page's Service Worker actually intercepts fetches issued from inside a dedicated
 *  Worker — a real cross-browser gap (historically, WebKit did not route Worker-issued fetches
 *  through the controlling Service Worker's fetch handler at all), so relying on SW runtime
 *  caching alone for THIS worker's own downloads is not safe to assume everywhere. Distinct name
 *  from the SW's `scanner-assets-visual-v1` cache (vite.config.ts) — this one is populated and
 *  read by worker code directly via the Cache Storage API, not by a `fetch` event handler. */
const WORKER_ASSET_CACHE_NAME = 'scanner-visual-worker-cache-v1'

/** Module-scope: the instant this worker's script began executing, in a form comparable across
 *  the main-thread/Worker boundary (P81 §3). `performance.now()` is relative to each context's
 *  OWN time origin, so a bare timestamp cannot be diffed against the main thread's clock — adding
 *  `performance.timeOrigin` (wall-clock-anchored in both contexts) makes it comparable. The client
 *  records the same absolute quantity immediately before constructing this Worker. */
const workerModuleEvalAtMs = performance.timeOrigin + performance.now()
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
  /** `performance.timeOrigin + performance.now()` at the instant the client constructed this
   *  Worker (P81 §3) — lets the worker report how long its own script fetch/parse/module-graph
   *  evaluation took (`workerStartMs`) before any application code below even ran. */
  constructedAtMs?: number
}
interface EmbedAndSearchMessage {
  type: 'embed-and-search'
  requestId: number
  bitmap: ImageBitmap
  topK: number
}
/** P84 §12: debug-only diagnostic lookup — "where did this specific card rank in the LAST scan's
 *  full-index search." Carries only a `cardId` (an opaque catalog identifier, not an image) and
 *  never triggers a new embedding — it re-ranks the query vector already computed by the most
 *  recent embed-and-search call. */
interface RankLookupMessage {
  type: 'rank-lookup'
  requestId: number
  cardId: string
}
type IncomingMessage = InitMessage | EmbedAndSearchMessage | RankLookupMessage

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
  /** P81 §3/§17: per-phase cold-start attribution — where the wall-clock time actually went. */
  phaseTimings: VisualPhaseTimings
}
interface UnavailableResponse extends BackendDiagnostics {
  type: 'unavailable'
  reason: string
  phaseTimings: VisualPhaseTimings
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
/** P84 §12: answers a debug-only rank-lookup request. `found=false` covers both "no scan has run
 *  yet this session" and "the index is unavailable" — the caller (visual-client.ts) never needs to
 *  distinguish those for display purposes, both simply mean "no answer available right now." */
interface RankLookupResultResponse {
  type: 'rank-lookup-result'
  requestId: number
  found: boolean
  rank: number | null
  similarity: number | null
  totalCards: number
}
/** P82 §2-§6: a live progress marker posted WHILE init() is still running — see phase-timing.ts's
 *  module doc for why this exists. `atMs` is `performance.timeOrigin + performance.now()`, the
 *  same cross-context-comparable quantity `workerModuleEvalAtMs`/`constructedAtMs` already use. */
interface ProgressResponse {
  type: 'progress'
  phase: VisualWorkerProgressPhase
  atMs: number
}
type OutgoingMessage =
  | ReadyResponse
  | UnavailableResponse
  | ResultResponse
  | ErrorResponse
  | ProgressResponse
  | RankLookupResultResponse

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
/** P84 §12: the most recent successful scan's L2-normalized query vector — 384 floats, never an
 *  image, never persisted beyond this worker's own memory, overwritten by every new scan. Exists
 *  ONLY so a debug-only rank-lookup request can re-rank against the FULL index without either
 *  re-embedding or widening every ordinary scan's own search depth (which stays bounded by
 *  whatever `topK` the caller requested, unaffected by this cache existing). */
let lastQueryVector: Float32Array | null = null

function post(message: OutgoingMessage, transfer: Transferable[] = []): void {
  ;(self as unknown as Worker).postMessage(message, transfer)
}

/** P82 §2-§6: posts one live progress marker. Never throws, never blocks init — a progress post
 *  is purely observational, so a hypothetical postMessage failure here must never take down the
 *  actual init sequence it is reporting on. */
function postProgress(phase: VisualWorkerProgressPhase): void {
  try {
    post({ type: 'progress', phase, atMs: performance.timeOrigin + performance.now() })
  } catch {
    // Observational only — see doc above.
  }
}

// P82 §5 (REQUIRED): the worker-boot signal fires the INSTANT module evaluation reaches
// application code — before AutoProcessor/AutoModel/the ORT WASM loader have been touched at all.
// If a real device never gets even this far, the main thread can tell "worker constructed but no
// boot message" (P82 §4) apart from "the worker booted but is stuck loading a specific asset."
postProgress('worker-module-evaluated')

// ---------------------------------------------------------------------------------------------
// P81 §3/§8: fetch instrumentation + explicit cache-through, installed only for the duration of
// one init() call. Every fetch this worker (or transformers.js/onnxruntime-web, which call the
// SAME global `fetch`) issues while installed is (a) served from this worker's own Cache Storage
// entry when one already exists — independent of Service Worker fetch interception, which is not
// guaranteed for Worker-issued requests on every engine — and (b) timed and classified by URL
// suffix so cold-start cost is attributable to a specific asset instead of one opaque total.
// Never touches the response BODY (only headers), so streaming WASM compilation
// (`WebAssembly.instantiateStreaming`) downstream is completely unaffected.
// ---------------------------------------------------------------------------------------------
let fetchLog: RecordedFetch[] = []
let originalFetch: typeof fetch | null = null
let workerAssetCache: Cache | null = null

async function getWorkerAssetCache(): Promise<Cache | null> {
  if (workerAssetCache !== null) return workerAssetCache
  if (typeof caches === 'undefined') return null
  try {
    workerAssetCache = await caches.open(WORKER_ASSET_CACHE_NAME)
    return workerAssetCache
  } catch {
    // Cache Storage can be unavailable (private-mode quirks, quota) — fetch still works normally,
    // this worker just loses the extra cache-through layer for that session (prompt §36 posture:
    // a missing optimization is never a hard failure).
    return null
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function installFetchProbe(): void {
  fetchLog = []
  if (originalFetch !== null) return
  originalFetch = self.fetch.bind(self)
  const realFetch = originalFetch
  ;(self as unknown as { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = requestUrl(input)
    const start = performance.now()
    const cache = await getWorkerAssetCache()
    if (
      cache !== null &&
      (init === undefined || init.method === undefined || init.method === 'GET')
    ) {
      const cached = await cache.match(input)
      if (cached !== undefined) {
        const ms = performance.now() - start
        const bytesHeader = cached.headers.get('content-length')
        fetchLog.push({
          phase: classifyVisualAssetUrl(url),
          ms,
          bytes: bytesHeader !== null ? Number(bytesHeader) : null,
        })
        return cached
      }
    }
    const response = await realFetch(input, init)
    const ms = performance.now() - start
    const bytesHeader = response.headers.get('content-length')
    fetchLog.push({
      phase: classifyVisualAssetUrl(url),
      ms,
      bytes: bytesHeader !== null ? Number(bytesHeader) : null,
    })
    if (cache !== null && response.ok && response.status === 200) {
      const toCache = response.clone()
      void cache.put(input, toCache).catch(() => {
        // Quota/opaque-response failures never block the real response reaching the caller.
      })
    }
    return response
  }
}

function uninstallFetchProbe(): RecordedFetch[] {
  if (originalFetch !== null) {
    ;(self as unknown as { fetch: typeof fetch }).fetch = originalFetch
    originalFetch = null
  }
  return fetchLog
}

/**
 * P81 §3/§4 — real-measurement correction found DURING this session, not assumed up front: a
 * benchmark run against this exact build (`pnpm scanner:visual:benchmark:cold-start`) showed the
 * `self.fetch` monkey-patch above (`installFetchProbe`) reliably times THIS worker's OWN fetches
 * (`loadIndex`'s manifest/card-ids/embeddings — plain, unqualified `fetch(...)` calls resolved at
 * CALL TIME) but reports 0ms/null-bytes for every fetch transformers.js/onnxruntime-web issue
 * internally for the processor config, model config, ONNX weights and ORT WASM/glue — strong
 * evidence those bundled libraries hold their OWN reference to `fetch`, captured at their module's
 * own top-level evaluation (which runs the instant this worker's script loads, before `init()` —
 * and therefore before `installFetchProbe()` — ever runs), so reassigning `self.fetch` later
 * cannot affect calls already bound to the original function object.
 *
 * The Resource Timing API sidesteps this cleanly: entries are recorded by the browser's network
 * stack itself, independent of which JS reference initiated the request, and Worker global scopes
 * have their own resource timing buffer for fetches THEY issue (same API as `window.performance`,
 * scoped to this worker). Read once, after every phase has settled, rather than trying to
 * subscribe live — the handful of entries this worker ever produces fit well inside every
 * browser's default buffer size (250+), so nothing is lost waiting until the end.
 */
function collectResourceTimingLog(): RecordedFetch[] {
  // `self.performance` is typed as always-present under the webworker lib, but feature-detect
  // getEntriesByType anyway — this function must degrade to "no data" rather than throw on any
  // engine whose Worker Performance implementation is more limited than the ambient types claim.
  if (typeof self.performance.getEntriesByType !== 'function') return []
  const entries = self.performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  return entries
    .filter((entry) => entry.name.includes(ASSET_BASE))
    .map((entry) => ({
      phase: classifyVisualAssetUrl(entry.name),
      ms: entry.duration,
      // transferSize is 0 for a response served without a real network transfer (HTTP cache OR
      // our own Cache Storage cache-through) per the Resource Timing spec — a strong, standard
      // cache signal, distinct from (and more reliable than) the byte/ms heuristic
      // estimateAssetCacheStatus falls back to when this API is unavailable. decodedBodySize is
      // the honest fallback for the CACHED case specifically (transferSize legitimately reads 0
      // there even though real bytes exist), never fabricated when both read 0 for a genuine
      // zero-byte edge case.
      bytes:
        entry.transferSize > 0
          ? entry.transferSize
          : entry.decodedBodySize > 0
            ? entry.decodedBodySize
            : null,
    }))
}

/** Restores the real `fetch` (always, for the side effect) and returns the best available
 *  network-timing log: Resource Timing when the browser exposes it (covers every fetch this
 *  worker's init issued, including the ones the fetch-probe cannot see — see
 *  `collectResourceTimingLog`'s own docs above), falling back to the fetch-probe's own log only if
 *  Resource Timing is unavailable in this environment. */
function finalizeFetchLog(): RecordedFetch[] {
  const probeLog = uninstallFetchProbe()
  const resourceLog = collectResourceTimingLog()
  return resourceLog.length > 0 ? resourceLog : probeLog
}

/**
 * Runtime manifest gate (P77 prompt §21): a manifest this browser's pin does not recognize, or
 * whose coverage numbers are internally impossible, must never be trusted — the visual channel
 * simply becomes unavailable and the scanner falls back to OCR + manual search (prompt §36),
 * never a crash. `lastIndexUnavailableReason` lets `init()` report WHY for the diagnostics panel
 * (prompt §40) without changing this function's null-on-failure contract.
 */
let lastIndexUnavailableReason: string | null = null
/** Set by loadIndex() each call (P81 §3) — the synchronous decode-only cost, separate from the
 *  network wait already visible in the fetch log. Module-scope like `lastIndexUnavailableReason`
 *  because loadIndex() has no other return channel for a "null on failure" contract it must keep. */
let lastIndexDecodeMs: number | null = null

async function loadIndex(): Promise<DecodedVisualIndex | null> {
  lastIndexUnavailableReason = null
  lastIndexDecodeMs = null
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
  postProgress('index-manifest-loaded')
  const [cardIdsResponse, embeddingsResponse] = await Promise.all([
    fetch(`${ASSET_BASE}/card-ids.json`),
    fetch(`${ASSET_BASE}/embeddings.bin`),
  ])
  if (!cardIdsResponse.ok || !embeddingsResponse.ok) {
    lastIndexUnavailableReason = 'card-ids.json or embeddings.bin fetch failed'
    return null
  }
  const cardIds = (await cardIdsResponse.json()) as string[]
  postProgress('index-ids-loaded')
  const embeddingsBuffer = new Int8Array(await embeddingsResponse.arrayBuffer())
  postProgress('index-embeddings-loaded')
  const decodeStart = performance.now()
  try {
    // Coverage sanity is defense-in-depth here (already asserted at generation time): a manifest
    // claiming cardsIndexed > totalCanonicalCards/cardsWithUsableImage (the 1224/1000 shape) or
    // whose id-list/manifest counts disagree must never be trusted, however it reached this asset
    // path.
    assertValidCoverage(manifest.coverage, cardIds.length, manifest.cardCount)
    const decoded = decodeVisualIndex(manifest, cardIds, embeddingsBuffer)
    lastIndexDecodeMs = Math.round(performance.now() - decodeStart)
    postProgress('index-decode-finished')
    return decoded
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

/** Builds the P81 §3 phase-timing report from the fetch log plus the wall-clock phase boundaries
 *  `init()` itself measured. Every *_FETCH_MS/BYTES field comes straight from an observed
 *  network/cache response; every non-network field (*_INIT_MS, decode, worker start) is either a
 *  directly-measured synchronous span or a wall-clock-minus-network remainder — never guessed. */
function buildPhaseTimings(
  log: readonly RecordedFetch[],
  wall: {
    workerConstructedAtMs: number | null
    processorWallMs: number
    backendWallMs: number
    indexDecodeMs: number | null
    visualReadyTotalMs: number
  },
): VisualPhaseTimings {
  const byPhase = summarizeFetchLog(log)
  const processorFetchMs = byPhase.processorConfig.ms
  const modelConfigFetchMs = byPhase.modelConfig.ms
  const modelOnnxFetchMs = byPhase.modelOnnx.ms
  const ortRuntimeFetchMs = byPhase.ortRuntime.ms
  const ortWasmFetchMs = byPhase.ortWasm.ms
  return {
    workerStartMs:
      wall.workerConstructedAtMs === null
        ? null
        : Math.round(workerModuleEvalAtMs - wall.workerConstructedAtMs),
    processorFetchMs: Math.round(processorFetchMs),
    processorInitMs: nonNetworkRemainder(wall.processorWallMs, processorFetchMs),
    modelConfigFetchMs: Math.round(modelConfigFetchMs),
    modelOnnxFetchMs: Math.round(modelOnnxFetchMs),
    modelOnnxBytes: byPhase.modelOnnx.bytes,
    ortRuntimeFetchMs: Math.round(ortRuntimeFetchMs),
    ortWasmFetchMs: Math.round(ortWasmFetchMs),
    ortWasmBytes: byPhase.ortWasm.bytes,
    // The compile/instantiate/session-create sequence happens entirely inside transformers.js's
    // AutoModel.from_pretrained → onnxruntime-web's InferenceSession.create, which this worker
    // does not fork or patch (P81 §3's own instruction) — so ORT_INIT_MS and
    // MODEL_SESSION_CREATE_MS are not independently observable and are reported COMBINED as the
    // backend-selection wall time minus every network/cache fetch attributed to it.
    modelCompileAndSessionCreateMs: nonNetworkRemainder(
      wall.backendWallMs,
      modelConfigFetchMs + modelOnnxFetchMs + ortRuntimeFetchMs + ortWasmFetchMs,
    ),
    indexManifestFetchMs: Math.round(byPhase.indexManifest.ms),
    indexIdsFetchMs: Math.round(byPhase.indexIds.ms),
    indexEmbeddingsFetchMs: Math.round(byPhase.indexEmbeddings.ms),
    indexEmbeddingsBytes: byPhase.indexEmbeddings.bytes,
    indexDecodeMs: wall.indexDecodeMs,
    visualReadyTotalMs: Math.round(wall.visualReadyTotalMs),
  }
}

async function init(message: InitMessage): Promise<void> {
  const startedAt = performance.now()
  const workerConstructedAtMs = message.constructedAtMs ?? null
  postProgress('init-received')
  installFetchProbe()
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
    // P81 §11: onnxruntime-web only enables real multi-threading when
    // `self.crossOriginIsolated` is true (requires COOP *and* COEP; this app currently sends
    // COOP only — see docs/SCANNER_RESEARCH.md §7d). Left unset, the "threaded" WASM binary
    // still loads correctly and ORT auto-detects the missing SharedArrayBuffer and runs
    // single-threaded — this line does not change behaviour, it makes that fallback an explicit,
    // version-independent decision instead of relying on the library's internal auto-detection,
    // and stops any pthread-pool bring-up attempt before it can start.
    env.backends.onnx.wasm.numThreads =
      typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? 4 : 1
  }

  postProgress('processor-load-started')
  const processorStart = performance.now()
  const processorResult = await loadProcessor()
  const processorWallMs = performance.now() - processorStart
  postProgress('processor-load-finished')
  if (!processorResult.ok) {
    const log = finalizeFetchLog()
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
      phaseTimings: buildPhaseTimings(log, {
        workerConstructedAtMs,
        processorWallMs,
        backendWallMs: 0,
        indexDecodeMs: null,
        visualReadyTotalMs: performance.now() - startedAt,
      }),
    })
    return
  }

  // Backend selection itself is pure orchestration, delegated to
  // domain/scanner/visual-backend-selection.ts (prompt §3/§10, R2-R9) — see its own docs for the
  // fallback rules; this worker supplies the only two non-pure dependencies (real adapter
  // detection, real model load), wrapped here (P82 §3) to post per-backend attempt progress
  // WITHOUT touching visual-backend-selection.ts's own pure signature/tests at all.
  postProgress('backend-selection-started')
  const backendStart = performance.now()
  const selection = await selectVisualBackend(backendRequested, {
    detectWebgpuAvailable,
    loadModel: async (device) => {
      postProgress(device === 'webgpu' ? 'webgpu-attempt-started' : 'wasm-attempt-started')
      const result = await loadModelOnBackend(device)
      postProgress(device === 'webgpu' ? 'webgpu-attempt-finished' : 'wasm-attempt-finished')
      return result
    },
  })
  const backendWallMs = performance.now() - backendStart
  postProgress('model-load-finished')
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
    const log = finalizeFetchLog()
    post({
      type: 'unavailable',
      reason: composeUnavailableReason(attempts, webgpuError, wasmError),
      ...backendDiagnostics,
      phaseTimings: buildPhaseTimings(log, {
        workerConstructedAtMs,
        processorWallMs,
        backendWallMs,
        indexDecodeMs: null,
        visualReadyTotalMs: performance.now() - startedAt,
      }),
    })
    return
  }
  backend = chosen

  postProgress('index-load-started')
  const indexLoadStart = performance.now()
  index = await loadIndex().catch((error: unknown) => {
    lastIndexUnavailableReason = `index load threw: ${(error as Error).message}`
    return null
  })
  const indexLoadMs = Math.round(performance.now() - indexLoadStart)
  const log = finalizeFetchLog()
  postProgress('ready')

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
    phaseTimings: buildPhaseTimings(log, {
      workerConstructedAtMs,
      processorWallMs,
      backendWallMs,
      indexDecodeMs: lastIndexDecodeMs,
      visualReadyTotalMs: performance.now() - startedAt,
    }),
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
    // P84 §12: cache for a possible later debug rank-lookup — see the module-scope doc comment.
    lastQueryVector = queryVector

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

/**
 * P84 §12: debug-only diagnostic — "where did EXPECTED_CARD_ID rank in the last scan's full-index
 * search." Re-ranks the cached `lastQueryVector` against the ENTIRE decoded index (never bounded
 * by any scan's own `topK`), which is cheap: `searchVisualIndex` is already a single O(cardCount)
 * brute-force pass (real-device evidence: ~16ms at 19,501 cards, prompt §0), so asking it for a
 * full ranking instead of a shortlist costs the same sort, just a longer returned/scanned array.
 * Never re-embeds, never triggers a new capture, never writes/persists anything — a pure read over
 * already-in-memory state.
 */
function rankLookup(message: RankLookupMessage): void {
  if (!index || !lastQueryVector) {
    post({
      type: 'rank-lookup-result',
      requestId: message.requestId,
      found: false,
      rank: null,
      similarity: null,
      totalCards: index?.cardIds.length ?? 0,
    })
    return
  }
  const hits = searchVisualIndex(index, lastQueryVector, index.cardIds.length)
  const position = hits.findIndex((hit) => hit.cardId === message.cardId)
  post({
    type: 'rank-lookup-result',
    requestId: message.requestId,
    found: position !== -1,
    rank: position === -1 ? null : position + 1,
    similarity: position === -1 ? null : (hits[position]?.similarity ?? null),
    totalCards: index.cardIds.length,
  })
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
  if (message.type === 'rank-lookup') {
    rankLookup(message)
    return
  }
  void embedAndSearch(message)
})
