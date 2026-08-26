import { describe, expect, it } from 'vitest'
import type { ScannerAnalysis, ScannerCandidate } from '../../src/features/scanner/contract'
import {
  SCANNER_DEFAULT_CONDITION,
  initialScannerState,
  scannerReducer,
  type ScannerState,
} from '../../src/features/scanner/state'

/**
 * The scanner UI state machine (P66), verified in isolation. Every rule the prompt pins down is
 * a transition assertion here: permission only after an explicit action, HIGH still requires
 * confirmation, confirmation appends to an IN-MEMORY batch and never commits, exit warns when a
 * nonempty batch would be lost, and batch entries carry card identity only — never a captured
 * photo (the blob-disposal half of that rule lives in the CaptureStore tests next door).
 */

function candidate(id: string): ScannerCandidate {
  return { candidateId: id, name: `Card ${id}`, setName: 'Base Set', collectorNumber: id }
}

function highAnalysis(candidates: ScannerCandidate[]): ScannerAnalysis {
  return { confidence: 'HIGH', candidates }
}

function reduce(state: ScannerState, action: Parameters<typeof scannerReducer>[1]): ScannerState {
  return scannerReducer(state, action)
}

/** Drives the happy path up to a completed analysis result. */
function atResult(analysis: ScannerAnalysis): ScannerState {
  let state = reduce(initialScannerState, { type: 'START_CAMERA_PRESSED' })
  state = reduce(state, { type: 'CAMERA_STARTED' })
  state = reduce(state, { type: 'CAPTURE_SUCCEEDED' })
  state = reduce(state, { type: 'USE_PHOTO_PRESSED' })
  return reduce(state, { type: 'ANALYSIS_COMPLETED', analysis })
}

/** Drives to the confirm step for candidate "a". */
function atConfirm(): ScannerState {
  return reduce(atResult(highAnalysis([candidate('a')])), {
    type: 'CONFIRM_CARD_PRESSED',
    candidate: candidate('a'),
  })
}

/** Drives through one confirmed card into the scanned summary. */
function atScanned(): ScannerState {
  return reduce(atConfirm(), { type: 'CARD_CONFIRMED' })
}

describe('scanner state machine — camera start discipline', () => {
  it('never requests the camera on the initial screen', () => {
    expect(initialScannerState.step).toBe('intro')
    expect(initialScannerState.cameraRequested).toBe(false)
  })

  it('marks the request only when Start camera is explicitly pressed', () => {
    const state = reduce(initialScannerState, { type: 'START_CAMERA_PRESSED' })
    expect(state.cameraRequested).toBe(true)
    expect(state.step).toBe('starting-camera')
  })

  it('returns to the intro (Choose-photo fallback intact) when the camera fails', () => {
    const requested = reduce(initialScannerState, { type: 'START_CAMERA_PRESSED' })
    const failed = reduce(requested, {
      type: 'CAMERA_FAILED',
      error: { title: 'Camera access was blocked', message: 'Allow access.' },
    })
    expect(failed.step).toBe('intro')
    expect(failed.cameraError?.title).toBe('Camera access was blocked')
  })

  it('exiting the live camera returns to the intro and preserves an existing batch', () => {
    const exited = reduce(reduce(atScanned(), { type: 'SCAN_NEXT_PRESSED' }), {
      type: 'CAMERA_EXITED',
    })
    expect(exited.step).toBe('intro')
    expect(exited.batch).toHaveLength(1)
  })
})

