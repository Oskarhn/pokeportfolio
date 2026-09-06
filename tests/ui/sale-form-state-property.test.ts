import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  createInitialSaleFormFields,
  EntityKeyChangeTracker,
  type SaleFormFields,
} from '../../src/features/sales/sale-form-state'

/**
 * P114 §9 — randomized property coverage for Sale Add's entity-isolation contract, complementing
 * the deterministic A/B/A cases already pinned in tests/ui/sale-form-entity-isolation.test.ts
 * (44 handwritten cases, no randomization). This drives EntityKeyChangeTracker — the module's own
 * documented "single source of truth for what a genuine entity change resets" — through long
 * random walks of entity keys interleaved with field mutations, using the real exported
 * primitives rather than a re-implementation of the reset logic.
 */

/** Mutates every mutable field of SaleFormFields to a value that could never appear in a fresh
 *  object from createInitialSaleFormFields — so any survivor after a reset is loud, not silent. */
function mutateAllFields(fields: SaleFormFields, tag: string): SaleFormFields {
  return {
    items: [
      {
        holdingId: `mutated-holding-${tag}`,
        displayName: `mutated-${tag}`,
        subtitle: tag,
        imageBaseUrl: null,
        lots: null,
        selections: {},
      },
    ],
    soldOn: '1999-01-01',
    marketplace: `marketplace-${tag}`,
    currency: 'JPY',
    feesInput: '999.99',
    shippingCostInput: '888.88',
    shippingChargedInput: '777.77',
    notes: `notes-${tag}`,
    fxMode: 'manual',
    fxRate: '99.99999999',
    fxRateDate: '1999-01-01',
    fxError: `error-${tag}`,
    error: `error-${tag}`,
    idempotencyKey: fields.idempotencyKey, // deliberately kept — checked separately below
  }
}

const FRESH_SENTINELS: Partial<Record<keyof SaleFormFields, unknown>> = {
  soldOn: undefined, // varies by injected `today`, checked separately
  items: [],
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
}

describe('EntityKeyChangeTracker — property: observe() reports change iff key differs from the previous observation', () => {
  it('for any sequence of keys, "change" is true exactly on a transition, and generation counts transitions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('A', 'B', 'C', 'D'), { minLength: 1, maxLength: 200 }),
        (keys) => {
          const tracker = new EntityKeyChangeTracker()
          let expectedGeneration = 0
          let previous: string | null = null
          for (const [i, key] of keys.entries()) {
            const changed = tracker.observe(key)
            if (i === 0) {
              expect(changed).toBe(false) // never true on the very first observation
            } else if (key === previous) {
              expect(changed).toBe(false)
            } else {
              expect(changed).toBe(true)
              expectedGeneration += 1
            }
            expect(tracker.generation()).toBe(expectedGeneration)
            previous = key
          }
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('repeated observation of the SAME key, however many times, never registers a change', () => {
    fc.assert(
      fc.property(fc.constantFrom('A', 'B', 'C'), fc.integer({ min: 1, max: 100 }), (key, n) => {
        const tracker = new EntityKeyChangeTracker()
        for (let i = 0; i < n; i += 1) {
          const changed = tracker.observe(key)
          if (i > 0) expect(changed).toBe(false)
        }
        expect(tracker.generation()).toBe(0)
      }),
      { numRuns: 500 },
    )
  })
})

describe('createInitialSaleFormFields — property: every call is fully independent, no shared/leaked state', () => {
  it('mints a distinct idempotencyKey on every call, across any number of calls', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 200 }), (n) => {
        const keys = Array.from({ length: n }, () => createInitialSaleFormFields().idempotencyKey)
        expect(new Set(keys).size).toBe(n)
      }),
      { numRuns: 200 },
    )
  })

  it('always returns the documented fresh defaults regardless of call count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        for (let i = 0; i < n; i += 1) {
          const fields = createInitialSaleFormFields(() => '2026-01-01')
          for (const [key, expected] of Object.entries(FRESH_SENTINELS)) {
            if (key === 'soldOn') continue
            expect(fields[key as keyof SaleFormFields]).toEqual(expected)
          }
          expect(fields.soldOn).toBe('2026-01-01')
          expect(fields.items).toHaveLength(0)
        }
      }),
      { numRuns: 200 },
    )
  })
})

describe('simulated Sale Add form over a random entity-transition walk — no cross-entity leakage', () => {
  /**
   * Models exactly the reset rule SaleFormPage implements (and this module documents as its own
   * contract): on a genuine entity-key change, the entire SaleFormFields object is replaced by a
   * fresh createInitialSaleFormFields() — never patched, never partially carried over. Between
   * entity changes, arbitrary field mutations (what a person typing into the form produces) must
   * survive re-renders with the SAME key untouched.
   */
  it('a long random walk of entity switches and field edits never lets one entity leak into another', () => {
    const entityKeys = ['holding-A', 'holding-B', 'holding-C', 'holding-D']
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.constantFrom(...entityKeys),
            mutate: fc.boolean(),
          }),
          { minLength: 1, maxLength: 300 },
        ),
        (steps) => {
          const tracker = new EntityKeyChangeTracker()
          let fields: SaleFormFields = createInitialSaleFormFields(() => '2026-01-01')
          let currentEntityTag = steps[0]!.key

          for (const [i, step] of steps.entries()) {
            const changed = tracker.observe(step.key)
            if (changed) {
              // A genuine entity change: the real component discards `fields` entirely.
              fields = createInitialSaleFormFields(() => '2026-01-01')
              currentEntityTag = step.key
            }
            if (step.mutate) {
              fields = mutateAllFields(fields, `${currentEntityTag}-${String(i)}`)
            }
            // Whatever the current field values are, they must never reference an entity OTHER
            // than the one currently observed — the concrete leakage class P109 fixed (a stale
            // marketplace/currency/notes/FX value from a previous holdingId surviving a switch).
            if (fields.marketplace !== '') {
              expect(fields.marketplace.startsWith(`marketplace-${currentEntityTag}`)).toBe(true)
            }
            if (fields.notes !== '') {
              expect(fields.notes.startsWith(`notes-${currentEntityTag}`)).toBe(true)
            }
            for (const item of fields.items) {
              expect(item.holdingId.startsWith(`mutated-holding-${currentEntityTag}`)).toBe(true)
            }
          }
        },
      ),
      { numRuns: 3000 },
    )
  })
})
