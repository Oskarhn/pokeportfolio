import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  hasAnyUnsavedWork,
  registerUnsavedWorkSource,
  resetUnsavedWorkRegistryForTests,
  type UnsavedWorkGetter,
} from '../../src/platform/unsaved-work-registry'

/**
 * P121 §13 — randomized property fuzz for the unsaved-work registry, complementing the
 * deterministic cases in tests/ui/unsaved-work-registry.test.ts (register/unregister composition,
 * out-of-order-cleanup safety, StrictMode double-invoke stability).
 *
 * Drives the REAL module (registerUnsavedWorkSource/hasAnyUnsavedWork/
 * resetUnsavedWorkRegistryForTests — no reimplementation) through long random operation
 * sequences, checked at every step against a shadow model that mirrors the module's own
 * documented Map<id, getter> replace-on-register / remove-if-still-current-on-unregister
 * semantics. A shadow entry is a mutable "box"; SET_DIRTY always mutates the box belonging to the
 * capture token it targets — mutating a SUPERSEDED registration's box therefore has no effect on
 * `shadowSources` (a different box is live), which is exactly the "one owner cannot clear/affect
 * another, and a superseded (stale) registration cannot resurrect itself" invariant the historical
 * out-of-order-cleanup bug this registry fixed (see the module's own header comment) would violate.
 */

type Capture = { id: string; box: { value: boolean }; unregister: () => void; live: boolean }

const IDS = ['purchase-form', 'sale-form', 'scanner-batch', 'opening-wizard'] as const

type Op =
  | { kind: 'register'; id: (typeof IDS)[number]; initialDirty: boolean }
  | { kind: 'setDirty'; id: (typeof IDS)[number]; captureIndex: number; value: boolean }
  | { kind: 'unregister'; id: (typeof IDS)[number]; captureIndex: number }
  | { kind: 'doubleUnregister'; id: (typeof IDS)[number]; captureIndex: number }
  | { kind: 'strictModeRemount'; id: (typeof IDS)[number]; initialDirty: boolean }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('register' as const),
    id: fc.constantFrom(...IDS),
    initialDirty: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('setDirty' as const),
    id: fc.constantFrom(...IDS),
    captureIndex: fc.nat({ max: 20 }),
    value: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('unregister' as const),
    id: fc.constantFrom(...IDS),
    captureIndex: fc.nat({ max: 20 }),
  }),
  fc.record({
    kind: fc.constant('doubleUnregister' as const),
    id: fc.constantFrom(...IDS),
    captureIndex: fc.nat({ max: 20 }),
  }),
  fc.record({
    kind: fc.constant('strictModeRemount' as const),
    id: fc.constantFrom(...IDS),
    initialDirty: fc.boolean(),
  }),
)

afterEach(() => {
  resetUnsavedWorkRegistryForTests()
})

describe('unsaved-work registry — randomized operation-sequence property fuzz', () => {
  it('hasAnyUnsavedWork always equals the OR of whatever is currently the LIVE registration per id, for any op sequence', () => {
    let totalOps = 0
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 100, maxLength: 400 }), (ops) => {
        resetUnsavedWorkRegistryForTests()
        // shadowSources mirrors the real module's internal Map<id, box> exactly: registering
        // replaces the id's entry; unregistering removes it ONLY if the captured box is still
        // the one currently installed (out-of-order-cleanup safety).
        const shadowSources = new Map<string, { value: boolean }>()
        const capturesById = new Map<string, Capture[]>()

        function register(id: string, initialDirty: boolean): void {
          const box = { value: initialDirty }
          const getter: UnsavedWorkGetter = () => box.value
          const unregister = registerUnsavedWorkSource(id, getter)
          const capture: Capture = { id, box, unregister, live: true }
          // Mark any prior capture for this id superseded — mutating its box can no longer
          // affect shadowSources, matching the real Map's replace-on-register semantics.
          for (const c of capturesById.get(id) ?? []) c.live = false
          const list = capturesById.get(id) ?? []
          list.push(capture)
          capturesById.set(id, list)
          shadowSources.set(id, box)
        }

        function unregisterAt(id: string, index: number): void {
          const list = capturesById.get(id)
          if (!list || list.length === 0) return
          const capture = list[index % list.length]!
          capture.unregister()
          if (capture.live) {
            // Only the currently-live registration's removal actually evicts the shadow entry —
            // an evicted-but-still-live capture means it WAS the current one.
            if (shadowSources.get(id) === capture.box) shadowSources.delete(id)
            capture.live = false
          }
          // A stale (already-superseded) capture's unregister must be a pure no-op against
          // shadowSources — asserted implicitly by never touching it here.
        }

        for (const op of ops) {
          totalOps += 1
          switch (op.kind) {
            case 'register':
              register(op.id, op.initialDirty)
              break
            case 'strictModeRemount': {
              // Synthetic StrictMode mount -> cleanup -> mount: register, immediately run ITS
              // OWN unregister (simulating the dev-mode double-invoke cleanup), then register
              // again for the real mount — mirrors useUnsavedWorkSource's effect shape.
              register(op.id, op.initialDirty)
              const list = capturesById.get(op.id)!
              unregisterAt(op.id, list.length - 1)
              register(op.id, op.initialDirty)
              break
            }
            case 'setDirty': {
              const list = capturesById.get(op.id)
              if (!list || list.length === 0) break
              const capture = list[op.captureIndex % list.length]!
              capture.box.value = op.value
              break
            }
            case 'unregister':
              unregisterAt(op.id, op.captureIndex)
              break
            case 'doubleUnregister': {
              const list = capturesById.get(op.id)
              if (!list || list.length === 0) break
              const idx = op.captureIndex % list.length
              unregisterAt(op.id, idx)
              // Second call must be idempotent — must not throw, and must not evict a newer
              // registration that may have since taken over the same id.
              unregisterAt(op.id, idx)
              break
            }
          }

          const expected = [...shadowSources.values()].some((box) => box.value)
          expect(hasAnyUnsavedWork()).toBe(expected)
        }

        // A registry with no live dirty box anywhere must be reported safe-to-reload.
        if ([...shadowSources.values()].every((box) => !box.value)) {
          expect(hasAnyUnsavedWork()).toBe(false)
        }
      }),
      { numRuns: 800 },
    )
    // Sanity: prove this run actually exercised the >=100,000-operation target the P121 brief
    // asks for, rather than asserting a number never reached.
    expect(totalOps).toBeGreaterThanOrEqual(100_000)
  }, 60_000)

  it('after any sequence, resetUnsavedWorkRegistryForTests always yields a clean (safe-to-reload) registry', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 100 }), (ops) => {
        resetUnsavedWorkRegistryForTests()
        for (const op of ops) {
          if (op.kind === 'register' || op.kind === 'strictModeRemount') {
            registerUnsavedWorkSource(op.id, () => true)
          }
        }
        resetUnsavedWorkRegistryForTests()
        expect(hasAnyUnsavedWork()).toBe(false)
      }),
      { numRuns: 300 },
    )
  })
})
