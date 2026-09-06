import { describe, expect, it } from 'vitest'
import type {
  ScannerAnalysis,
  ScannerCandidate,
  ScannerCommitOutcome,
  ScannerVariantChoice,
} from '../../src/features/scanner/contract'
import {
  SCANNER_DEFAULT_CONDITION,
  initialScannerState,
  scannerReducer,
  type ScannerState,
} from '../../src/features/scanner/state'

/**
 * The scanner UI state machine (P66 + P68 integration), verified in isolation. Every rule the
 * prompt pins down is a transition assertion here: permission only after an explicit action,
 * HIGH still requires confirmation, printing choice loads only after a candidate is chosen and
 * must be selected before anything joins the batch, confirmation appends to an IN-MEMORY batch
 * and never commits, commit outcomes are honest per item, exit warns when a nonempty batch
 * would be lost — and batch entries carry card identity only, never a captured photo.
 */

function candidate(id: string): ScannerCandidate {
  return { candidateId: id, name: `Card ${id}`, setName: 'Base Set', collectorNumber: id }
}

const oneVariant: ScannerVariantChoice[] = [{ id: 'variant-1', label: 'Normal' }]

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

/** Drives to the confirm step for candidate "a" (printing choices still loading). */
function atConfirm(): ScannerState {
  return reduce(atResult(highAnalysis([candidate('a')])), {
    type: 'CONFIRM_CARD_PRESSED',
    candidate: candidate('a'),
  })
}

/** Loads printing choices for the confirm step. */
function variantsLoaded(
  state: ScannerState,
  variants: ScannerVariantChoice[] = oneVariant,
): ScannerState {
  return reduce(state, { type: 'CONFIRM_VARIANTS_LOADED', variants })
}

/** Drives through one confirmed card into the scanned summary. */
function atScanned(): ScannerState {
  return reduce(variantsLoaded(atConfirm()), { type: 'CARD_CONFIRMED' })
}

