/**
 * The narrow adapter between Price Check and the M15 scanner (P153).
 *
 * The scanner's public surface (`ScannerUiController`, src/features/scanner/contract.ts) mixes
 * recognition with the acquisition path (`commitBatch` → `add_card_acquisition`). Price Check only
 * ever needs recognition, so it consumes exactly two members — `analyzeCapture` and `dispose` — and
 * `narrowScannerPort` builds a fresh object that carries nothing else: a Price Check screen cannot
 * reach `commitBatch` even by accident, and the scanner core is neither forked nor edited.
 *
 * Assumed scanner contract (recorded for the P151 integration, HANDOVER/output_153):
 *   - `analyzeCapture(capture, signal?)` resolves to `{ confidence, candidates[] }`.
 *   - a candidate's `candidateId` is the catalog `cards.id` (uuid). A candidate whose id does not
 *     look like one is dropped here rather than guessed at.
 *   - the scanner never reports a variant; identity only.
 *
 * `PriceCheckScanSession` guarantees, whatever the scanner does:
 *   - a newer scan supersedes an older one — the older result is never delivered;
 *   - cancel / dispose (route exit, unmount) abandon the in-flight scan and deliver nothing;
 *   - a scan that fails resolves to an `error` result the UI can show; it never rejects into
 *     unrelated code and never triggers any write.
 */
import type { ScannerAnalysis, ScannerCapture, ScannerUiController } from '../scanner/contract'
import { interpretScan, type ScanCandidate, type ScanOutcome } from '../../domain/price-check/scan'

/** Everything Price Check may call on the scanner. `commitBatch` is deliberately not here. */
export interface PriceCheckScannerPort {
  analyzeCapture(capture: ScannerCapture, signal?: AbortSignal): Promise<ScannerAnalysis>
  dispose(): void
}

export function narrowScannerPort(controller: ScannerUiController): PriceCheckScannerPort {
  return {
    analyzeCapture: (capture, signal) => controller.analyzeCapture(capture, signal),
    dispose: () => {
      controller.dispose()
    },
  }
}

export type ScanResult =
  | { readonly status: 'outcome'; readonly outcome: ScanOutcome }
  /** Cancelled, superseded or disposed. The UI must treat this as "nothing happened". */
  | { readonly status: 'abandoned' }
  | { readonly status: 'error'; readonly message: string }

const CARD_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCAN_FAILED_MESSAGE =
  'The scan could not be completed. Try again with a sharper photo, or search by name.'

function toCandidates(analysis: ScannerAnalysis): ScanCandidate[] {
  const seen = new Set<string>()
  const candidates: ScanCandidate[] = []
  for (const candidate of analysis.candidates) {
    if (!CARD_ID_SHAPE.test(candidate.candidateId) || seen.has(candidate.candidateId)) continue
    seen.add(candidate.candidateId)
    candidates.push({
      candidateId: candidate.candidateId,
      name: candidate.name,
      setName: candidate.setName ?? null,
      collectorNumber: candidate.collectorNumber ?? null,
      imageBaseUrl: candidate.imageBaseUrl ?? null,
      languageLabel: candidate.languageLabel ?? null,
    })
  }
  return candidates
}

export class PriceCheckScanSession {
  private readonly port: PriceCheckScannerPort
  private generation = 0
  private abort: AbortController | null = null
  private disposed = false

  constructor(port: PriceCheckScannerPort) {
    this.port = port
  }

  /** Analyse one captured photo. Resolves once; a newer call or a cancel abandons this one. */
  async analyze(capture: ScannerCapture): Promise<ScanResult> {
    if (this.disposed) return { status: 'abandoned' }
    this.abort?.abort()
    const controller = new AbortController()
    this.abort = controller
    const generation = ++this.generation

    try {
      const analysis = await this.port.analyzeCapture(capture, controller.signal)
      if (this.isStale(generation, controller)) return { status: 'abandoned' }
      return {
        status: 'outcome',
        outcome: interpretScan({
          confidence: analysis.confidence,
          candidates: toCandidates(analysis),
        }),
      }
    } catch {
      // An aborted scanner call rejects; that is not a failure the person should see.
      if (this.isStale(generation, controller)) return { status: 'abandoned' }
      return { status: 'error', message: SCAN_FAILED_MESSAGE }
    } finally {
      if (this.abort === controller) this.abort = null
    }
  }

  /** Abandon whatever is in flight (Cancel, Retake, leaving the screen). */
  cancel(): void {
    this.generation += 1
    this.abort?.abort()
    this.abort = null
  }

  /** Cancel and release the scanner. Idempotent; the session is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
    this.port.dispose()
  }

  private isStale(generation: number, controller: AbortController): boolean {
    return this.disposed || controller.signal.aborted || generation !== this.generation
  }
}
