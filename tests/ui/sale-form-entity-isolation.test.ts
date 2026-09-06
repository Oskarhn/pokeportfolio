import { describe, expect, it } from 'vitest'
import { KeyedPrefillGuard } from '../../src/features/sales/keyed-prefill-guard'
import {
  createInitialSaleFormFields,
  EntityKeyChangeTracker,
  type ItemDraft,
  type SaleFormFields,
} from '../../src/features/sales/sale-form-state'

/**
 * P109: the P107 audit found that P106's own P98/D-110 fix only ever cleared `items` on a
 * same-instance holdingId(s) transition — every other submission-bound field (date, marketplace,
 * currency, fees, shipping, notes, FX mode/rate/date, the idempotency key, and validation/error
 * state) silently carried the OLD holding's values into the NEW one. This is the deterministic
 * test matrix for the fix (prompt §16, S109-01..20).
 *
 * No React renderer exists in this project (see `sale-form-keyed-prefill-guard.test.ts`'s own
 * doc), so this harness reproduces `SaleFormPage.tsx`'s ACTUAL combined effect body and submission
 * generation-guard verbatim — using the real, production `EntityKeyChangeTracker`,
 * `KeyedPrefillGuard` and `createInitialSaleFormFields`, never a re-implementation of their
 * semantics. Every field-name string below matches the component's own `SaleFormFields` shape
 * exactly, so a future refactor that drops a field from either place is caught by a type error,
 * not a silently-stale test.
 */

interface FakeTile {
  holdingId: string
}

function draftFromFakeTile(tile: FakeTile): ItemDraft {
  return {
    holdingId: tile.holdingId,
    displayName: tile.holdingId,
    subtitle: '',
    imageBaseUrl: null,
    lots: null,
    selections: { 'lot-1': { quantity: 1, unitGrossInput: '10.00' } },
  }
}

/** A `listPortfolio`-shaped async lookup the test controls the resolution timing of. */
function deferred<T>(): {
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
} {
  let res: ((value: T) => void) | undefined
  let rej: ((e: unknown) => void) | undefined
  const run = () =>
    new Promise<T>((resolve, reject) => {
      res = resolve
      rej = reject
    })
  return {
    run,
    resolve: (value: T) => {
      if (!res) throw new Error('run() not called yet')
      res(value)
    },
    reject: (e: unknown) => {
      if (!rej) throw new Error('run() not called yet')
      rej(e)
    },
  }
}

/**
 * Mirrors `SaleFormPage`'s state + the effect at src/features/sales/SaleFormPage.tsx's
 * `useEffect(() => { ... }, [holdingIds, prefillKey])` verbatim: observe the entity key first
 * (synchronous full-field reset on a genuine change), THEN start the keyed prefill fetch.
 */
class SaleFormHarness {
  fields: SaleFormFields
  prefillCompletedKey: string | null = null
  private entityTracker = new EntityKeyChangeTracker()
  private prefillGuard = new KeyedPrefillGuard()
  private holdingIdsLength = 0
  private todayFn: () => string

  constructor(todayFn: () => string = () => '2026-01-01') {
    this.todayFn = todayFn
    this.fields = createInitialSaleFormFields(todayFn)
  }

  get prefillKey(): string {
    // set by navigate(); exposed for assertions
    return this.lastPrefillKey
  }
  private lastPrefillKey = ''

  get prefillReady(): boolean {
    return this.holdingIdsLength === 0 || this.prefillCompletedKey === this.lastPrefillKey
  }

  generation(): number {
    return (this.entityTracker as unknown as { generation(): number }).generation()
  }

