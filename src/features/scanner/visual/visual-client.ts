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
  readonly indexLoadMs: number | null
  readonly indexUnavailableReason: string | null
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
  /** Wall-clock duration of the FIRST successful `analyze()` round trip (P81 §3/§17
   *  FIRST_EMBED_MS) — the number that answers "once the model is warm, how fast is one actual
   *  scan," distinct from cold model/index load. Null until one real embed has completed. */
  private firstEmbedMs: number | null = null

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
      const result = await new Promise<VisualAnalysisResult>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject })
        worker.postMessage({ type: 'embed-and-search', requestId, bitmap, topK }, [bitmap])
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

  /** Diagnostics-only snapshot (prompt §40) — never affects matching, safe to read at any time
   *  including before `ensureReady()` has ever been called. */
  getDiagnosticsSnapshot(): {
    modelState: 'not-loaded' | 'loading' | 'ready' | 'failed'
    unavailableReason: string | null
    readyInfo: VisualReadyInfo | null
    backendDiagnostics: VisualBackendDiagnostics | null
    firstEmbedMs: number | null
  } {
    const modelState: 'not-loaded' | 'loading' | 'ready' | 'failed' =
      this.readyInfo !== null
        ? 'ready'
        : this.unavailableReason !== null
          ? 'failed'
          : this.readyPromise !== null
            ? 'loading'
            : 'not-loaded'
    return {
      modelState,
      unavailableReason: this.unavailableReason,
      readyInfo: this.readyInfo,
      backendDiagnostics: this.backendDiagnostics,
      firstEmbedMs: this.firstEmbedMs,
    }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.readyInfo = null
    this.readyPromise = null
    this.pending.clear()
  }
}
