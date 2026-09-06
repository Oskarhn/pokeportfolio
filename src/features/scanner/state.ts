import type { CardCondition } from '../../data/collection'
import type {
  ScannerAnalysis,
  ScannerCandidate,
  ScannerCommitOutcome,
  ScannerVariantChoice,
  ScannedBatchCard,
} from './contract'

/**
 * The scanner's UI state machine (P66). Pure reducer — no platform access, no capture blobs, no
 * controller calls — so every transition rule the prompt pins down (permission only after an
 * explicit action; HIGH still requires confirm; confirm appends to an in-memory batch and never
 * commits; exit warns when a nonempty batch would be lost) is verifiable in isolation.
 *
 * Memory ownership note (prompt §21/§28): batch entries carry candidate IDENTITY plus
 * quantity/condition. There is deliberately no field here — and none may ever be added — that
 * holds a captured photo, blob or object URL. The live capture is owned by CaptureStore in
 * capture.ts and disposed by the page component at exactly the transitions where it stops being
 * needed.
 */

export type ScannerStep =
  /** Start screen. Camera permission is NEVER requested from this state without the user
   *  pressing "Start camera" first (prompt §6). */
  | 'intro'
  /** Explicit request made; stream opening. The <video> element mounts in this step. */
  | 'starting-camera'
  | 'camera'
  | 'review'
  | 'analyzing'
  /** Analysis answered with candidates (HIGH/MEDIUM/LOW). */
  | 'result'
  | 'no-match'
  | 'manual-search'
  | 'confirm'
  | 'scanned'
  | 'batch-review'
  | 'committing'
  | 'committed'

export interface ScannerState {
  step: ScannerStep
  /** True once the user has explicitly asked for the camera — the audit trail for "permission
   *  starts only after explicit action". Never set by anything else. */
  cameraRequested: boolean
  cameraError: { title: string; message: string } | null
  captureError: { title: string; message: string } | null
  analysisError: { title: string; message: string } | null
  analysis: ScannerAnalysis | null
  selectedCandidate: ScannerCandidate | null
  searchResults: ScannerCandidate[]
  searchPending: boolean
  searchError: { title: string; message: string } | null
  /** Where manual-search returns to when closed — the flow never restarts from zero. */
  searchReturnStep: Extract<ScannerStep, 'no-match' | 'result'> | null
  confirmQuantity: string
  confirmCondition: CardCondition
  confirmValidationError: string | null
  /** Printing choices for the selected candidate (prompt §22). Loaded only AFTER the user chose
   *  the candidate — never for every result row. */
  confirmVariants: ScannerVariantChoice[] | null
  confirmVariantsPending: boolean
  confirmVariantsError: { title: string; message: string } | null
  confirmVariantId: string | null
  batch: ScannedBatchCard[]
  commitError: { title: string; message: string } | null
  addedCount: number | null
  /** Items from the last commit needing attention (definite failures + interrupted transports). */
  attentionCount: number | null
  exitWarningOpen: boolean
  /** Set when the machine has fully released its work and the page should leave the route.
   *  The reducer cannot navigate; it only records permission to. */
  exitRequested: boolean
}

/** The add-card flow's existing default condition ('NM' in AddToCollectionPage) — reused, not
 *  reinvented, per prompt §19. A clean-looking photo never changes what the default means. */
export const SCANNER_DEFAULT_CONDITION: CardCondition = 'NM'

export const initialScannerState: ScannerState = {
  step: 'intro',
  cameraRequested: false,
  cameraError: null,
  captureError: null,
  analysisError: null,
  analysis: null,
  selectedCandidate: null,
  searchResults: [],
  searchPending: false,
  searchError: null,
  searchReturnStep: null,
  confirmQuantity: '1',
  confirmCondition: SCANNER_DEFAULT_CONDITION,
  confirmValidationError: null,
  confirmVariants: null,
  confirmVariantsPending: false,
  confirmVariantsError: null,
  confirmVariantId: null,
  batch: [],
  commitError: null,
  addedCount: null,
  attentionCount: null,
  exitWarningOpen: false,
  exitRequested: false,
}