describe('scanner state machine — capture and analysis honesty', () => {
  it('moves capture → review → analyzing, one explicit step per action', () => {
    let state = reduce(reduce(initialScannerState, { type: 'START_CAMERA_PRESSED' }), {
      type: 'CAMERA_STARTED',
    })
    state = reduce(state, { type: 'CAPTURE_SUCCEEDED' })
    expect(state.step).toBe('review')
    state = reduce(state, { type: 'USE_PHOTO_PRESSED' })
    expect(state.step).toBe('analyzing')
  })

  it('a failed capture keeps the camera view and records the friendly error', () => {
    const live = reduce(reduce(initialScannerState, { type: 'START_CAMERA_PRESSED' }), {
      type: 'CAMERA_STARTED',
    })
    const failed = reduce(live, {
      type: 'CAPTURE_FAILED',
      error: { title: 'Capture failed', message: 'Try again.' },
    })
    expect(failed.step).toBe('camera')
    expect(failed.captureError?.title).toBe('Capture failed')
  })

  it('retake restarts the camera instead of pretending a photo still exists', () => {
    const reviewing = reduce(initialScannerState, { type: 'CAPTURE_SUCCEEDED' })
    expect(reduce(reviewing, { type: 'RETAKE_PRESSED' }).step).toBe('starting-camera')
  })

  it('cancelling analysis returns to review without losing the photo slot', () => {
    const reviewing = reduce(initialScannerState, { type: 'CAPTURE_SUCCEEDED' })
    const cancelled = reduce(reduce(reviewing, { type: 'USE_PHOTO_PRESSED' }), {
      type: 'ANALYSIS_CANCELLED',
    })
    expect(cancelled.step).toBe('review')
  })

  it('a failed analysis returns to review so the same photo can be retried', () => {
    const analyzing = reduce(initialScannerState, { type: 'CAPTURE_SUCCEEDED' })
    const failed = reduce(reduce(analyzing, { type: 'USE_PHOTO_PRESSED' }), {
      type: 'ANALYSIS_FAILED',
      error: { title: 'Scan did not go through', message: 'Try again.' },
    })
    expect(failed.step).toBe('review')
    expect(failed.analysisError?.title).toBe('Scan did not go through')
  })
})

describe('scanner state machine — result confirmation discipline', () => {
  it('shows a HIGH result with the top candidate preselected but NOTHING added yet', () => {
    const state = atResult(highAnalysis([candidate('a'), candidate('b')]))
    expect(state.step).toBe('result')
    expect(state.selectedCandidate?.candidateId).toBe('a')
    // HIGH does NOT mean added — the batch is untouched until explicit confirmation.
    expect(state.batch).toHaveLength(0)
  })

  it('leaves multiple low-confidence candidates UNSELECTED until the user taps one', () => {
    const ambiguous = atResult({
      confidence: 'LOW',
      candidates: [candidate('a'), candidate('b')],
    })
    expect(ambiguous.selectedCandidate).toBeNull()
    const tapped = reduce(ambiguous, { type: 'CANDIDATE_SELECTED', candidate: candidate('b') })
    expect(tapped.selectedCandidate?.candidateId).toBe('b')
  })

  it('preselects a lone MEDIUM candidate — nothing to disambiguate', () => {
    const state = atResult({ confidence: 'MEDIUM', candidates: [candidate('only')] })
    expect(state.selectedCandidate?.candidateId).toBe('only')
  })

  it('routes NO_MATCH to the dedicated recovery state', () => {
    const state = atResult({ confidence: 'NO_MATCH', candidates: [] })
    expect(state.step).toBe('no-match')
    expect(state.selectedCandidate).toBeNull()
  })
})

