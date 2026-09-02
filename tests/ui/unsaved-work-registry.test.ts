import { afterEach, describe, expect, it } from 'vitest'
import {
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