export type ScannerAction =
  | { type: 'START_CAMERA_PRESSED' }
  | { type: 'CAMERA_STARTED' }
  | { type: 'CAMERA_FAILED'; error: { title: string; message: string } }
  | { type: 'CAMERA_EXITED' }
  | { type: 'CAPTURE_SUCCEEDED' }
  | { type: 'CAPTURE_FAILED'; error: { title: string; message: string } }
  | { type: 'RETAKE_PRESSED' }
  | { type: 'USE_PHOTO_PRESSED' }
  | { type: 'ANALYSIS_COMPLETED'; analysis: ScannerAnalysis }
  | { type: 'ANALYSIS_FAILED'; error: { title: string; message: string } }
  | { type: 'ANALYSIS_CANCELLED' }
  | { type: 'CANDIDATE_SELECTED'; candidate: ScannerCandidate }
  | { type: 'CONFIRM_CARD_PRESSED'; candidate: ScannerCandidate }
  | { type: 'CONFIRM_QUANTITY_CHANGED'; value: string }
  | { type: 'CONFIRM_CONDITION_CHANGED'; condition: CardCondition }
  /** Printing choices arrived for the selected candidate (prompt §22). */
  | { type: 'CONFIRM_VARIANTS_PENDING' }
  | { type: 'CONFIRM_VARIANTS_LOADED'; variants: ScannerVariantChoice[] }
  | { type: 'CONFIRM_VARIANTS_FAILED'; error: { title: string; message: string } }
  | { type: 'CONFIRM_VARIANT_CHANGED'; variantId: string }
  | { type: 'CARD_CONFIRMED' }
  | { type: 'CONFIRM_CANCELLED' }
  | { type: 'SCAN_NEXT_PRESSED' }
  | { type: 'REVIEW_BATCH_PRESSED' }
  | { type: 'BATCH_ITEM_QUANTITY_CHANGED'; index: number; value: string }
  | { type: 'BATCH_ITEM_CONDITION_CHANGED'; index: number; condition: CardCondition }
  | { type: 'BATCH_ITEM_REMOVED'; index: number }
  | { type: 'ADD_CARDS_PRESSED' }
  | {
      type: 'COMMIT_SUCCEEDED'
      addedCount: number
      outcomes: ScannerCommitOutcome[]
    }
  | { type: 'COMMIT_FAILED'; error: { title: string; message: string } }
  | { type: 'COMMITTED_DONE_PRESSED' }
  | { type: 'SEARCH_OPENED'; from: Extract<ScannerStep, 'no-match' | 'result'> }
  | { type: 'SEARCH_CLOSED' }
  | { type: 'SEARCH_PENDING' }
  | { type: 'SEARCH_RESULTS'; candidates: ScannerCandidate[] }
  | { type: 'SEARCH_FAILED'; error: { title: string; message: string } }
  | { type: 'SEARCH_RESULT_SELECTED'; candidate: ScannerCandidate }
  | { type: 'EXIT_PRESSED' }
  | { type: 'EXIT_CANCELLED' }
  | { type: 'DISCARD_CONFIRMED' }

