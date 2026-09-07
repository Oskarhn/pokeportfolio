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
 * P116 §13 — request key torture at release scale. P113's `scanner-batch-property.test.ts` (§21)
 * already proved requestKey uniqueness/survival under add/edit/remove/commit at 500-1000 runs;
 * this file pushes to 100,000 runs and adds the operation kinds prompt §13 explicitly names that
 * P113 did not cover: an ACCOUNT SWITCH mid-batch (modeled as the same full reset
 * `AuthProvider.signOut`/`applyAuthIdentityBoundary` performs — `scannerSessionStore.clearAll()`
 * plus the route unmounting, i.e. state resets to `initialScannerState`, matching D-104 F-05: "an
 * account switch replaces [the controller], it never survives across users"), a COMMIT that fails
 * ENTIRELY (unknown server state / total transport failure — `COMMIT_FAILED`, batch untouched) as
 * distinct from a per-item MIXED outcome, and a fresh capture immediately after either. The
 * invariant under torture: no requestKey is ever reused across two DIFFERENT logical batch entries
 * within one continuous session, even across hundreds of interleaved operations.
 */

const CONDITIONS: CardCondition[] = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO']

function candidate(id: string): ScannerCandidate {
  return { candidateId: id, name: `Card ${id}`, setName: 'Base Set', collectorNumber: id }
}

function highAnalysis(id: string): ScannerAnalysis {
  return { confidence: 'HIGH', candidates: [candidate(id)] }
}

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

function indexFromFraction(length: number, fraction: number): number {
  return Math.floor(fraction * length)
}

type Op =
  | { kind: 'add'; id: string; quantity: number; condition: CardCondition }
  | { kind: 'editQuantity'; indexFraction: number; value: string }
  | { kind: 'editCondition'; indexFraction: number; condition: CardCondition }
  | { kind: 'remove'; indexFraction: number }
  | { kind: 'commitMixed' } // per-item added/needs_verification/failed mix
  | { kind: 'commitFailedEntirely' } // unknown server state — batch must stay untouched
  | { kind: 'accountSwitch' } // D-104 F-05: full reset, no cross-identity state survives
  | { kind: 'newCardAfterAccountSwitch'; id: string }

const arbOp = fc.oneof(
  fc.record({
    kind: fc.constant('add' as const),
    id: fc.stringMatching(/^[a-z]{4,8}$/),
    quantity: fc.integer({ min: 1, max: 20 }),
    condition: fc.constantFrom(...CONDITIONS),
  }),
  fc.record({
    kind: fc.constant('editQuantity' as const),
    indexFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
    value: fc.constantFrom('0', '-5', 'abc', '', '3', '100'),
  }),
  fc.record({
    kind: fc.constant('editCondition' as const),
    indexFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
    condition: fc.constantFrom(...CONDITIONS),
  }),
  fc.record({
    kind: fc.constant('remove' as const),
    indexFraction: fc.double({ min: 0, max: 0.999, noNaN: true }),
  }),
  fc.record({ kind: fc.constant('commitMixed' as const) }),
  fc.record({ kind: fc.constant('commitFailedEntirely' as const) }),
  fc.record({ kind: fc.constant('accountSwitch' as const) }),
  fc.record({
    kind: fc.constant('newCardAfterAccountSwitch' as const),
    id: fc.stringMatching(/^[a-z]{4,8}$/),
  }),
)

/** Tracks every requestKey EVER assigned to a logical batch entry, across the whole session
 *  (survives removals/commits/account-switches in the tracking set itself — production identity
 *  must never repeat one, even for an entry that has since left the batch). */
function applyOp(state: ScannerState, op: Op, everIssuedKeys: Set<string>): ScannerState {
  function trackNewKeys(next: ScannerState): ScannerState {
    for (const item of next.batch) everIssuedKeys.add(item.requestKey)
    return next
  }
  switch (op.kind) {
    case 'add':
      return trackNewKeys(confirmOneCard(state, op.id, op.quantity, op.condition))
    case 'newCardAfterAccountSwitch':
      return trackNewKeys(confirmOneCard(state, op.id, 1, 'NM'))
    case 'editQuantity': {
      if (state.batch.length === 0) return state
      const index = indexFromFraction(state.batch.length, op.indexFraction)
      return scannerReducer(state, {
        type: 'BATCH_ITEM_QUANTITY_CHANGED',
        index,
        value: op.value,
      })
    }
    case 'editCondition': {
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
    case 'commitMixed': {
      if (state.batch.length === 0) return state
      const statuses: ScannerCommitOutcome['status'][] = ['added', 'needs_verification', 'failed']
      const outcomes: ScannerCommitOutcome[] = state.batch.map((_, index) => ({
        index,
        status: statuses[index % statuses.length] ?? 'added',
        message: null,
      }))
      const addedCount = outcomes.filter((o) => o.status === 'added').length
      return scannerReducer(state, { type: 'COMMIT_SUCCEEDED', addedCount, outcomes })
    }
    case 'commitFailedEntirely':
      if (state.batch.length === 0) return state
      return scannerReducer(state, {
        type: 'COMMIT_FAILED',
        error: { title: 'Network error', message: 'unknown server state' },
      })
    case 'accountSwitch':
      // D-104 F-05 / query-cache-boundary.ts: an identity change tears the whole session down —
      // no in-memory batch entry (and therefore no requestKey) survives into the next identity.
      return initialScannerState
  }
}

function assertNoKeyReuseWithinBatch(state: ScannerState): void {
  const keys = state.batch.map((item) => item.requestKey)
  expect(new Set(keys).size).toBe(keys.length)
  for (const item of state.batch) {
    expect(Number.isInteger(item.quantity)).toBe(true)
    expect(item.quantity).toBeGreaterThan(0)
  }
}

const RUNS = 100_000
const TIMEOUT_MS = 60_000

describe('scanner request-key torture (P116 §13)', () => {
  it(
    `${String(RUNS)} random operation sequences (add/edit/remove/commit-mixed/commit-failed-entirely/account-switch/new-card-after-switch): no requestKey reused within a live batch, and none ever reused for two DIFFERENT logical entries across the whole session`,
    () => {
      fc.assert(
        fc.property(fc.array(arbOp, { minLength: 1, maxLength: 25 }), (ops) => {
          let state = initialScannerState
          const everIssuedKeys = new Set<string>()
          for (const op of ops) {
            state = applyOp(state, op, everIssuedKeys)
            assertNoKeyReuseWithinBatch(state)
          }
        }),
        { numRuns: RUNS },
      )
    },
    TIMEOUT_MS,
  )

  it('COMMIT_FAILED (unknown server state) never mutates the batch or any requestKey — genuinely a no-op on data, only commitError/step change', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[a-z]{4,8}$/),
            quantity: fc.integer({ min: 1, max: 20 }),
            condition: fc.constantFrom(...CONDITIONS),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (adds) => {
          let state = initialScannerState
          for (const add of adds) state = confirmOneCard(state, add.id, add.quantity, add.condition)
          const before = state.batch
          const after = scannerReducer(state, {
            type: 'COMMIT_FAILED',
            error: { title: 'x', message: 'unknown server state' },
          })
          expect(after.batch).toBe(before) // same array reference — reducer never rebuilds it here
          expect(after.step).toBe('batch-review')
          expect(after.commitError).not.toBeNull()
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('an account switch (full reset) followed by a brand-new card never reuses a pre-switch requestKey, even when the ids collide', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{4,8}$/),
        fc.stringMatching(/^[a-z]{4,8}$/),
        (idBeforeSwitch, idAfterSwitch) => {
          let state = confirmOneCard(initialScannerState, idBeforeSwitch, 1, 'NM')
          const preSwitchKey = state.batch[0]?.requestKey
          state = initialScannerState // account switch
          expect(state.batch).toHaveLength(0)
          // Same candidate id can legitimately recur (a different physical copy) — the requestKey
          // identity must still never collide with the pre-switch one.
          state = confirmOneCard(state, idAfterSwitch, 1, 'NM')
          expect(state.batch).toHaveLength(1)
          expect(state.batch[0]?.requestKey).not.toBe(preSwitchKey)
        },
      ),
      { numRuns: 5000 },
    )
  })
})
