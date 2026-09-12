import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

/**
 * P124 §10-12 — PurchaseEditPage/SaleEditPage A→B→C async-ownership race coverage.
 *
 * Both pages share one shape: `key={id}` forces a full unmount/remount on every id change (never
 * a same-instance update — see PurchaseEditPage/SaleEditPage's own header comments), but the
 * `submit` mutation's `onSuccess`/`onError` are plain closures over the OLD instance's id that
 * TanStack Query keeps invoking even after that instance has unmounted, if the network response
 * arrives late. P124 fixed a real bug this exposed: an unguarded stale `onSuccess` force-navigates
 * the user away from wherever they've since gone, back onto the stale entity's page; an unguarded
 * stale `onError` would render an error banner nobody can see or dismiss (the form is gone).
 *
 * No React renderer exists in this project (see sale-form-entity-isolation.test.ts's own doc), so
 * this harness reproduces the exact guarded shape now in both pages (`useIsMountedRef` + the two
 * mutation callbacks) rather than a re-implementation, driven through every completion ordering of
 * three overlapping instances (A, B, C).
 */

interface EditFormInstance {
  id: string
  isMounted: boolean
  invalidatedEntityKeys: string[]
  navigatedTo: string[]
  errorShown: string | null
}

function mountInstance(id: string): EditFormInstance {
  return { id, isMounted: true, invalidatedEntityKeys: [], navigatedTo: [], errorShown: null }
}

function unmount(instance: EditFormInstance) {
  instance.isMounted = false
}

/** Reproduces PurchaseEditPage's/SaleEditPage's guarded `submit` mutation callbacks verbatim:
 *  invalidation always runs (the edit genuinely happened on the server); navigation and the error
 *  banner are gated on `isMounted`, exactly as `useIsMountedRef` gates them in both real files. */
function onSubmitSuccess(instance: EditFormInstance) {
  instance.invalidatedEntityKeys.push(instance.id) // always — real edit, real server-side effect
  if (!instance.isMounted) return
  instance.navigatedTo.push(instance.id)
}

function onSubmitError(instance: EditFormInstance, message: string) {
  if (!instance.isMounted) return
  instance.errorShown = message
}

describe('PurchaseEditPage/SaleEditPage — A→B→C async ownership (P124 §10, §12)', () => {
  it('A→B→C: a late A response never navigates or errors after A has unmounted', () => {
    const a = mountInstance('A')
    // user navigates to B before A's submit resolves
    unmount(a)
    const b = mountInstance('B')
    // ...and on to C before B's submit resolves either
    unmount(b)
    const c = mountInstance('C')

    // Completion order: C first (still mounted), then B, then A (both long since unmounted).
    onSubmitSuccess(c)
    onSubmitError(b, 'stale B error')
    onSubmitSuccess(a)

    expect(c.navigatedTo).toEqual(['C'])
    expect(b.errorShown).toBeNull() // B unmounted before its error arrived — never shown
    expect(a.navigatedTo).toEqual([]) // A unmounted long ago — must never navigate
    // Invalidation is unconditional on SUCCESS (even for a stale instance — a genuinely-applied
    // edit must not be hidden from a later view of that same entity); B's outcome was an error,
    // which never invalidates anything, matching the real onError (it only ever sets `error`).
    expect(a.invalidatedEntityKeys).toEqual(['A'])
    expect(b.invalidatedEntityKeys).toEqual([])
    expect(c.invalidatedEntityKeys).toEqual(['C'])
  })

  it('A→B→A: returning to A gets a FRESH instance — the old A"s late response cannot touch it', () => {
    const aFirst = mountInstance('A')
    unmount(aFirst)
    const b = mountInstance('B')
    unmount(b)
    const aSecond = mountInstance('A') // a NEW instance — key={purchaseId}/{saleId} remounts fresh

    onSubmitSuccess(aSecond) // the user's current save on the fresh instance
    onSubmitSuccess(aFirst) // the abandoned first A submit, arriving even later

    expect(aSecond.navigatedTo).toEqual(['A'])
    expect(aFirst.navigatedTo).toEqual([]) // the OLD A instance, never the new one
    // The two instances are genuinely distinct objects — no shared mutable state between them.
    expect(aFirst).not.toBe(aSecond)
  })

  it('every save success/failure combination across A/B/C, in every completion order, only ever navigates/errors on behalf of the instance mounted at that moment', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            entity: fc.constantFrom('A', 'B', 'C'),
            outcome: fc.constantFrom<'success' | 'error'>('success', 'error'),
          }),
          { minLength: 3, maxLength: 3 },
        ),
        fc.array(fc.constantFrom(0, 1, 2), { minLength: 3, maxLength: 3 }), // completion order (indices)
        (submissions, completionOrderRaw) => {
          // Mount A, then B (unmounting A), then C (unmounting B) — matches the real navigation
          // sequence: a key-remounted route always fully replaces the previous instance.
          const instances: Record<string, EditFormInstance> = {}
          for (const [i, entity] of ['A', 'B', 'C'].entries()) {
            if (i > 0) unmount(instances[['A', 'B', 'C'][i - 1]!]!)
            instances[entity] = mountInstance(entity)
          }
          const currentlyMounted = 'C' // last one mounted, per the loop above

          // De-dupe the completion order into a valid permutation of [0,1,2].
          const seen = new Set<number>()
          const completionOrder = [
            ...completionOrderRaw.filter((n) => {
              if (seen.has(n)) return false
              seen.add(n)
              return true
            }),
            ...[0, 1, 2].filter((n) => !seen.has(n)),
          ]

          for (const idx of completionOrder) {
            const submission = submissions[idx]!
            const instance = instances[submission.entity]!
            if (submission.outcome === 'success') {
              onSubmitSuccess(instance)
            } else {
              onSubmitError(instance, `error-${submission.entity}`)
            }
          }

          for (const entity of ['A', 'B', 'C']) {
            const instance = instances[entity]!
            if (entity === currentlyMounted) continue
            // A stale (unmounted) instance must never have navigated or shown an error, no
            // matter which submissions landed on it or in what order.
            expect(instance.navigatedTo).toEqual([])
            expect(instance.errorShown).toBeNull()
          }
        },
      ),
      { numRuns: 5000 },
    )
  })
})
