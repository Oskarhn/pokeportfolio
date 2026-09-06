import { afterEach, describe, expect, it } from 'vitest'
import {
  DirtyByDiffBaseline,
  hasAnyUnsavedWork,
  registerUnsavedWorkSource,
  resetUnsavedWorkRegistryForTests,
} from '../../src/platform/unsaved-work-registry'

/**
 * F-40 (P89): the core registry logic, tested independently of React (the hook wrappers
 * `useUnsavedWorkSource`/`useIsDirtyByDiff`/`useUnsavedWorkSnapshot` are thin glue over these
 * same functions — this codebase has no React Testing Library / hook-renderer, and no other hook
 * in the codebase (e.g. useDebouncedValue) carries a dedicated unit test either; component-level
 * wiring is verified by typecheck + code review, matching that existing convention).
 *
 * This is the module build-freshness-runtime.ts's `hasUnsavedWork` dependency now points at
 * instead of the scanner-only flag alone — see that module's own tests for the end-to-end
 * "a nonempty source blocks the automatic reload" proof.
 */

afterEach(() => {
  resetUnsavedWorkRegistryForTests()
})

describe('unsaved-work-registry', () => {
  it('reports false with nothing registered', () => {
    expect(hasAnyUnsavedWork()).toBe(false)
  })

  it('reports true the instant ANY registered source currently reports unsaved work', () => {
    registerUnsavedWorkSource('a', () => false)
    registerUnsavedWorkSource('b', () => true)
    registerUnsavedWorkSource('c', () => false)
    expect(hasAnyUnsavedWork()).toBe(true)
  })

  it('is the live union — a getter flipping true/false is reflected on the NEXT read, not cached', () => {
    let dirty = false
    registerUnsavedWorkSource('form', () => dirty)
    expect(hasAnyUnsavedWork()).toBe(false)
    dirty = true
    expect(hasAnyUnsavedWork()).toBe(true)
    dirty = false
    expect(hasAnyUnsavedWork()).toBe(false)
  })

  it('unregistering removes exactly that source', () => {
    const unregisterA = registerUnsavedWorkSource('a', () => true)
    registerUnsavedWorkSource('b', () => false)
    expect(hasAnyUnsavedWork()).toBe(true)
    unregisterA()
    expect(hasAnyUnsavedWork()).toBe(false)
  })

  it('re-registering the same id replaces the getter; only the LATEST registration for that id counts', () => {
    registerUnsavedWorkSource('form', () => true)
    registerUnsavedWorkSource('form', () => false)
    expect(hasAnyUnsavedWork()).toBe(false)
  })

  it('an unregister call from a SUPERSEDED registration cannot evict the newer one (out-of-order cleanup safety)', () => {
    // Mirrors the React-effect-rerun shape useUnsavedWorkSource relies on: an old effect's
    // cleanup can fire AFTER a new effect for the same id has already registered.
    const unregisterFirst = registerUnsavedWorkSource('form', () => true)
    registerUnsavedWorkSource('form', () => true)
    unregisterFirst()
    expect(hasAnyUnsavedWork()).toBe(true)
  })

  it('multiple independent sources compose additively — scanner AND a form can both be registered', () => {
    registerUnsavedWorkSource('scanner-batch', () => false)
    registerUnsavedWorkSource('purchase-form', () => false)
    registerUnsavedWorkSource('sale-form', () => false)
    expect(hasAnyUnsavedWork()).toBe(false)
    registerUnsavedWorkSource('purchase-form', () => true)
    expect(hasAnyUnsavedWork()).toBe(true)
  })
})

/**
 * D-110 residual fix: `DirtyByDiffBaseline` is the core logic behind `useIsDirtyByDiff`, extracted
 * so it is directly testable (this project has no React renderer). `tick()` below reproduces the
 * hook's effect body verbatim, threading `isDirty` through exactly the way React state would
 * carry it from one tick to the next — matching `sale-form-keyed-prefill-guard.test.ts`'s own
 * "reproduce the real effect body against a real primitive" approach for the sibling D-109/D-110
 * fix.
 */
function tick(
  tracker: DirtyByDiffBaseline,
  currentIsDirty: boolean,
  values: unknown,
  ready: boolean,
  resetKey?: unknown,
): boolean {
  let isDirty = currentIsDirty
  if (tracker.observeResetKey(resetKey)) isDirty = false
  if (!ready) return isDirty
  const serialized = JSON.stringify(values)
  if (!tracker.hasBaseline()) {
    tracker.captureBaseline(serialized)
    return isDirty
  }
  return tracker.isDirty(serialized)
}

