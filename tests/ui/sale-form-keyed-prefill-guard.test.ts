import { describe, expect, it } from 'vitest'
import { KeyedPrefillGuard } from '../../src/features/sales/keyed-prefill-guard'

/**
 * P98 SaleFormPage cross-holding data-leak fix. No React component-rendering infrastructure
 * exists in this project (no jsdom/testing-library dependency), so — matching
 * `scanner-camera-acquisition-guard.test.ts`'s approach for the analogous D-109 fix — these tests
 * pin `KeyedPrefillGuard`'s semantics directly, then reproduce `SaleFormPage.tsx`'s own prefill
 * effect body verbatim (`begin(key)` → `null` means skip; otherwise fetch, guard every
 * `.then()`/`.finally()` with `isCurrent()`) against a real, controllable-timing async lookup, for
 * the exact scenarios the P98 audit and this prompt named.
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

describe('P98 scenarios: SaleFormPage prefill effect against real async timing', () => {
  it('A starts, navigate to B, A resolves late: A never appears in items', async () => {
    const guard = new KeyedPrefillGuard()
    let items: FakeTile[] = []

    // Mirrors SaleFormPage.tsx's effect body exactly.
    function runPrefill(key: string, lookup: () => Promise<FakeTile[]>): void {
      const generation = guard.begin(key)
      if (generation === null) return
      void lookup()
        .then((found) => {
          if (!guard.isCurrent(generation)) return
          items = [
            ...items,
            ...found.filter((t) => !items.some((i) => i.holdingId === t.holdingId)),
          ]
        })
        .catch(() => {
          /* no stale error state exists to leak, matching the real component */
        })
    }

    const a = deferredLookup<FakeTile[]>()
    runPrefill('holding-a', a.run)

    // Same-instance navigation to a different holding, no remount.
    const b = deferredLookup<FakeTile[]>()
    runPrefill('holding-b', b.run)

    // A resolves AFTER the navigation to B.
    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(items).toEqual([])

    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(items).toEqual([{ holdingId: 'holding-b' }])
  })

  it('A starts, navigate to B, A rejects late: no stale error surfaces and B still completes normally', async () => {
    const guard = new KeyedPrefillGuard()
    let items: FakeTile[] = []
    let completedKey: string | null = null
    let sawUnguardedError = false

    function runPrefill(key: string, lookup: () => Promise<FakeTile[]>): void {
      const generation = guard.begin(key)
      if (generation === null) return
      void lookup()
        .then((found) => {
          if (!guard.isCurrent(generation)) return
          items = [
            ...items,
            ...found.filter((t) => !items.some((i) => i.holdingId === t.holdingId)),
          ]
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

    const a = deferredLookup<FakeTile[]>()
    runPrefill('holding-a', a.run)
    const b = deferredLookup<FakeTile[]>()
    runPrefill('holding-b', b.run)

    a.reject(new Error('network error'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // A's rejection is stale by the time it lands — it must not mark completion for A's key nor
    // report an error against the form now showing B.
    expect(sawUnguardedError).toBe(false)
    expect(completedKey).toBeNull()

    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(items).toEqual([{ holdingId: 'holding-b' }])
    expect(completedKey).toBe('holding-b')
  })
})
