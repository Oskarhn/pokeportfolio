import { getScannerUiController } from './controller'
import type {
  ScannerAnalysis,
  ScannerCandidate,
  ScannerCapture,
  ScannerConfidence,
  ScannerSearchQuery,
  ScannerUiController,
  ScannerVariantChoice,
} from './contract'

/**
 * READ-ONLY scanner result contract (P151) — the seam a second consumer (Price Check, P153) uses to
 * identify a card from a photo WITHOUT the scanner's acquisition machinery.
 *
 * What this is: a typed, provider-neutral description of "what the scanner believes this photo is",
 * plus a small port over the EXISTING scanner controller. There is no second recognition engine —
 * `identifyCapture` calls the same `analyzeCapture` the scanner page calls (same OCR, same visual
 * index, same matcher, same confidence policy, same cancellation semantics).
 *
 * What this can never do: create holdings, purchases, sales, manual card definitions or any ledger
 * write. That is enforced three ways, not by convention alone:
 *   1. {@link ReadOnlyScannerPort} has no `commitBatch` member, and {@link createReadOnlyScanner}
 *      returns a fresh object containing only the members below — the method does not exist at
 *      runtime, so it cannot be reached by a cast either;
 *   2. this module imports nothing from `data/collection`;
 *   3. tests/ui/scanner-p151-identification.test.ts asserts both.
 * (The controller module itself imports the collection writer for the scanner page's own commit
 * path; that import is not reachable through this port.)
 *
 * Honesty rules carried over unchanged from the scanner:
 *   - a candidate is a PROPOSAL about a catalog CARD, never a fact about a printing;
 *   - the scanner NEVER infers holo / reverse holo / stamp / other printing. `variantEvidence` states
 *     that plainly so a consumer cannot mistake silence for "normal". The consumer obtains the real
 *     printing choices with `listVariantChoices` and must let the USER choose unless exactly one
 *     active printing exists;
 *   - HIGH now means two independent channels agree (printed text AND visual); vision alone is held
 *     at MEDIUM, because artwork cannot tell reprints apart (docs/SCANNER_RESEARCH.md, P151);
 *   - absent data is absent: no candidate is ever fabricated, `best` is null when nothing matched.
 */

/** One catalog card the scanner proposes. Identity only — no price, no quantity, no variant. */
export interface ScannerIdentifiedCard {
  /** The catalog card id (cards.id) — stable across sessions, usable for read-only catalog lookups. */
  readonly catalogCardId: string
  readonly name: string
  readonly setName: string | null
  /** Printed collector number as stored in the catalog (e.g. "058"), not as OCR read it. */
  readonly collectorNumber: string | null
  readonly imageBaseUrl: string | null
  /** Catalog language label (today always English — the visual index is English-only). */
  readonly languageLabel: string | null
}

/** Why an identification failed. `aborted` means the caller (or a newer request) cancelled it. */
export type ScannerIdentificationErrorCode =
  'aborted' | 'catalog-unavailable' | 'engine-unavailable' | 'unknown'

export interface ScannerIdentificationError {
  readonly code: ScannerIdentificationErrorCode
  /** User-presentable, already sanitised — never a stack trace or a browser internal. */
  readonly message: string
}

/** Always "not identified": stated explicitly so silence is never read as "normal printing". */
export interface ScannerVariantEvidence {
  readonly identified: false
  readonly reason: 'card-level-recognition-only'
}

export type ScannerIdentificationStatus =
  /** HIGH: two independent channels agree on `best`. Still requires the printing to be chosen. */
  | 'identified'
  /** MEDIUM/LOW: candidates were found, the user must pick or confirm. */
  | 'needs-confirmation'
  | 'no-match'
  | 'error'

export interface ScannerIdentification {
  readonly status: ScannerIdentificationStatus
  /** The scanner's own coarse band; `NO_MATCH` for no-match and for errors. */
  readonly confidence: ScannerConfidence
  /** Best-first, bounded (the scanner's UI shortlist, at most 8). Empty for no-match / error. */
  readonly candidates: readonly ScannerIdentifiedCard[]
  /** `candidates[0]` or null. A proposal — see `requiresManualConfirmation`. */
  readonly best: ScannerIdentifiedCard | null
  /** False ONLY for HIGH. Everything else — and every error — needs the user. */
  readonly requiresManualConfirmation: boolean
  readonly variantEvidence: ScannerVariantEvidence
  readonly error: ScannerIdentificationError | null
}

const VARIANT_NOT_IDENTIFIED: ScannerVariantEvidence = {
  identified: false,
  reason: 'card-level-recognition-only',
}

