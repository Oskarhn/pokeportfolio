/**
 * The scanner's OCR engine wrapper (prompt §5/§8). The ONLY module in the repository that
 * imports tesseract.js — and it does so DYNAMICALLY, so the library never enters the main
 * bundle: nothing loads until the first analysis of a scanner session actually needs it.
 *
 * Lifecycle rules (prompt §8): ONE engine instance per active scanner session, owned by the
 * controller; the worker is created lazily on the first recognition request, reused across
 * every scan in the session, and terminated on route exit (`dispose`). Never one worker per
 * card. No raw OCR text or progress detail is logged anywhere.
 *
 * Asset supply (prompt §6): every runtime asset comes from THIS origin under
 * /scanner-assets/v7/ (staged from pinned npm packages by scripts/prepare-scanner-assets.mjs).
 * No CDN is ever contacted at runtime. `workerBlobURL: false` makes the Worker construct
 * directly from the same-origin script URL (CSP worker-src 'self' holds; NOTE: WASM compilation
 * in the deployed app additionally requires the 'wasm-unsafe-eval' CSP exception — P69's PR,
 * deliberately NOT added here).
 */

/** Same-origin directory holding the staged v7 assets (see scripts/prepare-scanner-assets.mjs). */
export const SCANNER_ASSET_BASE = '/scanner-assets/v7'

export interface OcrResult {
  text: string
  /** Tesseract's mean word confidence for the result, 0–100; informational only. */
  confidence: number
}

interface TesseractWorker {
  recognize(
    image: unknown,
    options?: { rectangle?: { left: number; top: number; width: number; height: number } },
  ): Promise<{ data: { text: string; confidence: number } }>
  setParameters(params: Record<string, string>): Promise<unknown>
  terminate(): Promise<unknown>
}

/** Page segmentation mode for one recognition call: strips read best as single lines; the
 *  full-card fallback reads best in auto layout mode. `multi-line` (PSM 6, "uniform block of
 *  text") is a P85 §3/§7 addition, used ONLY as a bounded third pass for the collector-number
 *  field — real-corpus forensics (docs/SCANNER_RESEARCH.md §7f) found that a correctly-cropped
 *  number strip routinely shares its visual line with an illustrator credit or copyright line
 *  (a real, common template shape, not a rare edge case), which `single-line` (PSM 7)
 *  structurally cannot read at all because it assumes exactly one line and mis-segments a
 *  genuinely two-line crop; PSM 6 reads the whole block instead, and the id is then extracted
 *  from whichever line actually parses as one (analyze.ts's `extractCollectorNumberLine`). */
export type OcrSegmentation = 'single-line' | 'auto' | 'multi-line'

const SEGMENTATION_VALUES = { 'single-line': '7', auto: '3', 'multi-line': '6' } as const

export class ScannerEngineError extends Error {
  constructor() {
    super('The card reader could not start on this device.')
    this.name = 'ScannerEngineError'
  }
}

export class ScannerEngineDisposedError extends Error {
  constructor() {
    super('The card reader was closed.')
    this.name = 'ScannerEngineDisposedError'
  }
}

export class ScannerOcrEngine {
  private worker: TesseractWorker | null = null
  private preparing: Promise<TesseractWorker> | null = null
  private disposed = false
  /** P82 §16-§19: set true only when a `prepare()` attempt actually threw — distinguishes a
   *  genuinely failed OCR cold start from "never attempted"/"still in flight", which `started`
   *  alone cannot (both `preparing` and `worker` end up falsy either way). Cleared at the start of
   *  every new `prepare()` attempt so a later retry can succeed cleanly. */
  private lastPrepareFailed = false
  /** F-15 (P89): serializes `setParameters`+`recognize` as one logical operation — two
   *  `recognize()` calls on the SAME engine instance must never interleave (call A's
   *  segmentation-mode `setParameters` clobbered by call B's before A's `recognize` reads it is
   *  the concrete hazard). A plain promise-chaining mutex: each call waits for the PREVIOUS
   *  call's full settlement (success or failure) before starting its own. Not reachable through
   *  the shipped UI today (the scanner state machine already serializes analysis calls) —
   *  defensive against any future caller that invokes `recognize()` twice concurrently. */
  private recognizeQueue: Promise<unknown> = Promise.resolve()
  /** F-14 (P89): rejecters for every currently in-flight `recognize()` call, so `dispose()` can
   *  bound them instead of trusting tesseract.js's own worker-termination semantics to settle a
   *  pending recognition promise (unverified upstream behaviour — see the class's own `dispose`
   *  doc). */
  private disposalRejecters = new Set<(reason: unknown) => void>()

  /** True once preparation has begun (used for honest "Preparing scanner…" copy on first use). */
  get started(): boolean {
    return this.preparing !== null || this.worker !== null
  }

  /** P82 §16-§19: coarse readiness state for the FAST (OCR) baseline — this is what the intro
   *  screen's honest loading copy should gate on instead of the heavyweight DINO channel, since
   *  Tesseract's ~10MB cold download is a small fraction of DINO's ~45MB one and (unlike a
   *  perceptual-hash retrieval channel this session evaluated and rejected — see
   *  docs/SCANNER_RESEARCH.md §7e) already provides real, evidence-backed identification signal. */
  getState(): 'not-loaded' | 'loading' | 'ready' | 'failed' {
    if (this.worker !== null) return 'ready'
    if (this.preparing !== null) return 'loading'
    if (this.lastPrepareFailed) return 'failed'
    return 'not-loaded'
  }

