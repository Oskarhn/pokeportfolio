import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CardCondition } from '../../src/data/collection'
import type {
  ScannerAnalysis,
  ScannerCandidate,
  ScannerCommitOutcome,
} from '../../src/features/scanner/contract'
import {
  initialScannerState,
  scannerReducer,
  type ScannerState,
} from '../../src/features/scanner/state'

/**
 * P113 §21 — batch state property tests. `scanner-state.test.ts` covers the state machine's
 * documented transition rules with hand-picked scenarios; this file generates thousands of
 * random OPERATION SEQUENCES (add/change-quantity/change-condition/remove/commit) and drives them
 * through the REAL `scannerReducer`, asserting invariants that must hold after EVERY single step,
 * not just at a scenario's end: no negative/zero quantities, no duplicate internal
 * (`requestKey`) ids, `needsVerification` state is never silently lost or bypassed, and no
 * operation ever discards more (or less) of the batch than it names.
 */

const CONDITIONS: CardCondition[] = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO']

function candidate(id: string): ScannerCandidate {
  return { candidateId: id, name: `Card ${id}`, setName: 'Base Set', collectorNumber: id }
}

function highAnalysis(id: string): ScannerAnalysis {
  return { confidence: 'HIGH', candidates: [candidate(id)] }
}

/** Drives one full "confirm and add a card to the batch" cycle through the REAL reducer,
 *  starting a fresh camera/capture/analysis cycle each time — the exact sequence
 *  `ScannerPage`/`controller.ts` actually issue, never a shortcut that skips real transitions. */
function confirmOneCard(
  state: ScannerState,
  id: string,
  quantity: number,
  condition: CardCondition,
): ScannerState {
  let s = state
  s =
    s.step === 'intro'
      ? scannerReducer(s, { type: 'START_CAMERA_PRESSED' })
      : scannerReducer(s, { type: 'SCAN_NEXT_PRESSED' })
  s = scannerReducer(s, { type: 'CAMERA_STARTED' })
  s = scannerReducer(s, { type: 'CAPTURE_SUCCEEDED' })
  s = scannerReducer(s, { type: 'USE_PHOTO_PRESSED' })
  s = scannerReducer(s, { type: 'ANALYSIS_COMPLETED', analysis: highAnalysis(id) })
  s = scannerReducer(s, { type: 'CONFIRM_CARD_PRESSED', candidate: candidate(id) })
  s = scannerReducer(s, { type: 'CONFIRM_QUANTITY_CHANGED', value: String(quantity) })
  s = scannerReducer(s, { type: 'CONFIRM_CONDITION_CHANGED', condition })
  s = scannerReducer(s, {
    type: 'CONFIRM_VARIANTS_LOADED',
    variants: [{ id: 'variant-1', label: 'Normal' }],
  })
  s = scannerReducer(s, { type: 'CONFIRM_VARIANT_CHANGED', variantId: 'variant-1' })
  return scannerReducer(s, { type: 'CARD_CONFIRMED' })
}

function assertBatchInvariants(state: ScannerState): void {
  for (const item of state.batch) {
    expect(Number.isInteger(item.quantity)).toBe(true)
    expect(item.quantity).toBeGreaterThan(0)
  }
  const requestKeys = state.batch.map((item) => item.requestKey)
  expect(new Set(requestKeys).size).toBe(requestKeys.length)
}

type Op =
  | { kind: 'add'; id: string; quantity: number; condition: CardCondition }
  | { kind: 'changeQuantity'; indexFraction: number; value: string }
  | { kind: 'changeCondition'; indexFraction: number; condition: CardCondition }
  | { kind: 'remove'; indexFraction: number }
  | { kind: 'commitAll' }

const arbOp = fc.oneof(
  fc.record({
    kind: fc.constant('add' as const),
    id: fc.stringMatching(/^[a-z]{4,8}$/),
    quantity: fc.integer({ min: 1, max: 20 }),
    condition: fc.constantFrom(...CONDITIONS),
  }),
  fc.record({
    kind: fc.constant('changeQuantity' as const),
    indexFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
    // Deliberately includes non-numeric/negative/zero raw text — parseBatchQuantity's own job is
    // to reject these back to the item's existing (already-valid) quantity.
    value: fc.constantFrom('0', '-5', 'abc', '', '3', '100'),
  }),
  fc.record({
    kind: fc.constant('changeCondition' as const),
    indexFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
    condition: fc.constantFrom(...CONDITIONS),
  }),
  fc.record({
    kind: fc.constant('remove' as const),
    indexFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
  }),
  fc.record({ kind: fc.constant('commitAll' as const) }),
)

function indexFromFraction(length: number, fraction: number): number {
  return Math.floor(fraction * length)
}

function applyOp(state: ScannerState, op: Op): ScannerState {
  switch (op.kind) {
    case 'add':
      return confirmOneCard(state, op.id, op.quantity, op.condition)
    case 'changeQuantity': {
      if (state.batch.length === 0) return state
      const index = indexFromFraction(state.batch.length, op.indexFraction)
      return scannerReducer(state, { type: 'BATCH_ITEM_QUANTITY_CHANGED', index, value: op.value })
    }
    case 'changeCondition': {
      if (state.batch.length === 0) return state
      const index = indexFromFraction(state.batch.length, op.indexFraction)
      return scannerReducer(state, {
        type: 'BATCH_ITEM_CONDITION_CHANGED',
        index,
        condition: op.condition,
      })
    }
    case 'remove': {
      if (state.batch.length === 0) return state
      const index = indexFromFraction(state.batch.length, op.indexFraction)
      return scannerReducer(state, { type: 'BATCH_ITEM_REMOVED', index })
    }
    case 'commitAll': {
      if (state.batch.length === 0) return state
      // Deterministic "everything succeeded" outcome — commit-outcome MIXES are covered by the
      // dedicated needsVerification-preservation property below, which needs finer control over
      // exactly which indices survive.
      const outcomes: ScannerCommitOutcome[] = state.batch.map((_, index) => ({
        index,
        status: 'added',
        message: null,
      }))
      return scannerReducer(state, {
        type: 'COMMIT_SUCCEEDED',
        addedCount: state.batch.length,
        outcomes,
      })
    }
  }
}