describe('scanner state machine — the in-memory batch', () => {
  it('confirmation starts at quantity 1 with the app-default condition (NM)', () => {
    const state = atConfirm()
    expect(state.step).toBe('confirm')
    expect(state.confirmQuantity).toBe('1')
    expect(SCANNER_DEFAULT_CONDITION).toBe('NM')
    expect(state.confirmCondition).toBe(SCANNER_DEFAULT_CONDITION)
  })

  it('rejects a bad quantity WITHOUT touching the batch', () => {
    const edited = reduce(atConfirm(), { type: 'CONFIRM_QUANTITY_CHANGED', value: '0' })
    const rejected = reduce(edited, { type: 'CARD_CONFIRMED' })
    expect(rejected.confirmValidationError).toBe('Enter a quantity of at least 1.')
    expect(rejected.batch).toHaveLength(0)
    expect(rejected.step).toBe('confirm')
  })

  it('confirming appends identity+quantity+condition to the batch and clears the working photo state', () => {
    const edited = reduce(atConfirm(), { type: 'CONFIRM_QUANTITY_CHANGED', value: '2' })
    const conditioned = reduce(edited, {
      type: 'CONFIRM_CONDITION_CHANGED',
      condition: 'EX',
    })
    const done = reduce(conditioned, { type: 'CARD_CONFIRMED' })
    expect(done.step).toBe('scanned')
    expect(done.batch).toHaveLength(1)
    expect(done.batch[0]?.candidate.candidateId).toBe('a')
    expect(done.batch[0]?.quantity).toBe(2)
    expect(done.batch[0]?.condition).toBe('EX')
    expect(done.analysis).toBeNull()
    expect(done.selectedCandidate).toBeNull()
  })

  it('batch entries carry IDENTITY ONLY — no blob or object-URL field can hide in them', () => {
    const done = atScanned()
    expect(Object.keys(done.batch[0] ?? {}).sort()).toEqual(['candidate', 'condition', 'quantity'])
    const serialized = JSON.stringify(done.batch)
    expect(serialized).not.toMatch(/blob|objectUrl|previewUrl|photo/i)
  })

  it('Scan next restarts the camera while the batch survives untouched', () => {
    const next = reduce(atScanned(), { type: 'SCAN_NEXT_PRESSED' })
    expect(next.step).toBe('starting-camera')
    expect(next.cameraRequested).toBe(true)
    expect(next.batch).toHaveLength(1)
  })
})

describe('scanner state machine — batch review editing', () => {
  function atReviewWithTwo(): ScannerState {
    let state = atScanned()
    state = reduce(state, { type: 'SCAN_NEXT_PRESSED' })
    state = reduce(state, { type: 'CAMERA_STARTED' })
    state = reduce(state, { type: 'CAPTURE_SUCCEEDED' })
    state = reduce(state, { type: 'USE_PHOTO_PRESSED' })
    state = reduce(state, {
      type: 'ANALYSIS_COMPLETED',
      analysis: highAnalysis([candidate('b')]),
    })
    state = reduce(state, { type: 'CONFIRM_CARD_PRESSED', candidate: candidate('b') })
    state = reduce(state, { type: 'CARD_CONFIRMED' })
    return reduce(state, { type: 'REVIEW_BATCH_PRESSED' })
  }

  it('Review batch opens the review over every confirmed card', () => {
    const state = atReviewWithTwo()
    expect(state.step).toBe('batch-review')
    expect(state.batch.map((item) => item.candidate.candidateId)).toEqual(['a', 'b'])
  })

  it('edits quantity and condition per row; a nonsense quantity keeps the previous value', () => {
    let state = atReviewWithTwo()
    state = reduce(state, { type: 'BATCH_ITEM_QUANTITY_CHANGED', index: 1, value: '4' })
    expect(state.batch[1]?.quantity).toBe(4)
    state = reduce(state, { type: 'BATCH_ITEM_QUANTITY_CHANGED', index: 1, value: 'not-a-number' })
    expect(state.batch[1]?.quantity).toBe(4)
    state = reduce(state, { type: 'BATCH_ITEM_CONDITION_CHANGED', index: 1, condition: 'GD' })
    expect(state.batch[1]?.condition).toBe('GD')
  })

  it('removing an item leaves its neighbours intact', () => {
    let state = atReviewWithTwo()
    state = reduce(state, { type: 'BATCH_ITEM_REMOVED', index: 0 })
    expect(state.batch.map((item) => item.candidate.candidateId)).toEqual(['b'])
  })
})

