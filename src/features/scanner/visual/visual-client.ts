/**
 * Main-thread handle to the visual-recognition worker (prompt §26/§27). Owns exactly one Worker
 * per scanner session: created lazily on the first `analyze()` call, reused for every subsequent
 * scan, terminated by `dispose()` on route exit. React never talks to the worker directly.
 *
 * Failure is always a graceful fallback (prompt §36): `analyze()` never throws for "visual
 * recognition isn't available right now" — it resolves to `null`, and the caller (controller.ts)
 * simply proceeds with OCR-only results, exactly as it did before this channel existed.
 */
import type { BackendAttemptStatus, VisualBackendOverride } from './visual-worker'
import type { VisualWorkerProgressPhase } from './phase-timing'

export interface VisualHit {
  readonly cardId: string
  readonly similarity: number
}

export interface VisualAnalysisResult {
  readonly hits: readonly VisualHit[]
  readonly backend: 'webgpu' | 'wasm'
  readonly embedMs: number
  readonly searchMs: number
  /** Diagnostics-only (prompt §40) — never affects matching. */
  readonly embeddingNorm: number
}

export type { VisualPhaseTimings } from './phase-timing'
import type { VisualPhaseTimings } from './phase-timing'

/** Backend-attempt diagnostics (P78 prompt §4/§11/§12) — present on BOTH a successful ready and
 *  an unavailable outcome, so the debug panel can always show what was actually tried. */
export interface VisualBackendDiagnostics {
  readonly backendRequested: VisualBackendOverride
  readonly backendAttempts: {
    readonly webgpu: BackendAttemptStatus
    readonly wasm: BackendAttemptStatus
  }
  readonly webgpuError: string | null
  readonly wasmError: string | null
  readonly processorLoad: 'success' | 'failed'
  readonly modelLoad: 'success' | 'failed'
  readonly indexLoad: 'success' | 'failed' | 'not-reached'
  readonly phaseTimings: VisualPhaseTimings
}

export interface VisualReadyInfo extends VisualBackendDiagnostics {
  readonly backend: 'webgpu' | 'wasm'
  readonly indexAvailable: boolean
  readonly cardCount: number
  readonly modelColdLoadMs: number
  /** Diagnostics-only (prompt §40/§56) fields describing the reference index itself. */
  readonly indexVersion: string | null
  readonly indexSourceProjectRef: string | null
  /** P87 §15: the loaded generation's own declared identity fields. */
  readonly indexModelRevision: string | null
  readonly indexGeneratedAt: string | null
  readonly indexEmbeddingsSha256: string | null
  /** P87 F-01: the content-addressed id of the generation actually loaded, or null if none. */
  readonly indexContentId: string | null
  /** P87 F-22: this deployment's expected source project (null when unconfigured/local), and
   *  whether the loaded index matched it. */
  readonly indexSourceProjectExpected: string | null
  readonly indexSourceProjectMatch: boolean | null
  /** P87 §6: whether the runtime SHA-256 re-hash of the fetched embeddings matched the manifest's
   *  own checksum, and how long that hash took. */
  readonly indexRuntimeChecksumVerified: boolean | null
  readonly indexRuntimeChecksumMs: number | null
  readonly indexLoadMs: number | null
  readonly indexUnavailableReason: string | null
  /** P90 §9: whether the worker itself can convert a captured frame to RGBA. False means every
   *  `analyze()` call converts on the main thread instead and transfers raw bytes — see
   *  {@link bitmapToRgbaOnMainThread}. */
  readonly offscreenCanvasAvailableInWorker: boolean
}

/** Debug-only (P84, ported P87) — mirrors {@link ExpectedCardRank} in contract.ts (kept as its
 *  own type here so this module stays independent of the feature-level contract). */
export interface ExpectedCardRank {
  readonly found: boolean
  readonly rank: number | null
  readonly similarity: number | null
  readonly totalCards: number
  readonly inTop20: boolean
  readonly inTop100: boolean
  readonly indexContentId: string | null
  /** P90 §21: hybrid (text + visual) ranking fields — filled in one layer up, in controller.ts,
   *  which is the only place that has access to the most recent scan's OCR signals/candidate pool.
   *  This class only ever produces the visual-only fields above; controller.ts's own
   *  getExpectedCardRank merges them in. Defaulted to null/empty here so a raw worker response
   *  (which never sets them) still satisfies this type. */
  readonly hybridRank: number | null
  readonly hybridScore: number | null
  readonly hybridTier: 'high' | 'medium' | 'low' | 'none' | null
  readonly scoreComponents: readonly string[]
}

