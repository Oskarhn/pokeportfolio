import { describe, expect, it } from 'vitest'
import { KeyedPrefillGuard } from '../../src/features/sales/keyed-prefill-guard'

/**
 * P98 SaleFormPage cross-holding data-leak fix, extended by P106 for the items-array residual
 * P102 disclosed (old key's items staying visible while a new key's prefill loads/resolves). No
 * React component-rendering infrastructure exists in this project (no jsdom/testing-library
 * dependency), so — matching `scanner-camera-acquisition-guard.test.ts`'s approach for the
 * analogous D-109 fix — these tests pin `KeyedPrefillGuard`'s semantics directly, then reproduce
 * `SaleFormPage.tsx`'s own prefill effect body VERBATIM (`previousKey` tracked outside the guard,
 * `items` cleared synchronously on a real key change before the fetch starts, `begin(key)` → `null`
 * means skip, otherwise fetch, guard every `.then()`/`.finally()` with `isCurrent()`) against a
 * real, controllable-timing async lookup, for the exact scenarios the P98 audit and P106's own
 * prompt named.
 */

interface FakeTile {
  holdingId: string
}

/** A `listPortfolio`-shaped async lookup the test controls the resolution timing of. */
function deferredLookup<T>(): {
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolveCurrent: ((value: T) => void) | undefined
  let rejectCurrent: ((error: unknown) => void) | undefined
  const run = () =>
    new Promise<T>((res, rej) => {
      resolveCurrent = res
      rejectCurrent = rej
    })
  const resolve = (value: T) => {
    if (resolveCurrent === undefined) throw new Error('run() has not been called yet')
    resolveCurrent(value)
  }
  const reject = (error: unknown) => {
    if (rejectCurrent === undefined) throw new Error('run() has not been called yet')
    rejectCurrent(error)
  }
  return { run, resolve, reject }
}

describe('KeyedPrefillGuard', () => {
  it('the same key started twice (StrictMode-style) only begins once — the second call returns null', () => {
    const guard = new KeyedPrefillGuard()
    expect(guard.begin('holding-a')).toBe(1)
    expect(guard.begin('holding-a')).toBeNull()
  })

  it('a genuinely different key always begins a new, higher generation', () => {
    const guard = new KeyedPrefillGuard()
    const first = guard.begin('holding-a')
    const second = guard.begin('holding-b')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).toBeGreaterThan(first as number)
  })

  it("a new key's begin() immediately supersedes the previous key's generation", () => {
    const guard = new KeyedPrefillGuard()
    const first = guard.begin('holding-a')
    guard.begin('holding-b')
    expect(guard.isCurrent(first as number)).toBe(false)
  })
})

/** Mirrors SaleFormPage.tsx's prefill-effect body exactly, including the P106 sync-clear-on-
 *  key-change fix. `runFor(holdingIds)` stands in for one `useEffect` run with that `holdingIds`
 *  set — call it in navigation order to reproduce a same-instance route change. */
function makeSaleFormPrefillHarness(lookup: (holdingIds: string[]) => Promise<FakeTile[]>) {
  const guard = new KeyedPrefillGuard()
  let items: FakeTile[] = []
  let completedKey: string | null = null
  let sawUnguardedError = false
  let previousKey: string | null = null

  function runFor(holdingIds: string[]): void {
    const key = holdingIds.join(',')
    const keyChanged = previousKey !== key
    previousKey = key
    if (holdingIds.length === 0) {
      if (keyChanged) items = []
      return
    }
    const generation = guard.begin(key)
    if (generation === null) return
    if (keyChanged) items = []
    void lookup(holdingIds)
      .then((found) => {
        if (!guard.isCurrent(generation)) return
        items = [...items, ...found.filter((t) => !items.some((i) => i.holdingId === t.holdingId))]
      })
      .catch(() => {
        if (!guard.isCurrent(generation)) return
        sawUnguardedError = true
      })
      .finally(() => {
        if (!guard.isCurrent(generation)) return
        completedKey = key
      })
  }

  return {
    runFor,
    getItems: () => items,
    getCompletedKey: () => completedKey,
    getSawUnguardedError: () => sawUnguardedError,
  }
}