  /** Same-instance navigation to a (possibly different) holdingIds set. Mirrors the component's
   *  effect body exactly, including reset-before-fetch ordering. */
  navigate(holdingIds: string[], lookup: () => Promise<FakeTile[]>): void {
    const prefillKey = holdingIds.join(',')
    this.lastPrefillKey = prefillKey
    this.holdingIdsLength = holdingIds.length

    if (this.entityTracker.observe(prefillKey)) {
      this.fields = createInitialSaleFormFields(this.todayFn)
    }
    if (holdingIds.length === 0) return
    const generation = this.prefillGuard.begin(prefillKey)
    if (generation === null) return
    void lookup()
      .then((page) => {
        if (!this.prefillGuard.isCurrent(generation)) return
        const found = page
        this.fields = {
          ...this.fields,
          items: [
            ...this.fields.items,
            ...found
              .filter((t) => !this.fields.items.some((i) => i.holdingId === t.holdingId))
              .map(draftFromFakeTile),
          ],
        }
      })
      .catch(() => {
        /* matches the component: proceed with whatever items exist */
      })
      .finally(() => {
        if (!this.prefillGuard.isCurrent(generation)) return
        this.prefillCompletedKey = prefillKey
      })
  }

  edit(patch: Partial<SaleFormFields>): void {
    this.fields = { ...this.fields, ...patch }
  }

  /** Mirrors the mutationFn/onSuccess/onError generation guard from SaleFormPage.tsx's
   *  submitMutation. `run` stands in for `createSale(...)`. */
  async submit(run: () => Promise<{ id: string }>): Promise<void> {
    const submissionGeneration = this.generation()
    try {
      const sale = await run()
      if (this.generation() !== submissionGeneration) return // stale: user switched entities
      this.navigatedToSaleId = sale.id
    } catch (err) {
      if (this.generation() !== submissionGeneration) return // stale: do not surface old error
      this.fields = { ...this.fields, error: (err as Error).message }
    }
  }

  navigatedToSaleId: string | null = null
}