function toIdentifiedCard(candidate: ScannerCandidate): ScannerIdentifiedCard {
  return {
    catalogCardId: candidate.candidateId,
    name: candidate.name,
    setName: candidate.setName ?? null,
    collectorNumber: candidate.collectorNumber ?? null,
    imageBaseUrl: candidate.imageBaseUrl ?? null,
    languageLabel: candidate.languageLabel ?? null,
  }
}

/** Pure mapping from the scanner's analysis to the read-only contract. Exported for tests. */
export function toScannerIdentification(analysis: ScannerAnalysis): ScannerIdentification {
  const candidates = analysis.candidates.map(toIdentifiedCard)
  if (analysis.confidence === 'NO_MATCH' || candidates.length === 0) {
    return {
      status: 'no-match',
      confidence: 'NO_MATCH',
      candidates: [],
      best: null,
      requiresManualConfirmation: true,
      variantEvidence: VARIANT_NOT_IDENTIFIED,
      error: null,
    }
  }
  const high = analysis.confidence === 'HIGH'
  return {
    status: high ? 'identified' : 'needs-confirmation',
    confidence: analysis.confidence,
    candidates,
    best: candidates[0] ?? null,
    requiresManualConfirmation: !high,
    variantEvidence: VARIANT_NOT_IDENTIFIED,
    error: null,
  }
}

/** Pure mapping from a thrown value to the contract's error. Exported for tests. */
export function toScannerIdentificationError(error: unknown): ScannerIdentification {
  const name = error instanceof Error ? error.name : ''
  const detail: ScannerIdentificationError =
    name === 'ScannerAnalysisAbortedError' || name === 'ScannerEngineDisposedError'
      ? { code: 'aborted', message: 'The scan was cancelled.' }
      : name === 'ScannerCatalogUnavailableError'
        ? { code: 'catalog-unavailable', message: 'The card catalog could not be reached.' }
        : name === 'ScannerEngineError'
          ? {
              code: 'engine-unavailable',
              message: 'The card reader could not start on this device.',
            }
          : { code: 'unknown', message: 'The card could not be analysed just now.' }
  return {
    status: 'error',
    confidence: 'NO_MATCH',
    candidates: [],
    best: null,
    requiresManualConfirmation: true,
    variantEvidence: VARIANT_NOT_IDENTIFIED,
    error: detail,
  }
}

/**
 * The only scanner surface a read-only consumer receives. Deliberately a strict subset of
 * {@link ScannerUiController}: recognition, the manual name/number search fallback, the read-only
 * printing lookup, and lifecycle. Everything that writes (`commitBatch`) or exposes debug state is
 * absent.
 */
export interface ReadOnlyScannerPort {
  analyzeCapture: ScannerUiController['analyzeCapture']
  searchFallback: (query: ScannerSearchQuery) => Promise<ScannerCandidate[]>
  /** Printing choices for one catalog card — a plain catalog read, for the consumer to present. */
  listVariantChoices: (cardId: string) => Promise<ScannerVariantChoice[]>
  /** Starts warming the OCR / visual runtimes. Idempotent, non-blocking. */
  prewarm: () => void
  /** MUST be called on unmount / identity change: terminates workers, aborts an in-flight scan. */
  dispose: () => void
}

/** Narrows any controller to the read-only port by construction (a fresh object with only the
 *  allowed members bound — `commitBatch` is not reachable from it, even by a cast). */
export function toReadOnlyScannerPort(controller: ScannerUiController): ReadOnlyScannerPort {
  return {
    analyzeCapture: (capture, signal) => controller.analyzeCapture(capture, signal),
    searchFallback: (query) => controller.searchFallback(query),
    listVariantChoices: (cardId) => controller.listVariantChoices(cardId),
    prewarm: () => {
      controller.prewarm?.()
    },
    dispose: () => {
      controller.dispose()
    },
  }
}

/** One read-only scanner per mounted consumer and signed-in identity — the same lifecycle rule as
 *  the scanner page (never one per photo; dispose on unmount). */
export function createReadOnlyScanner(userId: string | null): ReadOnlyScannerPort {
  return toReadOnlyScannerPort(getScannerUiController(userId))
}

/**
 * Identify one photo. Never throws: every failure, including cancellation, is a
 * `status: 'error'` result. LATEST-REQUEST-WINS: starting a second identification on the same port
 * aborts the first (it resolves `error.code === 'aborted'`); pass an `AbortSignal` to cancel
 * explicitly. Nothing here — and nothing reachable from `port` — writes to the collection.
 */
export async function identifyCapture(
  port: ReadOnlyScannerPort,
  capture: ScannerCapture,
  signal?: AbortSignal,
): Promise<ScannerIdentification> {
  try {
    return toScannerIdentification(await port.analyzeCapture(capture, signal))
  } catch (error) {
    return toScannerIdentificationError(error)
  }
}