describe('SaleFormPage prefill effect against real async timing', () => {
  it('A starts, navigate to B, A resolves late: A never appears in items (old test, unchanged expectation)', async () => {
    const a = deferredLookup<FakeTile[]>()
    const b = deferredLookup<FakeTile[]>()
    const harness = makeSaleFormPrefillHarness((ids) =>
      ids[0] === 'holding-a' ? a.run() : b.run(),
    )

    harness.runFor(['holding-a'])
    harness.runFor(['holding-b']) // same-instance navigation, no remount

    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([])

    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])
  })

  it("A completed -> B: A's items are cleared as soon as B's prefill starts, before B resolves", async () => {
    const a = deferredLookup<FakeTile[]>()
    const b = deferredLookup<FakeTile[]>()
    const harness = makeSaleFormPrefillHarness((ids) =>
      ids[0] === 'holding-a' ? a.run() : b.run(),
    )

    harness.runFor(['holding-a'])
    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-a' }])

    // Navigate to B — A's items must disappear IMMEDIATELY, before B's fetch has a result.
    harness.runFor(['holding-b'])
    expect(harness.getItems()).toEqual([])

    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])
  })

  it('A slow -> B: navigating away before A resolves still shows only B, never a mix of A and B', async () => {
    const a = deferredLookup<FakeTile[]>()
    const b = deferredLookup<FakeTile[]>()
    const harness = makeSaleFormPrefillHarness((ids) =>
      ids[0] === 'holding-a' ? a.run() : b.run(),
    )

    harness.runFor(['holding-a'])
    // A is still in flight — never resolves before the navigation.
    harness.runFor(['holding-b'])
    expect(harness.getItems()).toEqual([]) // B's own fetch has not resolved yet either

    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])

    // A finally resolves — must never merge into B's items.
    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])
  })

  it('A -> B -> A: returning to A re-fetches fresh and does not resurrect stale state', async () => {
    const a1 = deferredLookup<FakeTile[]>()
    const b = deferredLookup<FakeTile[]>()
    const a2 = deferredLookup<FakeTile[]>()
    let aCallCount = 0
    const harness = makeSaleFormPrefillHarness((ids) => {
      if (ids[0] === 'holding-b') return b.run()
      aCallCount += 1
      return aCallCount === 1 ? a1.run() : a2.run()
    })

    harness.runFor(['holding-a'])
    a1.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-a' }])

    harness.runFor(['holding-b'])
    expect(harness.getItems()).toEqual([]) // A's items cleared immediately
    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])

    // Back to A — must clear B's items immediately and issue a genuinely NEW fetch (not reuse a
    // stale "already started" latch), since KeyedPrefillGuard only compares against the MOST
    // RECENT key, not a set of every key ever seen.
    harness.runFor(['holding-a'])
    expect(harness.getItems()).toEqual([])
    expect(aCallCount).toBe(2)
    a2.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-a' }])
  })

  it('old A resolves after B: a late A result never leaks into the form now showing B', async () => {
    const a = deferredLookup<FakeTile[]>()
    const b = deferredLookup<FakeTile[]>()
    const harness = makeSaleFormPrefillHarness((ids) =>
      ids[0] === 'holding-a' ? a.run() : b.run(),
    )

    harness.runFor(['holding-a'])
    harness.runFor(['holding-b'])
    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])

    // A resolves only now, well after B already completed.
    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])
    expect(harness.getCompletedKey()).toBe('holding-b')
  })

  it("B error: A's items stay cleared, no stale error surfaces, and completion is not marked for a superseded key", async () => {
    const a = deferredLookup<FakeTile[]>()
    const b = deferredLookup<FakeTile[]>()
    const harness = makeSaleFormPrefillHarness((ids) =>
      ids[0] === 'holding-a' ? a.run() : b.run(),
    )

    harness.runFor(['holding-a'])
    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.getItems()).toEqual([{ holdingId: 'holding-a' }])

    harness.runFor(['holding-b'])
    expect(harness.getItems()).toEqual([]) // cleared immediately on navigation, before B fails
    b.reject(new Error('network error'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.getItems()).toEqual([]) // no stale A items resurrected by the failure
    expect(harness.getSawUnguardedError()).toBe(true)
    expect(harness.getCompletedKey()).toBe('holding-b') // finally() still marks B done so the
    // dirty-tracking baseline (N-14) does not stay stuck forever after a failed prefill
  })

  it('A starts, navigate to B, A rejects late: no stale error surfaces and B still completes normally', async () => {
    const a = deferredLookup<FakeTile[]>()
    const b = deferredLookup<FakeTile[]>()
    const harness = makeSaleFormPrefillHarness((ids) =>
      ids[0] === 'holding-a' ? a.run() : b.run(),
    )

    harness.runFor(['holding-a'])
    harness.runFor(['holding-b'])

    a.reject(new Error('network error'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // A's rejection is stale by the time it lands — it must not mark completion for A's key nor
    // report an error against the form now showing B.
    expect(harness.getSawUnguardedError()).toBe(false)
    expect(harness.getCompletedKey()).toBeNull()

    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.getItems()).toEqual([{ holdingId: 'holding-b' }])
    expect(harness.getCompletedKey()).toBe('holding-b')
  })
})
