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
import { AutoModel, AutoProcessor, RawImage, Tensor, env } from '@huggingface/transformers'
import { preprocessRgbaForDino } from '../../../domain/scanner/dino-preprocess'
import { assertValidCoverage, CoverageInvariantError } from '../../../domain/scanner/index-coverage'
import {
  selectVisualBackend,
  composeUnavailableReason,
  normalizeBackendOverride,
  type VisualBackend,
  type VisualBackendOverride,
  type BackendAttempts,
} from '../../../domain/scanner/visual-backend-selection'
import { detectIsSafariUserAgent } from './safari-detection'
import {
  decodeVisualIndex,
  searchVisualIndex,
  l2Normalize,
  VisualIndexError,
  type DecodedVisualIndex,
  type VisualIndexManifest,
  type VisualIndexPointer,
} from '../../../data/scanner/visual-index'
import {
  buildIndexContentPayload,
  truncateDigestHex,
  isWellFormedContentId,
} from '../../../domain/scanner/index-content-id'
import {
  deriveProjectIdentity,
  canonicalizeProjectIdentity,
  LOCAL_PROJECT_IDENTITY_SENTINEL,
} from '../../../domain/scanner/checkpoint-identity'
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
/** P87 F-01: the visual index's own subtree, distinct from the model/engine files that stay
 *  directly under {@link ASSET_BASE} (`model/`, `ort/`) — see current.json/generations/<id> below. */
const INDEX_BASE = `${ASSET_BASE}/index`
/** P87 F-22: which source project THIS deployment expects the index to resolve against, derived
 *  the same way `checkpoint-identity.ts` derives it for the generator — a project HOST string,
 *  never a secret (`VITE_SUPABASE_URL` carries no credential). `import.meta.env.VITE_SUPABASE_URL`
 *  is always defined in a real build (vite.config.ts refuses to build without it) but may be
 *  undefined in a raw unit-test environment that never ran through Vite's define step; treated the
 *  same as "no real hosted project configured" (never gated) in that case. */
