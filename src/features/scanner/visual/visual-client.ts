/**
 * Main-thread handle to the visual-recognition worker (prompt §26/§27). Owns exactly one Worker
 * per scanner session: created lazily on the first `analyze()` call, reused for every subsequent
 * scan, terminated by `dispose()` on route exit. React never talks to the worker directly.
 *
 * Failure is always a graceful fallback (prompt §36): `analyze()` never throws for "visual
 * recognition isn't available right now" — it resolves to `null`, and the caller (controller.ts)
 * simply proceeds with OCR-only results, exactly as it did before this channel existed.
 */
export interface VisualHit {
  readonly cardId: string
  readonly similarity: number
}

export interface VisualAnalysisResult {
  readonly hits: readonly VisualHit[]
  readonly backend: 'webgpu' | 'wasm'
  readonly embedMs: number
  readonly searchMs: number
}

export interface VisualReadyInfo {
  readonly backend: 'webgpu' | 'wasm'
  readonly indexAvailable: boolean
  readonly cardCount: number
  readonly modelColdLoadMs: number
}

type WorkerMessage =
  | {
      type: 'ready'
      backend: 'webgpu' | 'wasm'
      indexAvailable: boolean
      cardCount: number
      modelColdLoadMs: number
    }
  | { type: 'unavailable'; reason: string }
  | { type: 'result'; requestId: number; hits: VisualHit[]; embedMs: number; searchMs: number }
  | { type: 'error'; requestId: number; message: string }

export class VisualRecognitionClient {
  private worker: Worker | null = null
  private readyInfo: VisualReadyInfo | null = null
  private unavailableReason: string | null = null
  private readyPromise: Promise<VisualReadyInfo | null> | null = null
  private nextRequestId = 1
  private pending = new Map<
    number,
    { resolve: (r: VisualAnalysisResult) => void; reject: (e: Error) => void }
  >()

  /** Lazily creates the worker and waits for it to report ready/unavailable. Safe to call
   *  repeatedly — subsequent calls return the same in-flight/settled promise. */
  async ensureReady(): Promise<VisualReadyInfo | null> {
    if (this.unavailableReason !== null) return null
    if (this.readyInfo !== null) return this.readyInfo
    if (this.readyPromise !== null) return this.readyPromise

    this.readyPromise = new Promise((resolve) => {
      try {
        const worker = new Worker(new URL('./visual-worker.ts', import.meta.url), {
          type: 'module',
        })
        this.worker = worker
        worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
          this.handleMessage(event.data, resolve)
        })
        worker.addEventListener('error', () => {
          this.unavailableReason = 'Visual recognition worker failed to start.'
          resolve(null)
        })
        worker.postMessage({ type: 'init' })
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
      this.readyInfo = {
        backend: message.backend,
        indexAvailable: message.indexAvailable,
        cardCount: message.cardCount,
        modelColdLoadMs: message.modelColdLoadMs,
      }
      resolveReady(this.readyInfo)
      return
    }
    if (message.type === 'unavailable') {
      this.unavailableReason = message.reason
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
    try {
      return await new Promise<VisualAnalysisResult>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject })
        worker.postMessage({ type: 'embed-and-search', requestId, bitmap, topK }, [bitmap])
      })
    } catch {
      return null
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