describe('DirtyByDiffBaseline (useIsDirtyByDiff core logic)', () => {
  it('captures the baseline on the first ready tick and reports not dirty until values change', () => {
    const tracker = new DirtyByDiffBaseline()
    let isDirty = tick(tracker, false, { x: 1 }, true)
    expect(isDirty).toBe(false)
    isDirty = tick(tracker, isDirty, { x: 1 }, true)
    expect(isDirty).toBe(false)
    isDirty = tick(tracker, isDirty, { x: 2 }, true)
    expect(isDirty).toBe(true)
  })

  it("no resetKey (the default): behaves exactly as before — one baseline for the tracker's whole lifetime", () => {
    const tracker = new DirtyByDiffBaseline()
    let isDirty = tick(tracker, false, { x: 1 }, true, undefined)
    expect(isDirty).toBe(false)
    isDirty = tick(tracker, isDirty, { x: 2 }, true, undefined)
    expect(isDirty).toBe(true)
    // A later tick with the same (still undefined) resetKey never re-baselines.
    isDirty = tick(tracker, isDirty, { x: 2 }, true, undefined)
    expect(isDirty).toBe(true)
  })

  it('does not capture or compare while not ready', () => {
    const tracker = new DirtyByDiffBaseline()
    const isDirty = tick(tracker, false, { x: 1 }, false, 'a')
    expect(isDirty).toBe(false)
    expect(tracker.hasBaseline()).toBe(false)
  })

  it('D-110: A completes (baseline captured) -> navigate to B -> B completes -> B untouched is NOT dirty', () => {
    const tracker = new DirtyByDiffBaseline()
    // A's prefill completes; baseline captured against A's data.
    let isDirty = tick(tracker, false, { items: ['a'] }, true, 'holding-a')
    expect(isDirty).toBe(false)
    // Same-instance navigation to B: resetKey changes immediately, ready drops to false in the
    // very same tick (matches SaleFormPage's own `prefillReady` derivation) — must not report
    // dirty even though `values` still reflects whatever the render passed (e.g. stale A data).
    isDirty = tick(tracker, isDirty, { items: ['a'] }, false, 'holding-b')
    expect(isDirty).toBe(false)
    expect(tracker.hasBaseline()).toBe(false)
    // B's own prefill completes: a fresh baseline is captured from B's own values, exactly once.
    isDirty = tick(tracker, isDirty, { items: ['b'] }, true, 'holding-b')
    expect(isDirty).toBe(false)
    // B untouched afterward: still not dirty.
    isDirty = tick(tracker, isDirty, { items: ['b'] }, true, 'holding-b')
    expect(isDirty).toBe(false)
  })

  it('D-110: A completes -> B slow (several not-ready ticks) -> B completes -> not dirty', () => {
    const tracker = new DirtyByDiffBaseline()
    let isDirty = tick(tracker, false, { items: ['a'] }, true, 'holding-a')
    isDirty = tick(tracker, isDirty, { items: ['a'] }, false, 'holding-b')
    expect(isDirty).toBe(false)
    // B's own fetch is still in flight across several intervening ticks (e.g. other form fields
    // changing while B's prefill has not resolved yet) — must stay not-dirty throughout.
    isDirty = tick(tracker, isDirty, { items: ['a'], soldOn: '2026-09-01' }, false, 'holding-b')
    expect(isDirty).toBe(false)
    isDirty = tick(tracker, isDirty, { items: ['a'], soldOn: '2026-09-02' }, false, 'holding-b')
    expect(isDirty).toBe(false)
    isDirty = tick(tracker, isDirty, { items: ['b'], soldOn: '2026-09-02' }, true, 'holding-b')
    expect(isDirty).toBe(false)
  })

  it('D-110: A completes -> B errors (prefill still completes via .finally, empty/unchanged items) -> not dirty, then editing B is dirty', () => {
    const tracker = new DirtyByDiffBaseline()
    let isDirty = tick(tracker, false, { items: ['a'] }, true, 'holding-a')
    isDirty = tick(tracker, isDirty, { items: ['a'] }, false, 'holding-b')
    // B's lookup rejects; SaleFormPage's `.finally()` still marks the key completed (prefillReady
    // derives true) with whatever `items` the catch left in place.
    isDirty = tick(tracker, isDirty, { items: ['a'] }, true, 'holding-b')
    expect(isDirty).toBe(false)
    // A real user edit after B "completes" (even via error) must be recognized as dirty.
    isDirty = tick(tracker, isDirty, { items: ['a', 'manually-added'] }, true, 'holding-b')
    expect(isDirty).toBe(true)
  })

  it('D-110: A -> B -> A (return to the first key) re-baselines again, not comparing against the original A baseline', () => {
    const tracker = new DirtyByDiffBaseline()
    let isDirty = tick(tracker, false, { items: ['a'] }, true, 'holding-a')
    isDirty = tick(tracker, isDirty, { items: ['a'] }, false, 'holding-b')
    isDirty = tick(tracker, isDirty, { items: ['b'] }, true, 'holding-b')
    // Navigate back to A. Even though this exact value ({items:['a']}) matches A's ORIGINAL
    // baseline, that baseline was discarded when B began — A must re-baseline from scratch, not
    // silently resurrect the old snapshot.
    isDirty = tick(tracker, isDirty, { items: ['b'] }, false, 'holding-a')
    expect(isDirty).toBe(false)
    expect(tracker.hasBaseline()).toBe(false)
    isDirty = tick(tracker, isDirty, { items: ['a'] }, true, 'holding-a')
    expect(isDirty).toBe(false)
    isDirty = tick(tracker, isDirty, { items: ['a', 'edited'] }, true, 'holding-a')
    expect(isDirty).toBe(true)
  })

  it('StrictMode: the same resetKey/values tick running twice in a row (synthetic double-invoke) stays stable', () => {
    const tracker = new DirtyByDiffBaseline()
    // First (synthetic) invocation.
    let isDirty = tick(tracker, false, { items: ['a'] }, true, 'holding-a')
    expect(isDirty).toBe(false)
    // Second invocation with the IDENTICAL resetKey and values — must not re-reset the baseline
    // or flip isDirty; the tracker instance itself persists across StrictMode's synthetic
    // mount/cleanup/remount because it lives in a useRef, same as KeyedPrefillGuard's own ref.
    isDirty = tick(tracker, isDirty, { items: ['a'] }, true, 'holding-a')
    expect(isDirty).toBe(false)
    expect(tracker.hasBaseline()).toBe(true)
  })
})