/** Drives through TWO confirmed cards (candidates "a" and "b") into batch review. */
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
  state = variantsLoaded(state)
  state = reduce(state, { type: 'CARD_CONFIRMED' })
  return reduce(state, { type: 'REVIEW_BATCH_PRESSED' })
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

  it('preselects a lone LOW candidate but the batch stays untouched until explicit confirmation (P98/§9)', () => {
    // Mirrors the HIGH assertion above: preselecting the only option is a UX convenience (no need
    // to tap a single-item list before "Confirm card" becomes available), never a shortcut around
    // the explicit confirmation gate itself — a LOW-confidence result must never end up silently
    // added to the batch just because there was nothing to disambiguate.
    const state = atResult({ confidence: 'LOW', candidates: [candidate('only')] })
    expect(state.step).toBe('result')
    expect(state.selectedCandidate?.candidateId).toBe('only')
    expect(state.batch).toHaveLength(0)
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

  it('confirming appends identity+variant+quantity+condition to the batch and clears the working photo state', () => {
    const edited = reduce(variantsLoaded(atConfirm()), {
      type: 'CONFIRM_QUANTITY_CHANGED',
      value: '2',
    })
    const conditioned = reduce(edited, {
      type: 'CONFIRM_CONDITION_CHANGED',
      condition: 'EX',
    })
    const done = reduce(conditioned, { type: 'CARD_CONFIRMED' })
    expect(done.step).toBe('scanned')
    expect(done.batch).toHaveLength(1)
    expect(done.batch[0]?.candidate.candidateId).toBe('a')
    expect(done.batch[0]?.variantId).toBe('variant-1')
    expect(done.batch[0]?.quantity).toBe(2)
    expect(done.batch[0]?.condition).toBe('EX')
    expect(done.analysis).toBeNull()
    expect(done.selectedCandidate).toBeNull()
  })

  it('CARD_CONFIRMED is refused until a printing is chosen (prompt §22)', () => {
    const rejected = reduce(atConfirm(), { type: 'CARD_CONFIRMED' })
    expect(rejected.step).toBe('confirm')
    expect(rejected.confirmValidationError).toBe('Choose which version of this card you have.')
    expect(rejected.batch).toHaveLength(0)
  })

  it('exactly one printing preselects itself; several stay unchosen', () => {
    const single = variantsLoaded(atConfirm())
    expect(single.confirmVariantId).toBe('variant-1')
    const several = variantsLoaded(atConfirm(), [
      { id: 'v1', label: 'Normal' },
      { id: 'v2', label: 'Holo' },
    ])
    expect(several.confirmVariantId).toBeNull()
    const picked = reduce(several, { type: 'CONFIRM_VARIANT_CHANGED', variantId: 'v2' })
    expect(picked.confirmVariantId).toBe('v2')
  })

  it('printing choices load only AFTER a candidate is chosen, never for result rows', () => {
    const result = atResult(highAnalysis([candidate('a'), candidate('b')]))
    // Sitting on the result list triggers no variant work at all.
    expect(result.confirmVariants).toBeNull()
    expect(result.confirmVariantsPending).toBe(false)
    const confirm = atConfirm()
    expect(confirm.confirmVariantsPending).toBe(true)
  })

  it('batch entries carry IDENTITY ONLY — no blob or object-URL field can hide in them', () => {
    const done = atScanned()
    expect(Object.keys(done.batch[0] ?? {}).sort()).toEqual([
      'candidate',
      'condition',
      'quantity',
      'requestKey',
      'variantId',
      'variantLabel',
    ])
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

  it('F-19/§8: a needsVerification item freezes quantity and condition edits', () => {
    let state = atReviewWithTwo()
    // Simulate the item having survived a partial commit as needs_verification (the shape
    // COMMIT_SUCCEEDED itself produces — reproduced directly here since this describe block
    // exercises batch-review editing in isolation from commit outcomes).
    state = {
      ...state,
      batch: state.batch.map((item, index) =>
        index === 1 ? { ...item, needsVerification: true } : item,
      ),
    }
    const originalQuantity = state.batch[1]?.quantity
    const originalCondition = state.batch[1]?.condition
    const afterQuantityAttempt = reduce(state, {
      type: 'BATCH_ITEM_QUANTITY_CHANGED',
      index: 1,
      value: '9',
    })
    expect(afterQuantityAttempt.batch[1]?.quantity).toBe(originalQuantity)
    const afterConditionAttempt = reduce(state, {
      type: 'BATCH_ITEM_CONDITION_CHANGED',
      index: 1,
      condition: 'PO',
    })
    expect(afterConditionAttempt.batch[1]?.condition).toBe(originalCondition)
    // The OTHER item (not flagged) still edits normally — the freeze is per-item, not global.
    const editsOtherItem = reduce(state, {
      type: 'BATCH_ITEM_QUANTITY_CHANGED',
      index: 0,
      value: '5',
    })
    expect(editsOtherItem.batch[0]?.quantity).toBe(5)
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

  it('a commit SUCCESS clears the batch and reports the count (all items added)', () => {
    const committed = reduce(atCommitting(), {
      type: 'COMMIT_SUCCEEDED',
      addedCount: 3,
      outcomes: [{ index: 0, status: 'added', message: null }],
    })
    expect(committed.step).toBe('committed')
    expect(committed.addedCount).toBe(3)
    expect(committed.batch).toHaveLength(0)
  })

  it('a PARTIAL commit keeps non-added items in the batch and reports honest counts', () => {
    // Two confirmed cards; the first added, the second definitively rejected.
    const two = atReviewWithTwo()
    const committing = reduce(two, { type: 'ADD_CARDS_PRESSED' })
    const outcomes: ScannerCommitOutcome[] = [
      { index: 0, status: 'added', message: null },
      { index: 1, status: 'failed', message: 'The server did not accept this card.' },
    ]
    const committed = reduce(committing, { type: 'COMMIT_SUCCEEDED', addedCount: 1, outcomes })
    expect(committed.step).toBe('committed')
    expect(committed.addedCount).toBe(1)
    expect(committed.attentionCount).toBe(1)
    expect(committed.batch.map((item) => item.candidate.candidateId)).toEqual(['b'])
    expect(committed.batch[0]?.needsVerification).toBeUndefined()
  })

  it('an INTERRUPTED transport marks the survivor needs_verification instead of guessing', () => {
    const committing = reduce(atReviewWithTwo(), { type: 'ADD_CARDS_PRESSED' })
    const committed = reduce(committing, {
      type: 'COMMIT_SUCCEEDED',
      addedCount: 1,
      outcomes: [
        { index: 0, status: 'added', message: null },
        {
          index: 1,
          status: 'needs_verification',
          message: 'Connection was interrupted. This card may already have been added.',
        },
      ],
    })
    expect(committed.batch).toHaveLength(1)
    expect(committed.batch[0]?.needsVerification).toBe(true)
    // Retrying after review must NOT resubmit the definite success.
    const retry = reduce(committed, { type: 'REVIEW_BATCH_PRESSED' })
    expect(retry.batch.map((item) => item.candidate.candidateId)).toEqual(['b'])
  })

  it('Done after success resets the machine and requests route exit', () => {
    const done = reduce(
      reduce(atCommitting(), {
        type: 'COMMIT_SUCCEEDED',
        addedCount: 1,
        outcomes: [{ index: 0, status: 'added', message: null }],
      }),
      {
        type: 'COMMITTED_DONE_PRESSED',
      },
    )
    expect(done.exitRequested).toBe(true)
    expect(done.batch).toHaveLength(0)
    expect(done.step).toBe('intro')
  })

  it('F-09: Done after a PARTIAL commit never silently discards survivor items', () => {
    const committed = reduce(atReviewWithTwo(), { type: 'ADD_CARDS_PRESSED' })
    const partial = reduce(committed, {
      type: 'COMMIT_SUCCEEDED',
      addedCount: 1,
      outcomes: [
        { index: 0, status: 'added', message: null },
        { index: 1, status: 'needs_verification', message: 'Connection was interrupted.' },
      ],
    })
    expect(partial.batch).toHaveLength(1)
    const done = reduce(partial, { type: 'COMMITTED_DONE_PRESSED' })
    // Must NOT behave like the all-success case: no silent reset, no exit request. The survivor
    // item stays exactly where it was, and the machine instead opens the same discard-
    // confirmation guard every other exit path in this feature already enforces.
    expect(done.exitRequested).toBe(false)
    expect(done.step).toBe('committed')
    expect(done.batch).toHaveLength(1)
    expect(done.batch[0]?.needsVerification).toBe(true)
    expect(done.exitWarningOpen).toBe(true)

    // "Review remaining" (the reused REVIEW_BATCH_PRESSED action) returns to batch-review with
    // the survivor intact and clears the warning implicitly by moving off 'committed'.
    const reviewing = reduce(done, { type: 'REVIEW_BATCH_PRESSED' })
    expect(reviewing.step).toBe('batch-review')
    expect(reviewing.batch).toHaveLength(1)

    // Explicitly discarding from the warning sheet still works and still requests exit — this is
    // the only path that may drop the survivor record.
    const discarded = reduce(done, { type: 'DISCARD_CONFIRMED' })
    expect(discarded.exitRequested).toBe(true)
    expect(discarded.batch).toHaveLength(0)
  })

  it('F-09: Done after a full-success TWO-item commit behaves like plain success (no warning)', () => {
    // Every item 'added' ⇒ batch ends up empty; Done must still take the plain-exit path rather
    // than opening an empty-batch warning sheet with nothing to review.
    const committing = reduce(atReviewWithTwo(), { type: 'ADD_CARDS_PRESSED' })
    const committed = reduce(committing, {
      type: 'COMMIT_SUCCEEDED',
      addedCount: 2,
      outcomes: [
        { index: 0, status: 'added', message: null },
        { index: 1, status: 'added', message: null },
      ],
    })
    expect(committed.batch).toHaveLength(0)
    const done = reduce(committed, { type: 'COMMITTED_DONE_PRESSED' })
    expect(done.exitRequested).toBe(true)
    expect(done.exitWarningOpen).toBe(false)
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

describe('scanner state machine — §25 (P89): 10+ card soak', () => {
  /** Drives one full capture -> analyze -> confirm -> scanned cycle for `id`, appending it to
   *  whatever batch `state` already carries — the same shape atReviewWithTwo() hand-rolls for
   *  exactly two cards, generalized to N so a soak test can drive it in a loop. */
  function scanOneMoreCard(state: ScannerState, id: string): ScannerState {
    let next = reduce(state, { type: 'SCAN_NEXT_PRESSED' })
    next = reduce(next, { type: 'CAMERA_STARTED' })
    next = reduce(next, { type: 'CAPTURE_SUCCEEDED' })
    next = reduce(next, { type: 'USE_PHOTO_PRESSED' })
    next = reduce(next, { type: 'ANALYSIS_COMPLETED', analysis: highAnalysis([candidate(id)]) })
    next = reduce(next, { type: 'CONFIRM_CARD_PRESSED', candidate: candidate(id) })
    next = variantsLoaded(next)
    return reduce(next, { type: 'CARD_CONFIRMED' })
  }

  it('10 consecutive capture/analyze/confirm cycles: no candidate bleed, no key collisions, correct order', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `soak-${i}`)
    let state = atScanned() // card 0 already confirmed via the standard happy-path helper
    for (const id of ids.slice(1)) {
      state = scanOneMoreCard(state, id)
    }

    expect(state.batch).toHaveLength(10)
    // Order preserved, no candidate bleed between cycles (each item names ITS OWN card, not a
    // neighbour's or a stale one from an earlier cycle).
    expect(state.batch.map((item) => item.candidate.candidateId)).toEqual(['a', ...ids.slice(1)])
    // Every requestKey is genuinely unique — no two items silently share an idempotency key
    // across a long session (would risk exactly the F-19 material-mismatch class if it ever
    // happened).
    const keys = new Set(state.batch.map((item) => item.requestKey))
    expect(keys.size).toBe(10)
    // Every item carries a real variant selection — CARD_CONFIRMED's own guard (§22) means none
    // of these 10 cycles could have silently skipped that requirement.
    expect(state.batch.every((item) => item.variantId === 'variant-1')).toBe(true)

    // The batch survives review and commits as one coherent unit.
    const reviewing = reduce(state, { type: 'REVIEW_BATCH_PRESSED' })
    expect(reviewing.step).toBe('batch-review')
    expect(reviewing.batch).toHaveLength(10)
    const committing = reduce(reviewing, { type: 'ADD_CARDS_PRESSED' })
    const outcomes: ScannerCommitOutcome[] = ids.map((_id, index) => ({
      index,
      status: 'added',
      message: null,
    }))
    const committed = reduce(committing, {
      type: 'COMMIT_SUCCEEDED',
      addedCount: 10,
      outcomes,
    })
    expect(committed.addedCount).toBe(10)
    expect(committed.batch).toHaveLength(0)
    expect(committed.attentionCount).toBeNull()
  })

  it('10-card soak with every 3rd item interrupted (needs_verification): survivors carry exactly the right identities', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `soak-${i}`)
    let state = atScanned()
    for (const id of ids.slice(1)) {
      state = scanOneMoreCard(state, id)
    }
    const committing = reduce(state, { type: 'ADD_CARDS_PRESSED' })
    const interruptedIndexes = new Set([2, 5, 8])
    const outcomes: ScannerCommitOutcome[] = ids.map((_id, index) => ({
      index,
      status: interruptedIndexes.has(index) ? 'needs_verification' : 'added',
      message: interruptedIndexes.has(index) ? 'Connection was interrupted.' : null,
    }))
    const committed = reduce(committing, {
      type: 'COMMIT_SUCCEEDED',
      addedCount: 7,
      outcomes,
    })
    expect(committed.addedCount).toBe(7)
    expect(committed.attentionCount).toBe(3)
    expect(committed.batch).toHaveLength(3)
    // Exactly the interrupted cards survive, in their original order, each correctly flagged.
    const allIds = ['a', ...ids.slice(1)]
    expect(committed.batch.map((item) => item.candidate.candidateId)).toEqual(
      [...interruptedIndexes].sort((x, y) => x - y).map((index) => allIds[index]),
    )
    expect(committed.batch.every((item) => item.needsVerification === true)).toBe(true)
  })
})