const CONFIGURED_SUPABASE_URL: string | undefined = (
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env?.VITE_SUPABASE_URL
/** P94 N-13: an explicit, build-time override for the canonical project ref this deployment
 *  expects, for the case a hosted Supabase project is ever fronted by a custom domain (where
 *  deriving a ref from the URL's hostname would no longer work at all). Left unset in every build
 *  today — the standard `*.supabase.co` derivation below covers the real deployment. */
const CONFIGURED_PROJECT_REF: string | undefined = (
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env?.VITE_SUPABASE_PROJECT_REF
/** True when THIS deployment itself has no real hosted project configured — the local dev stack
 *  or CI's own placeholder build. Compares CANONICAL identities (P94 N-13), not raw strings: a
 *  local Supabase CLI reached via `localhost:54321` or `127.0.0.1:54321` (or any port a developer
 *  configured) must be recognized as local either way — the old exact-string comparison against
 *  `LOCAL_SUPABASE_URL` alone would wrongly treat a `localhost`-spelled local stack as "a real
 *  hosted deployment" and silently disable the visual channel. In that case there is nothing
 *  meaningful to gate the index's `sourceProjectRef` against, so the gate stays informational
 *  rather than rejecting (P87 §8's "do not destroy convenient local development" requirement). */
const IS_LOCAL_OR_UNCONFIGURED_DEPLOYMENT =
  CONFIGURED_SUPABASE_URL === undefined ||
  canonicalizeProjectIdentity(CONFIGURED_SUPABASE_URL) === LOCAL_PROJECT_IDENTITY_SENTINEL
/** The canonical ref this deployment expects the index's `sourceProjectRef` to resolve to (P94
 *  N-13): `VITE_SUPABASE_PROJECT_REF` when explicitly configured (the custom-domain escape
 *  hatch), otherwise derived from `VITE_SUPABASE_URL` and canonicalized — which strips the
 *  `.supabase.co` suffix, so this matches an EXISTING committed manifest's raw host-string
 *  `sourceProjectRef` (canonicalized the same way at comparison time below) without needing to
 *  regenerate it. */
const EXPECTED_SOURCE_PROJECT_REF = IS_LOCAL_OR_UNCONFIGURED_DEPLOYMENT
  ? null
  : (CONFIGURED_PROJECT_REF?.toLowerCase() ??
    canonicalizeProjectIdentity(deriveProjectIdentity(CONFIGURED_SUPABASE_URL)))
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
/** P90 §9: whether THIS worker context can convert an ImageBitmap to RGBA itself. Real Safari has
 *  shipped OffscreenCanvas + a 2D context inside Worker scopes since 16.4 (March 2023, the actual
 *  target platform per SCANNER_RESEARCH.md) — false is expected only on a genuinely older/unusual
 *  engine, never on this project's real target devices. Computed once at module scope (this cannot
 *  change mid-session) and reported to the client in the 'ready' message so it can choose the
 *  matching capture-conversion path BEFORE the first scan, not per-scan. */
const OFFSCREEN_CANVAS_AVAILABLE_IN_WORKER = typeof OffscreenCanvas !== 'undefined'

interface InitMessage {
  type: 'init'
  backendOverride?: VisualBackendOverride
  /** `performance.timeOrigin + performance.now()` at the instant the client constructed this
   *  Worker (P81 §3) — lets the worker report how long its own script fetch/parse/module-graph
   *  evaluation took (`workerStartMs`) before any application code below even ran. */
  constructedAtMs?: number
}
/** P90 §9: the two shapes a captured frame can arrive in. `bitmap` is the fast, default path
 *  (worker converts to RGBA itself via OffscreenCanvas, zero main-thread cost beyond the transfer).
 *  `rgba` is the fallback path used ONLY when {@link OFFSCREEN_CANVAS_AVAILABLE_IN_WORKER} is
 *  false — the client (which always has a real `<canvas>` element available, unlike a worker
 *  scope) does the identical RGBA conversion itself and transfers the raw buffer instead, so visual
 *  recognition keeps working rather than always degrading to OCR-only in a worker environment that
 *  lacks OffscreenCanvas. Never a second, duplicate conversion — exactly one canvas draw happens
 *  either way, just on whichever side can actually do it. */
type CapturedImage =
  | { kind: 'bitmap'; bitmap: ImageBitmap }
  | { kind: 'rgba'; buffer: ArrayBuffer; width: number; height: number }
interface EmbedAndSearchMessage {
  type: 'embed-and-search'
  requestId: number
  image: CapturedImage
  topK: number
}
/** Debug-only (P84, ported P87): re-rank the cached last query vector against the full index for
 *  one candidate card. The caller (visual-client.ts / controller.ts) is responsible for the
 *  `?scannerDebug=1` gate — this worker answers whatever it is asked, since it has no notion of
 *  "debug mode" itself; never triggered by production matching. */
interface GetExpectedRankMessage {
  type: 'get-expected-rank'
  requestId: number
  cardId: string
}
type IncomingMessage = InitMessage | EmbedAndSearchMessage | GetExpectedRankMessage

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
  /** P90 §9: whether this worker can convert a captured frame to RGBA itself. False tells the
   *  client to do that conversion on the main thread instead and transfer raw RGBA bytes for every
   *  subsequent {@link EmbedAndSearchMessage} — see `CapturedImage`'s own docs. */
  offscreenCanvasAvailableInWorker: boolean
  /** Diagnostics-only (prompt §40) — never used for match logic, only surfaced in the debug
   *  panel and never persisted. */
  indexVersion: string | null
  indexSourceProjectRef: string | null
  /** P87 §15: the loaded generation's own declared identity fields — makes a stale index
   *  impossible to hide from a screenshot/diagnostics paste, alongside indexContentId below. */
  indexModelRevision: string | null
  indexGeneratedAt: string | null
  indexEmbeddingsSha256: string | null
  /** P87 F-01: the content-addressed id of the generation actually loaded, or null if none. */
  indexContentId: string | null
  /** P87 F-22: this deployment's expected source project (null when unconfigured/local — nothing
   *  gated in that case), and whether the loaded index actually matched it. */
  indexSourceProjectExpected: string | null
  indexSourceProjectMatch: boolean | null
  /** P87 §6: whether the fetched embeddings bytes were independently re-hashed (WebCrypto
   *  SHA-256) and found to match `manifest.embeddingsSha256`, and how long that took. */
  indexRuntimeChecksumVerified: boolean | null
  indexRuntimeChecksumMs: number | null
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
/** Debug-only (P84, ported P87) response to {@link GetExpectedRankMessage}. */
interface ExpectedRankResponse {
  type: 'expected-rank'
  requestId: number
  found: boolean
  rank: number | null
  similarity: number | null
  totalCards: number
  inTop20: boolean
  inTop100: boolean
  indexContentId: string | null
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
  | ExpectedRankResponse

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
let indexContentId: string | null = null
/** P84, ported P87: the last scan's L2-normalized query vector, worker-memory only — never an
 *  image, never persisted, overwritten by every new embed-and-search call. Powers the debug-only
 *  {@link GetExpectedRankMessage} rank lookup without re-embedding. */
let lastQueryVector: Float32Array | null = null
let backend: VisualBackend = 'wasm'

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
    // P87 F-01/§4: a caller that explicitly asked for `cache: 'no-store'` (the index pointer,
    // `current.json`) must actually bypass BOTH the browser HTTP cache AND this worker's own
    // manual Cache-Storage cache-through — honoring only the former and silently serving a
    // previously cached copy from `workerAssetCache` here would defeat the whole point of the
    // no-store request. Every other fetch (model/engine files, and content-addressed generation
    // files, both genuinely immutable) keeps the existing cache-through behavior unchanged.
    const bypassCache = init?.cache === 'no-store'
    const cache = bypassCache ? null : await getWorkerAssetCache()
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
    if (!bypassCache && cache !== null && response.ok && response.status === 200) {
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
 * Runtime manifest gate (P77 prompt §21, hardened P87 F-01/F-22): a manifest this browser's pin
 * does not recognize, whose coverage numbers are internally impossible, whose content id does not
 * match what its own bytes hash to, or whose declared source project does not match what THIS
 * deployment expects, must never be trusted — the visual channel simply becomes unavailable and
 * the scanner falls back to OCR + manual search (prompt §36), never a crash. The
 * `lastIndex*`-prefixed module state lets `init()` report WHY/WHAT for the diagnostics panel
 * (prompt §40) without changing this function's null-on-failure contract.
 */
let lastIndexUnavailableReason: string | null = null
/** Set by loadIndex() each call (P81 §3) — the synchronous decode-only cost, separate from the
 *  network wait already visible in the fetch log. Module-scope like `lastIndexUnavailableReason`
 *  because loadIndex() has no other return channel for a "null on failure" contract it must keep. */
let lastIndexDecodeMs: number | null = null
let lastIndexRuntimeChecksumVerified: boolean | null = null
let lastIndexRuntimeChecksumMs: number | null = null
let lastIndexSourceProjectMatch: boolean | null = null

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function loadIndex(): Promise<DecodedVisualIndex | null> {
  lastIndexUnavailableReason = null
  lastIndexDecodeMs = null
  lastIndexRuntimeChecksumVerified = null
  lastIndexRuntimeChecksumMs = null
  lastIndexSourceProjectMatch = null
  indexContentId = null
  lastQueryVector = null

  // P87 F-01: fetch the tiny bootstrap pointer FIRST, explicitly bypassing every cache layer
  // (`cache: 'no-store'` skips this worker's own manual cache-through in `installFetchProbe` too
  // — see its check there — belt-and-suspenders alongside the `_headers` `no-cache` rule) so a
  // newly published generation is discoverable the moment a new scanner session starts, never
  // hidden behind a year-old immutable HTTP cache entry the way the old fixed-path design was.
  const pointerResponse = await fetch(`${INDEX_BASE}/current.json`, { cache: 'no-store' })
  if (!pointerResponse.ok) {
    lastIndexUnavailableReason = `current.json fetch failed (HTTP ${String(pointerResponse.status)})`
    return null
  }
  const pointer = (await pointerResponse.json()) as Partial<VisualIndexPointer>
  if (!isWellFormedContentId(pointer.contentId)) {
    lastIndexUnavailableReason = `current.json's contentId is not well-formed: ${String(pointer.contentId)}`
    return null
  }
  const contentId = pointer.contentId
  const generationBase = `${INDEX_BASE}/generations/${contentId}`

  const manifestResponse = await fetch(`${generationBase}/manifest.json`)
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
  // P87 F-22: source-project identity is now an enforceable gate at runtime, not just a logged
  // field — but ONLY when THIS deployment itself has a real hosted project configured (never in
  // local dev / CI's placeholder build, per EXPECTED_SOURCE_PROJECT_REF's own doc above).
  // P94 N-13: the manifest's stored value is canonicalized at COMPARISON time (never rewritten in
  // place — that would change the content-id hash of an already-published generation), so an
  // existing manifest's raw host string (`"nopmkroeygmlvndzjjqs.supabase.co"`) still matches a
  // canonical expectation (`"nopmkroeygmlvndzjjqs"`) without needing to regenerate the index.
  if (EXPECTED_SOURCE_PROJECT_REF !== null) {
    const manifestProjectIdentity =
      manifest.sourceProjectRef !== undefined
        ? canonicalizeProjectIdentity(manifest.sourceProjectRef)
        : undefined
    lastIndexSourceProjectMatch = manifestProjectIdentity === EXPECTED_SOURCE_PROJECT_REF
    if (!lastIndexSourceProjectMatch) {
      lastIndexUnavailableReason =
        `manifest sourceProjectRef "${String(manifest.sourceProjectRef)}" (canonical: ` +
        `"${String(manifestProjectIdentity)}") != expected "${EXPECTED_SOURCE_PROJECT_REF}" — ` +
        'refusing an index built against the wrong Supabase project.'
      return null
    }
  }
  postProgress('index-manifest-loaded')
  const [cardIdsResponse, embeddingsResponse] = await Promise.all([
    fetch(`${generationBase}/card-ids.json`),
    fetch(`${generationBase}/embeddings.bin`),
  ])
  if (!cardIdsResponse.ok || !embeddingsResponse.ok) {
    lastIndexUnavailableReason = 'card-ids.json or embeddings.bin fetch failed'
    return null
  }
  const cardIdsText = await cardIdsResponse.text()
  const cardIds = JSON.parse(cardIdsText) as string[]
  postProgress('index-ids-loaded')
  const embeddingsArrayBuffer = await embeddingsResponse.arrayBuffer()
  const embeddingsBuffer = new Int8Array(embeddingsArrayBuffer)
  postProgress('index-embeddings-loaded')

  // P87 F-01: the directory's own content id must equal what its content actually hashes to —
  // a defense-in-depth cross-check that a fetched trio genuinely belongs together and under the
  // URL it was published at, independent of decodeVisualIndex's own internal shape checks below.
  // WebCrypto (`crypto.subtle`) is always present under the webworker lib's own types — no
  // feature-detection guard, matching how this file already treats `performance`/`fetch` as
  // unconditionally available in this environment.
  {
    const payload = buildIndexContentPayload(
      manifest,
      new TextEncoder().encode(cardIdsText),
      new Uint8Array(embeddingsArrayBuffer),
    )
    const digest = await crypto.subtle.digest('SHA-256', payload)
    const actualContentId = truncateDigestHex(bufferToHex(digest))
    if (actualContentId !== contentId) {
      lastIndexUnavailableReason =
        `content id mismatch: published as ${contentId}, actual content hashes to ` +
        `${actualContentId} — refusing a generation whose own files disagree with its URL.`
      return null
    }
  }

  // P87 §6: independent runtime integrity check — re-hash the fetched embeddings bytes with
  // WebCrypto and compare against the manifest's own declared checksum, rather than merely
  // trusting that a byte-for-byte-identical field exists in the same JSON payload. Measured once
  // per newly loaded generation (here, at init), never repeated per scan.
  {
    const checksumStart = performance.now()
    const digest = await crypto.subtle.digest('SHA-256', embeddingsArrayBuffer)
    lastIndexRuntimeChecksumMs = Math.round(performance.now() - checksumStart)
    const actualSha256 = bufferToHex(digest)
    lastIndexRuntimeChecksumVerified = actualSha256 === manifest.embeddingsSha256
    if (!lastIndexRuntimeChecksumVerified) {
      lastIndexUnavailableReason =
        `embeddings.bin runtime checksum mismatch: manifest says ${manifest.embeddingsSha256}, ` +
        `actual ${actualSha256}.`
      return null
    }
  }

  const decodeStart = performance.now()
  try {
    // Coverage sanity is defense-in-depth here (already asserted at generation time): a manifest
    // claiming cardsIndexed > totalCanonicalCards/cardsWithUsableImage (the 1224/1000 shape) or
    // whose id-list/manifest counts disagree must never be trusted, however it reached this asset
    // path.
    assertValidCoverage(manifest.coverage, cardIds.length, manifest.cardCount)
    const decoded = decodeVisualIndex(manifest, cardIds, embeddingsBuffer)
    lastIndexDecodeMs = Math.round(performance.now() - decodeStart)
    indexContentId = contentId
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
    offscreenCanvasAvailableInWorker: OFFSCREEN_CANVAS_AVAILABLE_IN_WORKER,
    indexVersion: index?.manifest.version ?? null,
    indexSourceProjectRef: index?.manifest.sourceProjectRef ?? null,
    indexModelRevision: index?.manifest.modelRevision ?? null,
    indexGeneratedAt: index?.manifest.generatedAt ?? null,
    indexEmbeddingsSha256: index?.manifest.embeddingsSha256 ?? null,
    indexContentId,
    indexSourceProjectExpected: EXPECTED_SOURCE_PROJECT_REF,
    indexSourceProjectMatch: lastIndexSourceProjectMatch,
    indexRuntimeChecksumVerified: lastIndexRuntimeChecksumVerified,
    indexRuntimeChecksumMs: lastIndexRuntimeChecksumMs,
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
 * P96/D-107: `@huggingface/transformers`' own AutoProcessor path (the `OFFSCREEN_CANVAS_AVAILABLE_
 * IN_WORKER` branch below) unconditionally constructs an `OffscreenCanvas` internally during
 * resize/center-crop, REGARDLESS of whether this worker already has plain RGBA bytes — confirmed
 * by reading the installed bundle directly (`src/utils/image.js`'s `RawImage.resize`/
 * `.center_crop`, both gated on `apis.IS_WEB_ENV` with no non-canvas branch). P90's own main-thread
 * RGBA-conversion fallback (`capturedImageToRgba`, `visual-client.ts`) therefore only ever solved
 * HALF the real gap: it kept THIS worker from constructing an OffscreenCanvas itself, but the
 * library's own internal preprocessing still does, so `processor(image)` always throws
 * `OffscreenCanvas not supported by this environment.` on an engine that lacks it (D-105's own
 * correction, confirmed by running the real WebKit E2E spec — see docs/DECISIONS.md D-105/D-107).
 *
 * On such an engine, `processor(image)` is skipped entirely — never merely caught — in favor of
 * `preprocessRgbaForDino` (`src/domain/scanner/dino-preprocess.ts`), a canvas-free reimplementation
 * of the exact same pinned-model preprocessing that runs identically on every JS engine because it
 * touches nothing but typed arrays. Numerically verified against this exact AutoProcessor path
 * over a real card-image corpus — see `scripts/scanner-preprocess-parity/` and D-107 for the
 * measured cosine-similarity/retrieval-agreement evidence this substitution was accepted on. The
 * default, already-proven-at-scale OffscreenCanvas path is completely unchanged either way.
 */
async function runModelOnRgba(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<{ last_hidden_state: { data: ArrayLike<number> } }> {
  if (!model) throw new Error('Visual model not initialized.')
  if (OFFSCREEN_CANVAS_AVAILABLE_IN_WORKER) {
    if (!processor) throw new Error('Visual processor not initialized.')
    const image = new RawImage(buffer, width, height, 4)
    const inputs = (await processor(image)) as Record<string, unknown>
    return (await model(inputs)) as { last_hidden_state: { data: ArrayLike<number> } }
  }
  const preprocessed = preprocessRgbaForDino({ data: buffer, width, height })
  const pixel_values = new Tensor('float32', preprocessed.data, [1, ...preprocessed.dims])
  return (await model({ pixel_values })) as { last_hidden_state: { data: ArrayLike<number> } }
}

async function embedAndSearch(message: EmbedAndSearchMessage): Promise<void> {
  if (!model || !processor) {
    post({ type: 'error', requestId: message.requestId, message: 'Visual model not initialized.' })
    return
  }
  try {
    const embedStart = performance.now()
    const { buffer, width, height } = capturedImageToRgba(message.image)
    const output = await runModelOnRgba(new Uint8ClampedArray(buffer), width, height)
    const raw = Float32Array.from(output.last_hidden_state.data).slice(0, EMBEDDING_DIM)
    // Norm of the RAW embedding, captured before l2Normalize mutates it in place — diagnostics
    // sanity signal only (prompt §40 EMBEDDING_NORM), never used in the actual search.
    let normSquared = 0
    for (let i = 0; i < raw.length; i += 1) normSquared += (raw[i] ?? 0) ** 2
    const embeddingNorm = Math.sqrt(normSquared)
    const queryVector = l2Normalize(raw)
    const embedMs = performance.now() - embedStart
    // P84, ported P87: cache the query vector (memory only, overwritten every scan) so a debug
    // session can re-rank it against the full index afterward without re-embedding.
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
    if (message.image.kind === 'bitmap') message.image.bitmap.close()
  }
}

/**
 * F-31 (P89): a real-browser smoke test (tests/e2e/visual-worker-real-browser.spec.ts) caught
 * this throwing a raw, unattributable `ReferenceError: Can't find variable: OffscreenCanvas` on
 * Playwright's Windows-hosted WebKit build (26.5) specifically — real Safari has shipped
 * OffscreenCanvas + a 2D context inside Worker scopes since 16.4 (March 2023), and Playwright's
 * own docs disclose that its non-macOS WebKit builds are provided for cross-engine CI coverage
 * rather than guaranteed parity with Apple's shipped Safari, so this is most likely a
 * testing-environment gap rather than a genuine real-device regression — but it was NEVER
 * verified against a real Mac/iPhone from this session, so it is disclosed as unconfirmed, not
 * asserted safe.
 *
 * P90 §9: rather than stopping at a structured error, the client now feature-detects this SAME
 * gap before the first scan (via `offscreenCanvasAvailableInWorker` in the 'ready' message) and,
 * when true, converts every captured frame to RGBA on the main thread itself instead — the main
 * thread always has a real `<canvas>` element regardless of Worker OffscreenCanvas support, so
 * visual recognition keeps working end to end rather than silently degrading to OCR-only. This
 * function is therefore only ever reached with `message.image.kind === 'bitmap'` when the worker
 * DOES support OffscreenCanvas (the client's own fast-path default) — the `undefined` branch below
 * stays as defense-in-depth, never expected to fire given the client checks first.
 */
function capturedImageToRgba(image: CapturedImage): {
  buffer: ArrayBuffer
  width: number
  height: number
} {
  if (image.kind === 'rgba') return image
  const bitmap = image.bitmap
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is unavailable in this worker context.')
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('OffscreenCanvas 2D context unavailable in worker.')
  context.drawImage(bitmap, 0, 0)
  const { buffer } = context.getImageData(0, 0, bitmap.width, bitmap.height).data
  return { buffer, width: bitmap.width, height: bitmap.height }
}

/**
 * Debug-only (P84, ported P87): re-ranks the cached {@link lastQueryVector} against the FULL
 * decoded index for one candidate card, without re-embedding, re-fetching, or making a network
 * call of any kind. Pure read: never adds, saves, uploads, or persists anything. The caller
 * (visual-client.ts) is responsible for the `?scannerDebug=1` gate — this handler answers
 * unconditionally whatever it is asked, since production matching never sends this message type.
 */
function getExpectedRank(message: GetExpectedRankMessage): void {
  if (!index || !lastQueryVector) {
    post({
      type: 'expected-rank',
      requestId: message.requestId,
      found: false,
      rank: null,
      similarity: null,
      totalCards: index?.cardIds.length ?? 0,
      inTop20: false,
      inTop100: false,
      indexContentId,
    })
    return
  }
  const hits = searchVisualIndex(index, lastQueryVector, index.cardIds.length)
  const rankIndex = hits.findIndex((hit) => hit.cardId === message.cardId)
  const found = rankIndex !== -1
  const rank = found ? rankIndex + 1 : null
  post({
    type: 'expected-rank',
    requestId: message.requestId,
    found,
    rank,
    similarity: found ? (hits[rankIndex]?.similarity ?? null) : null,
    totalCards: index.cardIds.length,
    inTop20: rank !== null && rank <= 20,
    inTop100: rank !== null && rank <= 100,
    indexContentId,
  })
}

self.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const message = event.data
  if (message.type === 'init') {
    void init(message)
    return
  }
  if (message.type === 'get-expected-rank') {
    getExpectedRank(message)
    return
  }
  void embedAndSearch(message)
})
