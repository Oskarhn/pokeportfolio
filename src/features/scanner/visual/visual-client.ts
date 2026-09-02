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
  | { type: 'progress'; phase: VisualWorkerProgressPhase; atMs: number }
  | {
      type: 'rank-lookup-result'
      requestId: number
      found: boolean
      rank: number | null
      similarity: number | null
      totalCards: number
    }

/** P84 §12: result of a debug-only "where does this specific card rank" lookup. `found=false`
 *  covers both "no scan has happened yet this session" and "the card is genuinely outside the
 *  index" — the caller does not need finer detail than "no rank available" for either. */
export interface ExpectedCardRank {
  readonly found: boolean
  readonly rank: number | null
  readonly similarity: number | null
  readonly totalCards: number
  readonly inTop20: boolean
  readonly inTop100: boolean
}

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
  /** P84 §12: separate request map for rank-lookup round trips — distinct response shape from
   *  `pending`, and rank lookups never transfer/close a bitmap, so keeping them apart avoids any
   *  risk of the two request kinds' resolve signatures being confused. */
  private pendingRankLookups = new Map<number, (r: ExpectedCardRank) => void>()
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
    if (message.type === 'rank-lookup-result') {
      const resolveRank = this.pendingRankLookups.get(message.requestId)
      if (!resolveRank) return
      this.pendingRankLookups.delete(message.requestId)
      resolveRank({
        found: message.found,
        rank: message.rank,
        similarity: message.similarity,
        totalCards: message.totalCards,
        inTop20: message.rank !== null && message.rank <= 20,
        inTop100: message.rank !== null && message.rank <= 100,
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

  /**
   * P84 §12: debug-only diagnostic — "where does EXPECTED_CARD_ID rank against the LAST scan's
   * full-index search." Resolves `null` when no scan has happened yet this session or the visual
   * channel is unavailable (worker never constructed) — never throws, never triggers a new
   * embedding, never uploads or persists anything (a single small request/response round trip to
   * a Worker this tab already owns). Callers are expected to gate this behind their own debug-mode
   * check (this method itself has no opinion on that — `controller.ts` owns the gate).
   */
  async getExpectedCardRank(cardId: string): Promise<ExpectedCardRank | null> {
    if (this.worker === null) return null
    const worker = this.worker
    const requestId = this.nextRequestId
    this.nextRequestId += 1
    return new Promise((resolve) => {
      this.pendingRankLookups.set(requestId, resolve)
      worker.postMessage({ type: 'rank-lookup', requestId, cardId })
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
    this.pendingRankLookups.clear()
    this.workerBooted = false
    this.workerBootMs = null
    this.currentPhase = null
    this.currentPhaseAtMs = null
    this.constructedAtMs = null
  }
}
