import { describe, expect, it } from 'vitest'
import {
  createInitialSaleFormFields,
  EntityKeyChangeTracker,
} from '../../src/features/sales/sale-form-state'

describe('createInitialSaleFormFields', () => {
  it('returns fresh, empty defaults for every submission-bound field', () => {
    const fields = createInitialSaleFormFields(() => '2026-03-01')
    expect(fields).toMatchObject({
      items: [],
      soldOn: '2026-03-01',
      marketplace: '',
      currency: 'NOK',
      feesInput: '',
      shippingCostInput: '',
      shippingChargedInput: '',
      notes: '',
      fxMode: 'norges_bank',
      fxRate: '',
      fxRateDate: '',
      fxError: null,
      error: null,
    })
  })

  it('mints a fresh idempotency key on every call — never reused across two fresh forms', () => {
    const a = createInitialSaleFormFields(() => '2026-03-01')
    const b = createInitialSaleFormFields(() => '2026-03-01')
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey)
    expect(a.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('EntityKeyChangeTracker', () => {
  it('never reports a change on the very first observation — initial state is already fresh', () => {
    const tracker = new EntityKeyChangeTracker()
    expect(tracker.observe('holding-a')).toBe(false)
    expect(tracker.generation()).toBe(0)
  })

  it('an ordinary rerender with the SAME key never reports a change', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('holding-a')
    expect(tracker.observe('holding-a')).toBe(false)
    expect(tracker.observe('holding-a')).toBe(false)
    expect(tracker.generation()).toBe(0)
  })

  it('a genuinely different key reports a change and bumps the generation', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('holding-a')
    expect(tracker.observe('holding-b')).toBe(true)
    expect(tracker.generation()).toBe(1)
  })

  it('A -> B -> A: returning to an earlier key is STILL a genuine change (a fresh instance from the user perspective), not a no-op', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('holding-a')
    expect(tracker.observe('holding-b')).toBe(true)
    expect(tracker.observe('holding-a')).toBe(true)
    expect(tracker.generation()).toBe(2)
  })

  it('empty-to-nonempty and nonempty-to-empty holdingIds transitions both count as real changes', () => {
    const tracker = new EntityKeyChangeTracker()
    tracker.observe('') // manual add-sale, no holdingId — first observation, not a change
    expect(tracker.observe('holding-a')).toBe(true)
    expect(tracker.observe('')).toBe(true)
  })

  it('multiple holdingIds: order/canonicalization is the CALLER’s job — an identical joined key never reports a change', () => {
    const tracker = new EntityKeyChangeTracker()
    // SaleFormPage derives prefillKey from a Set, so the caller already canonicalizes order —
    // this tracker only ever sees the final joined string.
    tracker.observe('holding-a,holding-b')
    expect(tracker.observe('holding-a,holding-b')).toBe(false)
    expect(tracker.observe('holding-b,holding-a')).toBe(true) // a different literal key IS a change
  })
})
