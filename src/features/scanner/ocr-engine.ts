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
 *  full-card fallback reads best in auto layout mode. */
export type OcrSegmentation = 'single-line' | 'auto'

const SEGMENTATION_VALUES = { 'single-line': '7', auto: '3' } as const

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
   *  caller and goes nowhere else — never logged, never persisted (prompt §16). */
  async recognize(
    source: HTMLCanvasElement | OffscreenCanvas,
    segmentation: OcrSegmentation = 'single-line',
  ): Promise<OcrResult> {
    if (this.worker === null) throw new ScannerEngineError()
    await this.worker.setParameters({ tessedit_pageseg_mode: SEGMENTATION_VALUES[segmentation] })
    const { data } = await this.worker.recognize(source)
    return {
      text: typeof data.text === 'string' ? data.text : '',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    }
  }

  /** Terminates the worker and drops all references. Idempotent; safe during an in-flight
   *  recognition (the pending call rejects upstream as failed analysis). */
  dispose(): void {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    if (worker !== null) {
      void worker.terminate().catch(() => {})
    }
  }
}