export function scannerReducer(state: ScannerState, action: ScannerAction): ScannerState {
  switch (action.type) {
    case 'START_CAMERA_PRESSED':
      // The one and only gate in front of any getUserMedia call.
      return {
        ...state,
        step: 'starting-camera',
        cameraRequested: true,
        cameraError: null,
      }
    case 'CAMERA_STARTED':
      return { ...state, step: 'camera', cameraError: null, captureError: null }
    case 'CAMERA_FAILED':
      return { ...state, step: 'intro', cameraError: action.error }
    case 'CAMERA_EXITED':
      return { ...state, step: 'intro' }
    case 'CAPTURE_SUCCEEDED':
      return { ...state, step: 'review', captureError: null }
    case 'CAPTURE_FAILED':
      return { ...state, captureError: action.error }
    case 'RETAKE_PRESSED':
      // Restarting the camera is the retake path; the old capture was already disposed by the
      // page before dispatching this.
      return { ...state, step: 'starting-camera', analysisError: null }
    case 'USE_PHOTO_PRESSED':
      return { ...state, step: 'analyzing', analysisError: null }
    case 'ANALYSIS_COMPLETED': {
      if (action.analysis.confidence === 'NO_MATCH' || action.analysis.candidates.length === 0) {
        return { ...state, step: 'no-match', analysis: action.analysis, selectedCandidate: null }
      }
      // HIGH names one card outright; a single MEDIUM/LOW candidate needs no choice either.
      // Multiple lower-confidence candidates stay UNSELECTED until the user taps one —
      // ambiguity is resolved by the user, never silently by rank alone.
      const autoSelect =
        action.analysis.confidence === 'HIGH' || action.analysis.candidates.length === 1
      return {
        ...state,
        step: 'result',
        analysis: action.analysis,
        selectedCandidate: autoSelect ? (action.analysis.candidates[0] ?? null) : null,
      }
    }
    case 'ANALYSIS_FAILED':
      // Back to review with the photo still held: retrying the same photo must be possible
      // without recapturing it.
      return { ...state, step: 'review', analysisError: action.error }
    case 'ANALYSIS_CANCELLED':
      // The photo is untouched in the capture store, so review picks up exactly where the
      // user left off — cancel never costs a recapture.
      return { ...state, step: 'review' }
    case 'CANDIDATE_SELECTED':
      return { ...state, selectedCandidate: action.candidate }
    case 'CONFIRM_CARD_PRESSED':
      return {
        ...state,
        step: 'confirm',
        selectedCandidate: action.candidate,
        confirmQuantity: '1',
        confirmCondition: SCANNER_DEFAULT_CONDITION,
        confirmValidationError: null,
        // Printing choices load fresh for THIS candidate, only now that it was chosen (§22).
        confirmVariants: null,
        confirmVariantsPending: true,
        confirmVariantsError: null,
        confirmVariantId: null,
      }
    case 'CONFIRM_QUANTITY_CHANGED':
      return { ...state, confirmQuantity: action.value, confirmValidationError: null }
    case 'CONFIRM_CONDITION_CHANGED':
      return { ...state, confirmCondition: action.condition, confirmValidationError: null }
    case 'CONFIRM_VARIANTS_PENDING':
      return { ...state, confirmVariantsPending: true, confirmVariantsError: null }
    case 'CONFIRM_VARIANTS_LOADED':
      if (state.step !== 'confirm') return state
      return {
        ...state,
        confirmVariantsPending: false,
        confirmVariants: action.variants,
        // Exactly one active printing may be preselected (prompt §22); several stay unchosen.
        confirmVariantId:
          action.variants.length === 1 ? (action.variants[0]?.id ?? null) : state.confirmVariantId,
      }
    case 'CONFIRM_VARIANTS_FAILED':
      if (state.step !== 'confirm') return state
      return {
        ...state,
        confirmVariantsPending: false,
        confirmVariantsError: action.error,
      }
    case 'CONFIRM_VARIANT_CHANGED':
      return { ...state, confirmVariantId: action.variantId, confirmValidationError: null }
    case 'CARD_CONFIRMED': {
      const trimmedQuantity = state.confirmQuantity.trim()
      const quantity = /^\d+$/.test(trimmedQuantity) ? Number.parseInt(trimmedQuantity, 10) : 0
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { ...state, confirmValidationError: 'Enter a quantity of at least 1.' }
      }
      const candidate = state.selectedCandidate
      if (candidate === null) return state
      const variantId = state.confirmVariantId
      const variants = state.confirmVariants ?? []
      if (variantId === null) {
        // A batch item MUST carry its canonical variant id before it can ever be saved (§22).
        return {
          ...state,
          confirmValidationError: 'Choose which version of this card you have.',
        }
      }
      const variantLabel =
        variants.find((variant) => variant.id === variantId)?.label ?? 'Selected version'
      return {
        ...state,
        step: 'scanned',
        batch: [
          ...state.batch,
          {
            candidate,
            variantId,
            variantLabel,
            quantity,
            condition: state.confirmCondition,
            // Stable per-item idempotency key (D-096): generated ONCE when the logical card
            // enters the batch. Survives editing condition/quantity, partial save retry,
            // transport retry. Changes only if the user removes the item and scans a new one.
            requestKey: crypto.randomUUID(),
          },
        ],
        selectedCandidate: null,
        analysis: null,
        confirmQuantity: '1',
        confirmCondition: SCANNER_DEFAULT_CONDITION,
        confirmValidationError: null,
        confirmVariants: null,
        confirmVariantsPending: false,
        confirmVariantsError: null,
        confirmVariantId: null,
      }
    }
    case 'CONFIRM_CANCELLED':
      // Back to wherever the confirmed candidate came from — the result list when an analysis
      // is on screen, otherwise the photo review.
      return {
        ...state,
        step: state.analysis !== null && state.analysis.candidates.length > 0 ? 'result' : 'review',
        selectedCandidate: null,
        confirmValidationError: null,
        confirmVariants: null,
        confirmVariantsPending: false,
        confirmVariantsError: null,
        confirmVariantId: null,
      }
    case 'SCAN_NEXT_PRESSED':
      return { ...state, step: 'starting-camera', cameraRequested: true }
    case 'REVIEW_BATCH_PRESSED':
      return { ...state, step: 'batch-review', commitError: null }
    case 'BATCH_ITEM_QUANTITY_CHANGED': {
      // F-19/§8 (P89): a needsVerification item's requestKey was generated for the material
      // facts (quantity/condition/variant) it ALREADY attempted to save under — that attempt's
      // outcome is genuinely unknown (see classifyAcquisitionFailure's ambiguous-transport
      // case). Editing those facts and retrying under the SAME key deterministically triggers
      // the server's idempotency-key-reuse guard if the original attempt actually succeeded
      // (F-19); silently minting a NEW key instead would risk a real duplicate if it did. The
      // only safe move is to freeze material edits until the user removes the item (after an
      // explicit warning) and rescans as a genuinely new capture.
      const batch = state.batch.map((item, index) =>
        index === action.index && !item.needsVerification
          ? { ...item, quantity: parseBatchQuantity(action.value, item.quantity) }
          : item,
      )
      return { ...state, batch }
    }
    case 'BATCH_ITEM_CONDITION_CHANGED': {
      const batch = state.batch.map((item, index) =>
        index === action.index && !item.needsVerification
          ? { ...item, condition: action.condition }
          : item,
      )
      return { ...state, batch }
    }
    case 'BATCH_ITEM_REMOVED':
      return { ...state, batch: state.batch.filter((_, index) => index !== action.index) }
    case 'ADD_CARDS_PRESSED':
      return { ...state, step: 'committing', commitError: null }
    case 'COMMIT_SUCCEEDED': {
      // Honest per-item accounting (prompt §29/§31): definite successes are counted and dropped
      // from the batch (a retry must never resubmit them); definite failures stay retryable;
      // interrupted transports stay flagged for manual verification — never silently retried.
      const survivors: ScannedBatchCard[] = []
      state.batch.forEach((item, index) => {
        const outcome = action.outcomes.find((candidate) => candidate.index === index)
        if (outcome !== undefined && outcome.status === 'added') return
        survivors.push(
          outcome !== undefined && outcome.status === 'needs_verification'
            ? { ...item, needsVerification: true }
            : item,
        )
      })
      const attentionCount = action.outcomes.filter((outcome) => outcome.status !== 'added').length
      return {
        ...state,
        step: 'committed',
        addedCount: action.addedCount,
        attentionCount: attentionCount > 0 ? attentionCount : null,
        batch: survivors,
      }
    }
    case 'COMMIT_FAILED':
      // Batch stays intact so nothing is lost to a transient failure — retry, not re-entry.
      return { ...state, step: 'batch-review', commitError: action.error }
    case 'COMMITTED_DONE_PRESSED':
      // F-09 (P89): a partial commit deliberately keeps not-yet-saved survivor items in
      // state.batch (failed / needs_verification outcomes) so nothing scanned-but-unsaved is
      // lost. "Done" reads as an ordinary acknowledgement, not "discard" — it must not bypass
      // the SAME nonempty-batch protection every other exit path in this feature enforces
      // (compare EXIT_PRESSED below). Routing through exitWarningOpen reuses the existing
      // discard-confirmation sheet; the component distinguishes THIS case from the pre-save
      // "nothing added yet" case by state.step still being 'committed' when the sheet opens, and
      // renders explicit "Review remaining" / "Discard remaining and exit" copy accordingly.
      if (state.batch.length > 0) {
        return { ...state, exitWarningOpen: true }
      }
      return { ...initialScannerState, exitRequested: true }
    case 'SEARCH_OPENED':
      return {
        ...state,
        step: 'manual-search',
        searchReturnStep: action.from,
        searchResults: [],
        searchPending: false,
        searchError: null,
      }
    case 'SEARCH_CLOSED':
      return {
        ...state,
        step: state.searchReturnStep ?? 'no-match',
        searchReturnStep: null,
        searchResults: [],
        searchPending: false,
        searchError: null,
      }
    case 'SEARCH_PENDING':
      return { ...state, searchPending: true, searchError: null, searchResults: [] }
    case 'SEARCH_RESULTS':
      return { ...state, searchPending: false, searchResults: action.candidates }
    case 'SEARCH_FAILED':
      return { ...state, searchPending: false, searchError: action.error }
    case 'SEARCH_RESULT_SELECTED':
      return {
        ...state,
        step: 'confirm',
        selectedCandidate: action.candidate,
        searchResults: [],
        searchPending: false,
        searchError: null,
        searchReturnStep: null,
        confirmQuantity: '1',
        confirmCondition: SCANNER_DEFAULT_CONDITION,
        confirmValidationError: null,
        confirmVariants: null,
        confirmVariantsPending: true,
        confirmVariantsError: null,
        confirmVariantId: null,
      }
    case 'EXIT_PRESSED':
      if (state.batch.length > 0) {
        return { ...state, exitWarningOpen: true }
      }
      return { ...state, exitRequested: true }
    case 'EXIT_CANCELLED':
      return { ...state, exitWarningOpen: false }
    case 'DISCARD_CONFIRMED':
      // Nothing was ever added to the Portfolio — discarding drops only this session's memory.
      return { ...initialScannerState, exitRequested: true }
  }
}

function parseBatchQuantity(rawValue: string, fallback: number): number {
  const parsed = Number.parseInt(rawValue, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