type WorkerMessage =
  | ({ type: 'ready' } & VisualReadyInfo)
  | ({ type: 'unavailable'; reason: string } & VisualBackendDiagnostics)
  | {
      type: 'result'
      requestId: number
      hits: VisualHit[]
      embedMs: number
      searchMs: number
      embeddingNorm: number
    }
  | { type: 'error'; requestId: number; message: string }
  | { type: 'progress'; phase: VisualWorkerProgressPhase; atMs: number }
  | ({ type: 'expected-rank'; requestId: number } & ExpectedCardRank)

/** P82 §2-§6/§20: a live snapshot of the worker's most recent progress signal, kept even before
 *  ready/unavailable arrives — the gap that left every P81 phase-timing field as "—" during a real
 *  stalled init (the owner's real-iPhone report, P82 §0). */
export interface VisualLiveProgress {
  readonly workerBooted: boolean
  /** Time from Worker construction to the 'worker-module-evaluated' progress message, or null
   *  until that message has arrived — distinguishes a worker that never even finished loading its
   *  OWN script/module graph from one that booted but is stuck inside a later phase. */
  readonly workerBootMs: number | null
  /** Most recent progress phase name, or null if no progress message has arrived at all yet
   *  (`WORKER_CONSTRUCTED_BUT_NO_BOOT_MESSAGE`, P82 §4). */
  readonly currentPhase: VisualWorkerProgressPhase | null
  /** Milliseconds since the CURRENT phase was entered (i.e. since its progress message arrived) —
   *  computed live at read time from `performance.now()`, never a stored/cached duration. */
  readonly currentPhaseElapsedMs: number | null
  /** Milliseconds since the most recent progress message of ANY kind arrived — identical to
   *  `currentPhaseElapsedMs` today (a progress message always marks entering a new phase), kept as
   *  its own named field because the prompt's diagnostics contract asks for both labels. */
  readonly lastProgressMsAgo: number | null
}

/**
 * P90 §9: main-thread fallback conversion, used ONLY when the worker itself reported
 * `offscreenCanvasAvailableInWorker: false` in its 'ready' message. The main thread always has a
 * real canvas available — `OffscreenCanvas` when present (identical code path to the worker's own
 * conversion), otherwise a plain `<canvas>` element, which every browser that can run this app at
 * all supports — so visual recognition keeps working end to end instead of the worker's own
 * structured 'error' response silently degrading every scan to OCR-only. Exactly one canvas draw
 * either way (here or in the worker) — never a duplicate conversion of the same frame.
 */
function bitmapToRgbaOnMainThread(bitmap: ImageBitmap): {
  buffer: ArrayBuffer
  width: number
  height: number
} {
  let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (typeof OffscreenCanvas !== 'undefined') {
    context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    context = canvas.getContext('2d')
  }
  if (!context) throw new Error('No 2D canvas context available on the main thread.')
  context.drawImage(bitmap, 0, 0)
  const { buffer } = context.getImageData(0, 0, bitmap.width, bitmap.height).data
  return { buffer, width: bitmap.width, height: bitmap.height }
}

/** Reads the diagnostic-only `?visualBackend=` override (prompt §5) exactly once per client
 *  instance — the value the worker actually used for THIS session, not re-read per scan. Absent
 *  or invalid always means `auto`; this never affects matching, persistence or authentication. */
function readBackendOverrideFromLocation(): VisualBackendOverride {
  if (typeof window === 'undefined') return 'auto'
  const raw = new URLSearchParams(window.location.search).get('visualBackend')
  return raw === 'wasm' || raw === 'webgpu' ? raw : 'auto'
}

export class VisualRecognitionClient {
  private worker: Worker | null = null
  private readyInfo: VisualReadyInfo | null = null
  private unavailableReason: string | null = null
  /** Backend-attempt diagnostics from whichever message (ready OR unavailable) arrived last —
   *  kept separately from `readyInfo` so a failed init still exposes what was actually tried. */
  private backendDiagnostics: VisualBackendDiagnostics | null = null
  private readyPromise: Promise<VisualReadyInfo | null> | null = null
  private nextRequestId = 1
  private pending = new Map<
    number,
    { resolve: (r: VisualAnalysisResult) => void; reject: (e: Error) => void }
  >()
  /** P84, ported P87: pending debug-only rank-lookup requests, kept separate from `pending`
   *  (real analyze() calls) since they resolve a different response shape and never reject —
   *  see {@link getExpectedCardRank}. */
  private pendingRankRequests = new Map<number, (r: ExpectedCardRank) => void>()
  /** Wall-clock duration of the FIRST successful `analyze()` round trip (P81 §3/§17
   *  FIRST_EMBED_MS) — the number that answers "once the model is warm, how fast is one actual
   *  scan," distinct from cold model/index load. Null until one real embed has completed. */
  private firstEmbedMs: number | null = null
  /** P82 §2-§6: live progress bookkeeping, updated as 'progress' messages arrive — see
   *  {@link VisualLiveProgress}'s own docs for what each field answers. `constructedAtMs` is
   *  recorded once per Worker construction (see `ensureReady()`) so `workerBootMs` can be computed
   *  the moment the boot message arrives. */
  private constructedAtMs: number | null = null
  private workerBooted = false
  private workerBootMs: number | null = null
  private currentPhase: VisualWorkerProgressPhase | null = null
  private currentPhaseAtMs: number | null = null