describe('scanner state machine — commit outcomes', () => {
  function atCommitting(): ScannerState {
    return reduce(atScanned(), { type: 'ADD_CARDS_PRESSED' })
  }

  it('Add cards enters committing without dropping anything', () => {
    const state = atCommitting()
    expect(state.step).toBe('committing')
    expect(state.commitError).toBeNull()
  })

  it('a commit FAILURE keeps the batch intact on the review screen — retry, not re-entry', () => {
    const failed = reduce(atCommitting(), {
      type: 'COMMIT_FAILED',
      error: { title: 'Cards were not added', message: 'Nothing was changed.' },
    })
    expect(failed.step).toBe('batch-review')
    expect(failed.commitError?.message).toBe('Nothing was changed.')
    expect(failed.batch).toHaveLength(1)
  })

  it('a commit SUCCESS clears the batch and reports the count', () => {
    const committed = reduce(atCommitting(), { type: 'COMMIT_SUCCEEDED', addedCount: 3 })
    expect(committed.step).toBe('committed')
    expect(committed.addedCount).toBe(3)
    expect(committed.batch).toHaveLength(0)
  })

  it('Done after success resets the machine and requests route exit', () => {
    const done = reduce(reduce(atCommitting(), { type: 'COMMIT_SUCCEEDED', addedCount: 1 }), {
      type: 'COMMITTED_DONE_PRESSED',
    })
    expect(done.exitRequested).toBe(true)
    expect(done.batch).toHaveLength(0)
    expect(done.step).toBe('intro')
  })
})

describe('scanner state machine — manual search fallback', () => {
  it('opens from no-match remembering where to return', () => {
    const noMatch = atResult({ confidence: 'NO_MATCH', candidates: [] })
    const opened = reduce(noMatch, { type: 'SEARCH_OPENED', from: 'no-match' })
    expect(opened.step).toBe('manual-search')
    expect(opened.searchReturnStep).toBe('no-match')
  })

  it('pending → results → selecting a result lands on confirm', () => {
    const opened = reduce(initialScannerState, { type: 'SEARCH_OPENED', from: 'no-match' })
    const pending = reduce(opened, { type: 'SEARCH_PENDING' })
    expect(pending.searchPending).toBe(true)
    const found = reduce(pending, { type: 'SEARCH_RESULTS', candidates: [candidate('s1')] })
    expect(found.searchResults).toHaveLength(1)
    const selected = reduce(found, {
      type: 'SEARCH_RESULT_SELECTED',
      candidate: candidate('s1'),
    })
    expect(selected.step).toBe('confirm')
    expect(selected.selectedCandidate?.candidateId).toBe('s1')
  })

  it('a search failure is shown and dismissible via close back to the flow', () => {
    const opened = reduce(initialScannerState, { type: 'SEARCH_OPENED', from: 'result' })
    const failed = reduce(opened, {
      type: 'SEARCH_FAILED',
      error: { title: 'Search failed', message: 'Try again.' },
    })
    expect(failed.searchError?.title).toBe('Search failed')
    const closed = reduce(failed, { type: 'SEARCH_CLOSED' })
    expect(closed.step).toBe('result')
  })

  it('closing a successful search clears transient results and returns to the origin step', () => {
    const opened = reduce(initialScannerState, { type: 'SEARCH_OPENED', from: 'no-match' })
    const found = reduce(opened, { type: 'SEARCH_RESULTS', candidates: [candidate('s1')] })
    const closed = reduce(found, { type: 'SEARCH_CLOSED' })
    expect(closed.step).toBe('no-match')
    expect(closed.searchResults).toHaveLength(0)
  })
})

describe('scanner state machine — exit discipline', () => {
  it('exiting with an EMPTY batch leaves immediately — nothing can be lost', () => {
    const exited = reduce(initialScannerState, { type: 'EXIT_PRESSED' })
    expect(exited.exitRequested).toBe(true)
    expect(exited.exitWarningOpen).toBe(false)
  })

  it('exiting with a NONEMPTY batch warns first and does not leave yet', () => {
    const warned = reduce(atScanned(), { type: 'EXIT_PRESSED' })
    expect(warned.exitWarningOpen).toBe(true)
    expect(warned.exitRequested).toBe(false)
    const cancelled = reduce(warned, { type: 'EXIT_CANCELLED' })
    expect(cancelled.exitWarningOpen).toBe(false)
    expect(cancelled.batch).toHaveLength(1)
  })

  it('confirming discard clears the session batch and then exits', () => {
    const discarded = reduce(reduce(atScanned(), { type: 'EXIT_PRESSED' }), {
      type: 'DISCARD_CONFIRMED',
    })
    expect(discarded.batch).toHaveLength(0)
    expect(discarded.exitRequested).toBe(true)
    expect(discarded.step).toBe('intro')
  })
})
