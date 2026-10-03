/**
 * The adapter between Price Check and the M15 scanner (P153, rebuilt on the hardened read-only
 * contract in P161).
 *
 * Price Check consumes the scanner ONLY through `scanner-identification.ts` (P151): a
 * `ReadOnlyScannerPort` from `createReadOnlyScanner(userId)` — a fresh object with no
 * `commitBatch` — and the never-throwing `identifyCapture`. There is no second narrowing layer and
 * no second recognition path, so Price Check cannot reach the acquisition path even by accident and
 * the scanner core is neither forked nor edited.
 *
 * Who owns what (deliberately one owner per concern):
 *   - REQUEST ORDERING is owned by the scanner controller (latest scan wins: a newer scan, the
 *     caller's abort, or dispose() aborts the running one, and an aborted scan never publishes).
 *     This session therefore keeps NO generation counter of its own.
 *   - CANCELLATION is one `AbortSignal` per analysis, shared with the controller: Cancel, Retake, a
 *     newer photo and leaving the page all abort it, and an aborted analysis is "nothing happened".
 *   - What is left for this module is mapping an identification to what the Price Check page needs:
 *     catalog-card candidates only, HIGH honoured only for the card the scanner itself rated HIGH.
 *
 * The scanner code is loaded on demand (`loadScannerModule`): the text search never downloads any of
 * it, and no camera, OCR worker or model is initialised until a photo is actually chosen.
 */
import { interpretScan, type ScanCandidate, type ScanOutcome } from '../../domain/price-check/scan'
import type { ReadOnlyScannerPort, ScannerIdentification } from '../scanner/scanner-identification'
import type { ScannerCapture } from '../scanner/contract'

/** What the page needs from `scanner-identification.ts`, injected so this module never imports the
 *  scanner statically (the text-search page must stay free of it). */
export interface ScannerIdentificationModule {
  createReadOnlyScanner: (userId: string | null) => ReadOnlyScannerPort
  identifyCapture: (
    port: ReadOnlyScannerPort,
    capture: ScannerCapture,
    signal?: AbortSignal,
  ) => Promise<ScannerIdentification>
}

/** Dynamic import of the scanner's read-only contract — the only door into the scanner. */
export function loadScannerModule(): Promise<ScannerIdentificationModule> {
  return import('../scanner/scanner-identification')
}

/** One read-only scanner for this mounted page and signed-in identity, prewarmed. */
export function createPriceCheckScanSession(
  scanner: ScannerIdentificationModule,
  userId: string | null,
): PriceCheckScanSession {
  const port = scanner.createReadOnlyScanner(userId)
  port.prewarm()
  return new PriceCheckScanSession(port, scanner.identifyCapture)
}

export type ScanResult =
  | { readonly status: 'outcome'; readonly outcome: ScanOutcome }
  /** Cancelled, superseded or disposed. The UI must treat this as "nothing happened". */
  | { readonly status: 'abandoned' }
  | { readonly status: 'error'; readonly message: string }

const CARD_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ERROR_HINT = 'Try again with a sharper photo, or search by name.'

function toCandidates(identification: ScannerIdentification): ScanCandidate[] {
  const seen = new Set<string>()
  const candidates: ScanCandidate[] = []
  for (const card of identification.candidates) {
    if (!CARD_ID_SHAPE.test(card.catalogCardId) || seen.has(card.catalogCardId)) continue
    seen.add(card.catalogCardId)
    candidates.push({
      candidateId: card.catalogCardId,
      name: card.name,
      setName: card.setName,
      collectorNumber: card.collectorNumber,
      imageBaseUrl: card.imageBaseUrl,
      languageLabel: card.languageLabel,
    })
  }
  return candidates
}

/** Pure mapping, exported for tests. `error` and `aborted` never reach it. */
export function identificationToOutcome(identification: ScannerIdentification): ScanOutcome {
  return interpretScan({
    confidence: identification.confidence,
    candidates: toCandidates(identification),
    // HIGH vouches for the scanner's own first candidate only (see interpretScan).
    scannerBestId: identification.best?.catalogCardId ?? null,
  })
}

export class PriceCheckScanSession {
  private readonly port: ReadOnlyScannerPort
  private readonly identify: ScannerIdentificationModule['identifyCapture']
  /** The signal shared with the scanner for the analysis in flight (null when idle). */
  private inFlight: AbortController | null = null
  private disposed = false

  constructor(port: ReadOnlyScannerPort, identify: ScannerIdentificationModule['identifyCapture']) {
    this.port = port
    this.identify = identify
  }

  /** Analyse one captured photo. Resolves once; a newer call or a cancel abandons this one. */
  async analyze(capture: ScannerCapture): Promise<ScanResult> {
    if (this.disposed) return { status: 'abandoned' }
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    try {
      const identification = await this.identify(this.port, capture, controller.signal)
      // The one shared token: set by Cancel/Retake/newer photo/dispose, and by the scanner itself.
      if (isAborted(controller.signal)) return { status: 'abandoned' }
      if (identification.status === 'error') {
        const error = identification.error
        if (error === null || error.code === 'aborted') return { status: 'abandoned' }
        return { status: 'error', message: `${error.message} ${ERROR_HINT}` }
      }
      return { status: 'outcome', outcome: identificationToOutcome(identification) }
    } finally {
      if (this.inFlight === controller) this.inFlight = null
    }
  }

  /** Abandon whatever is in flight (Cancel, Retake, leaving the screen). */
  cancel(): void {
    this.inFlight?.abort()
    this.inFlight = null
  }

  /** Cancel and release the scanner (workers, timers). Idempotent; unusable afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
    this.port.dispose()
  }
}

/** A function, not an inline `signal.aborted` test: the flag flips across an `await`, which the
 *  compiler would otherwise narrow away. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}