  /**
   * Creates/returns the session worker. Lazy: the tesseract.js module is imported only when the
   * first analysis calls this. Idempotent and race-safe (concurrent callers share one prepare;
   * a failed cold start can be retried later).
   */
  async prepare(): Promise<void> {
    if (this.disposed) throw new ScannerEngineDisposedError()
    if (this.worker !== null) return
    if (this.preparing !== null) return this.preparing.then(() => undefined)
    this.lastPrepareFailed = false
    const creating = this.createWorker()
    this.preparing = creating
    try {
      this.worker = await creating
    } catch (error) {
      this.lastPrepareFailed = true
      throw error instanceof ScannerEngineError ? error : new ScannerEngineError()
    } finally {
      if (this.preparing === creating) this.preparing = null
    }
  }

  private async createWorker(): Promise<TesseractWorker> {
    try {
      const { createWorker, OEM } = await import('tesseract.js')
      const worker = (await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: `${SCANNER_ASSET_BASE}/worker.min.js`,
        corePath: SCANNER_ASSET_BASE,
        langPath: SCANNER_ASSET_BASE,
        gzip: true,
        workerBlobURL: false,
        logger: () => {},
      })) as unknown as TesseractWorker
      // A sensible DPI keeps the LSTM's scaling heuristics grounded on small canvas crops;
      // segmentation mode is set per recognition call (see `recognize`).
      await worker.setParameters({ user_defined_dpi: '300' })
      return worker
    } catch {
      throw new ScannerEngineError()
    }
  }

  /** Runs recognition over one pre-cropped, pre-processed canvas. Text is returned to the
   *  caller and goes nowhere else — never logged, never persisted (prompt §16). Serialized
   *  against every other `recognize()` call on this instance (F-15) and bounded against a
   *  `dispose()` call that arrives while this is in flight (F-14) — see the class fields' own
   *  doc comments for why. */
  async recognize(
    source: HTMLCanvasElement | OffscreenCanvas,
    segmentation: OcrSegmentation = 'single-line',
  ): Promise<OcrResult> {
    if (this.worker === null) throw new ScannerEngineError()
    const worker = this.worker
    const previous = this.recognizeQueue.catch(() => undefined)
    const run = previous.then(() => {
      // F-14: a call queued BEHIND another one may not start running until well after
      // dispose() was called (it waits for its turn) — checked here, at the moment it actually
      // begins, not just via the disposal race inside recognizeOnce (which only bounds a call
      // already in flight when dispose() runs). Without this, a queued call would still call
      // into the already-terminated `worker` it captured before disposal and inherit whatever
      // unbounded-hang risk that carries.
      if (this.disposed) throw new ScannerEngineDisposedError()
      return this.recognizeOnce(worker, source, segmentation)
    })
    this.recognizeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async recognizeOnce(
    worker: TesseractWorker,
    source: HTMLCanvasElement | OffscreenCanvas,
    segmentation: OcrSegmentation,
  ): Promise<OcrResult> {
    let rejectOnDispose!: (reason: unknown) => void
    const disposedSignal = new Promise<never>((_resolve, reject) => {
      rejectOnDispose = reject
    })
    this.disposalRejecters.add(rejectOnDispose)
    try {
      const work = (async (): Promise<OcrResult> => {
        await worker.setParameters({
          tessedit_pageseg_mode: SEGMENTATION_VALUES[segmentation],
        })
        const { data } = await worker.recognize(source)
        return {
          text: typeof data.text === 'string' ? data.text : '',
          confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        }
      })()
      // N-20 (P94): when `disposedSignal` wins the race below, `work` is left running with no
      // attached handler — if it later rejects (e.g. `worker.recognize()` failing because
      // `dispose()` just terminated the very worker it was mid-call on), that becomes an unhandled
      // promise rejection. The race already bounds every caller correctly either way; this exists
      // solely to keep a post-disposal rejection from surfacing as a console warning/crash-reporter
      // noise once nothing is listening for it any more.
      work.catch(() => {})
      return await Promise.race([work, disposedSignal])
    } finally {
      this.disposalRejecters.delete(rejectOnDispose)
    }
  }

  /** Terminates the worker and drops all references. Idempotent. F-14 (P89): bounded regardless
   *  of tesseract.js's own worker-termination semantics — rather than trusting that a killed
   *  worker's pending `recognize()` job promise actually settles on its own (unverified upstream
   *  behaviour), every currently in-flight `recognize()` call is explicitly rejected with
   *  {@link ScannerEngineDisposedError} the instant `dispose()` runs, so navigating away
   *  mid-analysis can never leave a caller (e.g. `Promise.all` in controller.ts) permanently
   *  pending. */
  dispose(): void {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    const rejecters = [...this.disposalRejecters]
    this.disposalRejecters.clear()
    for (const reject of rejecters) {
      reject(new ScannerEngineDisposedError())
    }
    if (worker !== null) {
      void worker.terminate().catch(() => {})
    }
  }
}