const FUZZ_TEST_TIMEOUT_MS = 30_000

describe('scanner batch — random operation sequences (P113 §21)', () => {
  it(
    '1000 random seeded operation sequences (add/quantity/condition/remove/commit): batch invariants hold after every step',
    () => {
      fc.assert(
        fc.property(fc.array(arbOp, { minLength: 1, maxLength: 40 }), (ops) => {
          let state = initialScannerState
          for (const op of ops) {
            state = applyOp(state, op)
            assertBatchInvariants(state)
          }
        }),
        { numRuns: 1000 },
      )
    },
    FUZZ_TEST_TIMEOUT_MS,
  )

  it('BATCH_ITEM_REMOVED always removes EXACTLY the targeted item — no neighbor is silently dropped', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[a-z]{4,8}$/),
            quantity: fc.integer({ min: 1, max: 20 }),
            condition: fc.constantFrom(...CONDITIONS),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        (adds, removeFraction) => {
          let state = initialScannerState
          for (const add of adds) state = confirmOneCard(state, add.id, add.quantity, add.condition)
          const beforeKeys = state.batch.map((item) => item.requestKey)
          const removeIndex = indexFromFraction(state.batch.length, removeFraction)
          const removedKey = beforeKeys[removeIndex]
          const after = scannerReducer(state, { type: 'BATCH_ITEM_REMOVED', index: removeIndex })
          expect(after.batch).toHaveLength(beforeKeys.length - 1)
          expect(after.batch.map((item) => item.requestKey)).toEqual(
            beforeKeys.filter((key) => key !== removedKey),
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('needsVerification is never lost across subsequent quantity/condition-change attempts, and those attempts are frozen no-ops', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{4,8}$/),
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom(...CONDITIONS),
        fc.constantFrom(...CONDITIONS),
        fc.string({ minLength: 1, maxLength: 4 }).filter((s) => /^\d+$/.test(s)),
        (id, quantity, originalCondition, attemptedCondition, attemptedQuantityText) => {
          let state = confirmOneCard(initialScannerState, id, quantity, originalCondition)
          // Force this single item into needs_verification via a commit whose outcome says so.
          state = scannerReducer(state, {
            type: 'COMMIT_SUCCEEDED',
            addedCount: 0,
            outcomes: [{ index: 0, status: 'needs_verification', message: null }],
          })
          expect(state.batch).toHaveLength(1)
          expect(state.batch[0]?.needsVerification).toBe(true)

          const afterQuantityAttempt = scannerReducer(state, {
            type: 'BATCH_ITEM_QUANTITY_CHANGED',
            index: 0,
            value: attemptedQuantityText,
          })
          const afterConditionAttempt = scannerReducer(afterQuantityAttempt, {
            type: 'BATCH_ITEM_CONDITION_CHANGED',
            index: 0,
            condition: attemptedCondition,
          })

          // Frozen: neither material field moved, and the flag itself survived both attempts.
          expect(afterConditionAttempt.batch[0]?.quantity).toBe(quantity)
          expect(afterConditionAttempt.batch[0]?.condition).toBe(originalCondition)
          expect(afterConditionAttempt.batch[0]?.needsVerification).toBe(true)
          expect(afterConditionAttempt.batch[0]?.requestKey).toBe(state.batch[0]?.requestKey)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('COMMIT_SUCCEEDED never resurrects a removed item and never invents a survivor requestKey', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[a-z]{4,8}$/),
            quantity: fc.integer({ min: 1, max: 20 }),
            condition: fc.constantFrom(...CONDITIONS),
          }),
          { minLength: 2, maxLength: 6 },
        ),
        fc.array(
          fc.constantFrom<ScannerCommitOutcome['status']>('added', 'needs_verification', 'failed'),
          {
            minLength: 2,
            maxLength: 6,
          },
        ),
        (adds, statusesRaw) => {
          let state = initialScannerState
          for (const add of adds) state = confirmOneCard(state, add.id, add.quantity, add.condition)
          const preKeys = state.batch.map((item) => item.requestKey)
          const statuses = statusesRaw.slice(0, state.batch.length)
          const outcomes: ScannerCommitOutcome[] = statuses.map((status, index) => ({
            index,
            status,
            message: null,
          }))
          const addedCount = outcomes.filter((o) => o.status === 'added').length
          const after = scannerReducer(state, { type: 'COMMIT_SUCCEEDED', addedCount, outcomes })

          const expectedSurvivorKeys = preKeys.filter(
            (_, index) => outcomes[index]?.status !== 'added',
          )
          expect(after.batch.map((item) => item.requestKey)).toEqual(expectedSurvivorKeys)
          // Every survivor's requestKey must have existed in the PRE-commit batch — never a new
          // identity fabricated by the commit path itself.
          for (const key of after.batch.map((item) => item.requestKey)) {
            expect(preKeys).toContain(key)
          }
        },
      ),
      { numRuns: 500 },
    )
  })
})