  /**
   * Explicit prewarm entry point (P81 §6): begins worker/model/index loading in the background
   * WITHOUT a captured frame. A thin, clearly-named alias over {@link ensureReady} — identical
   * idempotency (safe to call repeatedly; concurrent/later callers share the same in-flight or
   * settled promise), never throws, never fabricates an embedding, uploads nothing. Named
   * separately from `ensureReady` so callers that only want to START warming (route entry) read
   * differently from callers that need to actually USE the result (a real scan).
   */
  async prewarm(): Promise<VisualReadyInfo | null> {
    return this.ensureReady()
  }

  /** Lazily creates the worker and waits for it to report ready/unavailable. Safe to call
   *  repeatedly — subsequent calls return the same in-flight/settled promise. */
  async ensureReady(): Promise<VisualReadyInfo | null> {
    if (this.unavailableReason !== null) return null
    if (this.readyInfo !== null) return this.readyInfo
    if (this.readyPromise !== null) return this.readyPromise

    this.readyPromise = new Promise((resolve) => {
      try {
        // P81 §3: recorded in a form comparable to the worker's OWN `performance.timeOrigin +
        // performance.now()` (each context's `performance.now()` alone is relative to a
        // different time origin) so `workerStartMs` can measure real script fetch/parse/eval
        // cost instead of a meaningless cross-context diff.
        const constructedAtMs = performance.timeOrigin + performance.now()
        this.constructedAtMs = constructedAtMs
        const worker = new Worker(new URL('./visual-worker.ts', import.meta.url), {
          type: 'module',
        })
        this.worker = worker
        worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
          this.handleMessage(event.data, resolve)
        })
        // Only Worker-API-exposed fields (prompt §12): message/filename/lineno/colno. Never a
        // stack trace or anything from the event's error object, which can carry data this
        // worker never intentionally posted.
        worker.addEventListener('error', (event: ErrorEvent) => {
          const location =
            event.filename !== ''
              ? ` at ${event.filename}:${String(event.lineno)}:${String(event.colno)}`
              : ''
          this.unavailableReason = `Visual recognition worker crashed: ${event.message || 'unknown error'}${location}`
          resolve(null)
        })
        worker.postMessage({
          type: 'init',
          backendOverride: readBackendOverrideFromLocation(),
          constructedAtMs,
        })
      } catch {
        this.unavailableReason = 'Web Workers are unavailable in this browser.'
        resolve(null)
      }
    })
    return this.readyPromise
  }

  private handleMessage(
    message: WorkerMessage,
    resolveReady: (r: VisualReadyInfo | null) => void,
  ): void {
    if (message.type === 'progress') {
      this.currentPhase = message.phase
      this.currentPhaseAtMs = message.atMs
      if (message.phase === 'worker-module-evaluated') {
        this.workerBooted = true
        this.workerBootMs =
          this.constructedAtMs === null
            ? null
            : Math.max(0, Math.round(message.atMs - this.constructedAtMs))
      }
      return
    }
    if (message.type === 'ready') {
      this.readyInfo = message
      this.backendDiagnostics = message
      resolveReady(this.readyInfo)
      return
    }
    if (message.type === 'unavailable') {
      this.unavailableReason = message.reason
      this.backendDiagnostics = message
      resolveReady(null)
      return
    }
    if (message.type === 'result') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      pending.resolve({
        hits: message.hits,
        backend: this.readyInfo?.backend ?? 'wasm',
        embedMs: message.embedMs,
        searchMs: message.searchMs,
        embeddingNorm: message.embeddingNorm,
      })
      return
    }
    if (message.type === 'expected-rank') {
      const resolve = this.pendingRankRequests.get(message.requestId)
      if (!resolve) return
      this.pendingRankRequests.delete(message.requestId)
      resolve({
        found: message.found,
        rank: message.rank,
        similarity: message.similarity,
        totalCards: message.totalCards,
        inTop20: message.inTop20,
        inTop100: message.inTop100,
        indexContentId: message.indexContentId,
        // P90 §21: this class only ever answers the visual-only question — controller.ts's own
        // getExpectedCardRank fills these in from the most recent scan's hybrid evidence.
        hybridRank: null,
        hybridScore: null,
        hybridTier: null,
        scoreComponents: [],
      })
      return
    }
    // Only 'error' remains after the branches above have returned.
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    pending.reject(new Error(message.message))
  }

  /** Embeds one captured frame and returns the top-K visual matches, or null if the visual
   *  channel is unavailable for any reason (no model, no index, worker crash) — never throws. */
  async analyze(bitmap: ImageBitmap, topK: number): Promise<VisualAnalysisResult | null> {
    const ready = await this.ensureReady()
    if (ready === null || !ready.indexAvailable || this.worker === null) {
      bitmap.close()
      return null
    }
    const worker = this.worker
    const requestId = this.nextRequestId
    this.nextRequestId += 1
    const embedCallStart = performance.now()
    try {
      // P90 §9: the worker reports once, at 'ready' time, whether it can convert a captured frame
      // to RGBA itself. When it cannot, convert here instead (the main thread always has a real
      // canvas) and transfer raw bytes rather than the ImageBitmap — same information, same
      // single conversion, just done on whichever side actually supports it.
      const result = await new Promise<VisualAnalysisResult>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject })
        if (ready.offscreenCanvasAvailableInWorker) {
          worker.postMessage(
            { type: 'embed-and-search', requestId, image: { kind: 'bitmap', bitmap }, topK },
            [bitmap],
          )
        } else {
          const { buffer, width, height } = bitmapToRgbaOnMainThread(bitmap)
          bitmap.close()
          worker.postMessage(
            {
              type: 'embed-and-search',
              requestId,
              image: { kind: 'rgba', buffer, width, height },
              topK,
            },
            [buffer],
          )
        }
      })
      // P81 §3/§17 FIRST_EMBED_MS: the first successful round trip only — this is the number
      // that answers "once warm, how fast is one real scan," which cold `modelColdLoadMs` alone
      // never told the owner.
      if (this.firstEmbedMs === null) this.firstEmbedMs = performance.now() - embedCallStart
      return result
    } catch {
      return null
    }
  }

  /**
   * Debug-only (P84, ported P87): re-ranks the most recent {@link analyze} call's query vector
   * against the full visual index for `cardId`, without re-embedding, re-fetching or making a
   * network call. Never throws. Returns `null` when the worker was never constructed (a rank
   * lookup must never itself trigger `ensureReady()`/worker construction — this is a read over
   * whatever is ALREADY in memory, not a reason to start loading the model).
   *
   * Debug-mode gating happens ONE LAYER UP, in controller.ts — this method answers unconditionally
   * whatever it is asked; controller.ts's own wrapper is what resolves `null` outside
   * `?scannerDebug=1` without ever calling this method at all.
   */
  async getExpectedCardRank(cardId: string): Promise<ExpectedCardRank | null> {
    if (this.worker === null) return null
    const worker = this.worker
    const requestId = this.nextRequestId
    this.nextRequestId += 1
    return new Promise<ExpectedCardRank>((resolve) => {
      this.pendingRankRequests.set(requestId, resolve)
      worker.postMessage({ type: 'get-expected-rank', requestId, cardId })
    })
  }

  /** Diagnostics-only snapshot (prompt §40) — never affects matching, safe to read at any time
   *  including before `ensureReady()` has ever been called. */
  getDiagnosticsSnapshot(): {
    modelState: 'not-loaded' | 'loading' | 'ready' | 'failed'
    unavailableReason: string | null
    readyInfo: VisualReadyInfo | null
    backendDiagnostics: VisualBackendDiagnostics | null
    firstEmbedMs: number | null
    liveProgress: VisualLiveProgress
  } {
    const modelState: 'not-loaded' | 'loading' | 'ready' | 'failed' =
      this.readyInfo !== null
        ? 'ready'
        : this.unavailableReason !== null
          ? 'failed'
          : this.readyPromise !== null
            ? 'loading'
            : 'not-loaded'
    const now = performance.timeOrigin + performance.now()
    const elapsedSinceCurrentPhase =
      this.currentPhaseAtMs === null ? null : Math.max(0, Math.round(now - this.currentPhaseAtMs))
    return {
      modelState,
      unavailableReason: this.unavailableReason,
      readyInfo: this.readyInfo,
      backendDiagnostics: this.backendDiagnostics,
      firstEmbedMs: this.firstEmbedMs,
      liveProgress: {
        workerBooted: this.workerBooted,
        workerBootMs: this.workerBootMs,
        currentPhase: this.currentPhase,
        currentPhaseElapsedMs: elapsedSinceCurrentPhase,
        lastProgressMsAgo: elapsedSinceCurrentPhase,
      },
    }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.readyInfo = null
    this.readyPromise = null
    this.pending.clear()
    this.pendingRankRequests.clear()
    this.workerBooted = false
    this.workerBootMs = null
    this.currentPhase = null
    this.currentPhaseAtMs = null
    this.constructedAtMs = null
  }
}