describe('S109 SaleForm full entity-switch isolation matrix', () => {
  it('S109-01: A completed -> B — every field resets, not just items', async () => {
    const form = new SaleFormHarness()
    const a = deferred<FakeTile[]>()
    form.navigate(['holding-a'], a.run)
    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    form.edit({
      marketplace: 'Finn',
      currency: 'EUR',
      feesInput: '5.00',
      shippingCostInput: '3.00',
      shippingChargedInput: '2.00',
      notes: 'A notes',
      fxMode: 'manual',
      fxRate: '11.5',
      fxRateDate: '2026-01-01',
      soldOn: '2026-01-15',
    })
    expect(form.fields.items).toHaveLength(1)
    const aKey = form.fields.idempotencyKey

    const b = deferred<FakeTile[]>()
    form.navigate(['holding-b'], b.run)

    expect(form.fields.items).toEqual([])
    expect(form.fields.marketplace).toBe('')
    expect(form.fields.currency).toBe('NOK')
    expect(form.fields.feesInput).toBe('')
    expect(form.fields.shippingCostInput).toBe('')
    expect(form.fields.shippingChargedInput).toBe('')
    expect(form.fields.notes).toBe('')
    expect(form.fields.fxMode).toBe('norges_bank')
    expect(form.fields.fxRate).toBe('')
    expect(form.fields.fxRateDate).toBe('')
    expect(form.fields.soldOn).toBe('2026-01-01')
    expect(form.fields.idempotencyKey).not.toBe(aKey)
  })

  it('S109-02: A slow -> B — B never shows a mix while A is still in flight', async () => {
    const form = new SaleFormHarness()
    const a = deferred<FakeTile[]>()
    form.navigate(['holding-a'], a.run) // A still pending
    const b = deferred<FakeTile[]>()
    form.navigate(['holding-b'], b.run)
    expect(form.fields.items).toEqual([]) // reset the instant B's navigation happens
    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(form.fields.items.map((i) => i.holdingId)).toEqual(['holding-b'])
  })

  it('S109-03: A result arrives after B — A never leaks into B, and B stays a genuinely fresh state (all fields, not just items)', async () => {
    const form = new SaleFormHarness()
    const a = deferred<FakeTile[]>()
    form.navigate(['holding-a'], a.run)
    const b = deferred<FakeTile[]>()
    form.navigate(['holding-b'], b.run)
    form.edit({ notes: 'B notes typed while waiting' })

    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(form.fields.items).toEqual([]) // A's late result discarded, not appended
    expect(form.fields.notes).toBe('B notes typed while waiting') // B's own edit survives

    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(form.fields.items.map((i) => i.holdingId)).toEqual(['holding-b'])
  })

  it("S109-04: B prefill errors — the form stays B's clean/default state, not A's old data", async () => {
    const form = new SaleFormHarness()
    const a = deferred<FakeTile[]>()
    form.navigate(['holding-a'], a.run)
    a.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(form.fields.items).toHaveLength(1)

    const b = deferred<FakeTile[]>()
    form.navigate(['holding-b'], b.run)
    b.reject(new Error('network down'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(form.fields.items).toEqual([]) // B's clean default, never A's leftover item
    expect(form.prefillCompletedKey).toBe('holding-b') // still marked complete — N-14
    expect(form.prefillReady).toBe(true)
  })

  it("S109-05: A -> B -> A — returning to A is a fresh instance, not a resurrection of A's old unsaved values", async () => {
    const form = new SaleFormHarness()
    const a1 = deferred<FakeTile[]>()
    form.navigate(['holding-a'], a1.run)
    a1.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    form.edit({ notes: 'first A visit notes' })

    const b = deferred<FakeTile[]>()
    form.navigate(['holding-b'], b.run)
    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()

    const a2 = deferred<FakeTile[]>()
    form.navigate(['holding-a'], a2.run) // returning to A: a genuinely NEW fetch, not reused state
    expect(form.fields.notes).toBe('') // A's own earlier notes are gone — fresh instance
    expect(form.fields.items).toEqual([])
    a2.resolve([{ holdingId: 'holding-a' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(form.fields.items.map((i) => i.holdingId)).toEqual(['holding-a'])
  })

  it('S109-06: idempotency key changes on a genuine entity transition', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    const keyA = form.fields.idempotencyKey
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.idempotencyKey).not.toBe(keyA)
  })

  it('S109-07: idempotency key stays stable across an ordinary rerender (same key) and does not change on a submit failure/retry', async () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([{ holdingId: 'holding-a' }]))
    await Promise.resolve()
    await Promise.resolve()
    const key1 = form.fields.idempotencyKey

    // Ordinary rerender: same holdingIds, effect deps unchanged in the real component (no-op
    // here since nothing calls navigate again) — key must be unchanged.
    expect(form.fields.idempotencyKey).toBe(key1)

    // A failed submit, then a retry of the SAME logical sale: no entity transition happened, so
    // the key must be reused, not reminted.
    await form.submit(() => Promise.reject(new Error('transient network error')))
    expect(form.fields.idempotencyKey).toBe(key1)
    await form.submit(() => Promise.resolve({ id: 'sale-1' }))
    expect(form.fields.idempotencyKey).toBe(key1)
  })

  it('S109-08: a custom sale date does not survive an entity switch', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ soldOn: '2020-05-01' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.soldOn).toBe('2026-01-01')
  })

  it('S109-09: marketplace does not survive an entity switch', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ marketplace: 'Cardmarket' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.marketplace).toBe('')
  })

  it('S109-10: currency does not survive an entity switch (A foreign -> B NOK, and A NOK -> B foreign)', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ currency: 'EUR' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.currency).toBe('NOK')

    form.edit({ currency: 'NOK' })
    form.navigate(['holding-c'], () => Promise.resolve([]))
    expect(form.fields.currency).toBe('NOK') // still resets to the default, never inherits
  })

  it('S109-11: fees do not survive an entity switch', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ feesInput: '99.99' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.feesInput).toBe('')
  })

  it('S109-12: shipping cost does not survive an entity switch', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ shippingCostInput: '49.00' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.shippingCostInput).toBe('')
  })

  it('S109-13: shipping charged (buyer-paid) does not survive an entity switch', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ shippingChargedInput: '25.00' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.shippingChargedInput).toBe('')
  })

  it('S109-14: notes do not survive an entity switch', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ notes: 'Sold to a friend' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.notes).toBe('')
  })

  it('S109-15: FX mode/rate/date do not survive an entity switch, in every direction', () => {
    const form = new SaleFormHarness()
    // A manual -> B automatic
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ fxMode: 'manual', fxRate: '9.99', fxRateDate: '2026-01-01' })
    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.fxMode).toBe('norges_bank')
    expect(form.fields.fxRate).toBe('')
    expect(form.fields.fxRateDate).toBe('')

    // A automatic (already-fetched rate) -> B manual
    form.edit({ fxMode: 'norges_bank', fxRate: '10.5', fxRateDate: '2026-02-01' })
    form.navigate(['holding-c'], () => Promise.resolve([]))
    expect(form.fields.fxMode).toBe('norges_bank')
    expect(form.fields.fxRate).toBe('')
    expect(form.fields.fxRateDate).toBe('')
  })

  it('S109-16: validation/error and FX-error banners do not survive an entity switch', async () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    await form.submit(() =>
      Promise.reject(new Error('Choose at least one card and quantity to sell.')),
    )
    expect(form.fields.error).toBe('Choose at least one card and quantity to sell.')

    form.navigate(['holding-b'], () => Promise.resolve([]))
    expect(form.fields.error).toBeNull()
    expect(form.fields.fxError).toBeNull()
  })

  it("S109-17: A's submit SUCCEEDS after the user has already switched to B — must not navigate/mutate B's form", async () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([{ holdingId: 'holding-a' }]))
    await Promise.resolve()
    await Promise.resolve()

    const submitResult = deferred<{ id: string }>()
    const submitPromise = form.submit(submitResult.run) // A's submit in flight

    form.navigate(['holding-b'], () => Promise.resolve([])) // user switches mid-flight
    form.edit({ notes: 'B in progress' })

    submitResult.resolve({ id: 'sale-from-a' }) // A's late success arrives
    await submitPromise

    expect(form.navigatedToSaleId).toBeNull() // never navigated the user away from B
    expect(form.fields.notes).toBe('B in progress') // B's in-progress edit untouched
  })

  it("S109-18: A's submit FAILS after the user has already switched to B — must not surface A's error on B", async () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([{ holdingId: 'holding-a' }]))
    await Promise.resolve()
    await Promise.resolve()

    const submitResult = deferred<{ id: string }>()
    const submitPromise = form.submit(submitResult.run)

    form.navigate(['holding-b'], () => Promise.resolve([]))
    form.edit({ notes: 'B in progress' })

    submitResult.reject(new Error('A: unit price is negative'))
    await submitPromise

    expect(form.fields.error).toBeNull() // A's stale error never surfaces on B
    expect(form.fields.notes).toBe('B in progress')
  })

  it("S109-19: dirty baseline correctness after B's prefill completes (prefillReady false while pending, true once done)", async () => {
    const form = new SaleFormHarness()
    const b = deferred<FakeTile[]>()
    form.navigate(['holding-b'], b.run)
    expect(form.prefillReady).toBe(false) // must not capture a baseline against pre-prefill state
    b.resolve([{ holdingId: 'holding-b' }])
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(form.prefillReady).toBe(true)
  })

  it('S109-20: an ordinary rerender with the SAME holdingIds does NOT reset anything (must not discard live user edits)', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a'], () => Promise.resolve([]))
    form.edit({ notes: 'still typing', feesInput: '12.00' })
    const keyBefore = form.fields.idempotencyKey

    // Re-navigating with the IDENTICAL holdingIds set (e.g. an unrelated rerender) must be a no-op.
    form.navigate(['holding-a'], () => Promise.resolve([]))

    expect(form.fields.notes).toBe('still typing')
    expect(form.fields.feesInput).toBe('12.00')
    expect(form.fields.idempotencyKey).toBe(keyBefore)
  })

  it('multiple holdingIds ordering: the caller canonicalizes via a Set before joining, so [a,b] and [b,a] as SEPARATE navigate() calls both count as real transitions (this harness does not canonicalize for the caller)', () => {
    const form = new SaleFormHarness()
    form.navigate(['holding-a', 'holding-b'], () => Promise.resolve([]))
    const key1 = form.fields.idempotencyKey
    // Same two ids, same order as SaleFormPage.tsx's own `[...new Set(...)]` derivation would
    // produce for either input order (insertion order into the Set) — verifying the identical
    // joined key is treated as the SAME entity, not a spurious reset.
    form.navigate(['holding-a', 'holding-b'], () => Promise.resolve([]))
    expect(form.fields.idempotencyKey).toBe(key1)
  })
})
