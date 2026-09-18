import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { EntityKeyChangeTracker } from '../../src/platform/entity-key-change-tracker'

/**
 * P140: `EntityKeyChangeTracker` moved from `sale-form-state.ts` to
 * `platform/entity-key-change-tracker.ts` unchanged, plus the new `useEntityKeyReset` hook built
 * on it — this is the primitive `PurchaseFormPage`/`AddToCollectionPage`/`AddSealedProductPage`'s
 * P140 identity-switch fix (and, for the two Add pages, same-mount entity-switch fix) all share.
 * `useEntityKeyReset` itself is a five-line `useEffect` wrapper with no React renderer available
 * to exercise it directly in this repository (see `sale-form-entity-isolation.test.ts`'s own doc);
 * every behavior it can possibly have comes from this class's `observe()` contract, which is
 * fully deterministic and directly testable — the page-level harness tests
 * (`purchase-form-identity-boundary.test.ts`, `add-form-identity-boundary.test.ts`) additionally
 * prove each real page's effect body (mirrored verbatim, using this exact class) produces the
 * required reset behavior end to end.
 */

describe('EntityKeyChangeTracker (P140, relocated from sale-form-state.ts)', () => {
  it('never fires on the first observation, regardless of the key', () => {
    const t1 = new EntityKeyChangeTracker()
    expect(t1.observe('user-a')).toBe(false)
    expect(t1.generation()).toBe(0)

    const t2 = new EntityKeyChangeTracker()
    expect(t2.observe('')).toBe(false)
  })

  it('does not fire on repeated observations of the SAME key (ordinary rerenders/retries)', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('user-a')
    expect(tracker.observe('user-a')).toBe(false)
    expect(tracker.observe('user-a')).toBe(false)
    expect(tracker.observe('user-a')).toBe(false)
    expect(tracker.generation()).toBe(0)
  })

  it('fires exactly once on a genuine key change, and generation increments', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('user-a')
    expect(tracker.observe('user-b')).toBe(true)
    expect(tracker.generation()).toBe(1)
    // Settling on the new key does not re-fire.
    expect(tracker.observe('user-b')).toBe(false)
    expect(tracker.generation()).toBe(1)
  })

  it('A -> B -> A is two real transitions, not a return to a remembered state', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('user-a')
    expect(tracker.observe('user-b')).toBe(true)
    expect(tracker.observe('user-a')).toBe(true)
    expect(tracker.generation()).toBe(2)
  })

  it('an empty-string key participates like any other key (the sentinel this project uses for "no identity yet")', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('')
    expect(tracker.observe('user-a')).toBe(true)
    expect(tracker.observe('')).toBe(true)
  })

  it('25,000 generated observation sequences: generation() equals the count of genuine adjacent-key changes, and observe() returning true is exactly a differing consecutive pair', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'c', ''), { minLength: 1, maxLength: 50 }),
        (keys) => {
          const tracker = new EntityKeyChangeTracker()
          let expectedGeneration = 0
          let previous: string | null = null
          keys.forEach((key, index) => {
            const fired = tracker.observe(key)
            if (index === 0) {
              expect(fired).toBe(false)
            } else if (key !== previous) {
              expect(fired).toBe(true)
              expectedGeneration += 1
            } else {
              expect(fired).toBe(false)
            }
            previous = key
          })
          expect(tracker.generation()).toBe(expectedGeneration)
        },
      ),
      { numRuns: 25_000 },
    )
  })
})
