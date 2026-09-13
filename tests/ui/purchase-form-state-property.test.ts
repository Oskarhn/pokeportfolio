import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  addPurchaseLine,
  createInitialPurchaseFormFields,
  patchPurchaseFormFields,
  removePurchaseLine,
  updatePurchaseLine,
  type PurchaseFormFields,
} from '../../src/features/purchases/purchase-form-state'

/**
 * P124 §9 — randomized operation-sequence property fuzz for Purchase Add's extracted pure state
 * (purchase-form-state.ts), mirroring sale-form-state-property.test.ts's technique. Purchase Add
 * has no URL-driven entity identity (see that module's header) — "new logical attempt" here means
 * what the real component does after a successful submit: React unmounts and remounts it (a fresh
 * navigation to /purchases/new), which is exactly `createInitialPurchaseFormFields()` again.
 */

const WALK_TODAY = '2026-01-01'

type Op =
  | {
      kind: 'mutateField'
      field:
        | 'purchasedOn'
        | 'notes'
        | 'shippingInput'
        | 'customsInput'
        | 'discountInput'
        | 'retailerId'
        | 'newRetailerName'
      value: string
    }
  | { kind: 'addLine' }
  | { kind: 'removeLine'; index: number }
  | { kind: 'changeLine'; index: number; unitPrice: string; quantity: string }
  | { kind: 'changeCurrency'; currency: PurchaseFormFields['currency'] }
  | { kind: 'changeFxMode'; mode: 'norges_bank' | 'manual' }
  | { kind: 'serverError'; message: string }
  | { kind: 'clearError' }
  | { kind: 'newLogicalAttempt' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('mutateField' as const),
    field: fc.constantFrom(
      'purchasedOn',
      'notes',
      'shippingInput',
      'customsInput',
      'discountInput',
      'retailerId',
      'newRetailerName',
    ),
    value: fc.string({ minLength: 0, maxLength: 12 }),
  }),
  fc.record({ kind: fc.constant('addLine' as const) }),
  fc.record({ kind: fc.constant('removeLine' as const), index: fc.nat(10) }),
  fc.record({
    kind: fc.constant('changeLine' as const),
    index: fc.nat(10),
    unitPrice: fc.string({ minLength: 0, maxLength: 8 }),
    quantity: fc.string({ minLength: 0, maxLength: 3 }),
  }),
  fc.record({
    kind: fc.constant('changeCurrency' as const),
    currency: fc.constantFrom<PurchaseFormFields['currency']>('NOK', 'EUR', 'USD', 'GBP', 'JPY'),
  }),
  fc.record({
    kind: fc.constant('changeFxMode' as const),
    mode: fc.constantFrom<'norges_bank' | 'manual'>('norges_bank', 'manual'),
  }),
  fc.record({
    kind: fc.constant('serverError' as const),
    message: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.record({ kind: fc.constant('clearError' as const) }),
  fc.record({ kind: fc.constant('newLogicalAttempt' as const) }),
)

/** Applies one op to `fields` using ONLY the real exported pure functions — never a
 *  re-implementation of their logic — mirroring exactly what PurchaseFormPage's handlers do. */
function apply(fields: PurchaseFormFields, op: Op): PurchaseFormFields {
  switch (op.kind) {
    case 'mutateField':
      return patchPurchaseFormFields(fields, { [op.field]: op.value })
    case 'addLine':
      return addPurchaseLine(fields)
    case 'removeLine': {
      if (fields.lines.length <= 1) return fields // component keeps at least one line (canRemove guard)
      const target = fields.lines[op.index % fields.lines.length]!
      return removePurchaseLine(fields, target.id)
    }
    case 'changeLine': {
      if (fields.lines.length === 0) return fields
      const target = fields.lines[op.index % fields.lines.length]!
      return updatePurchaseLine(fields, target.id, {
        unitPrice: op.unitPrice,
        quantity: op.quantity,
      })
    }
    case 'changeCurrency':
      return patchPurchaseFormFields(fields, { currency: op.currency, fxRate: '' })
    case 'changeFxMode':
      return patchPurchaseFormFields(fields, { fxMode: op.mode })
    case 'serverError':
      return patchPurchaseFormFields(fields, { error: op.message })
    case 'clearError':
      return patchPurchaseFormFields(fields, { error: null })
    case 'newLogicalAttempt':
      return createInitialPurchaseFormFields(() => WALK_TODAY)
  }
}

describe('createInitialPurchaseFormFields — property: every call is fully independent, no shared/leaked state', () => {
  it('mints a distinct idempotencyKey on every call, across any number of calls', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 200 }), (n) => {
        const keys = Array.from(
          { length: n },
          () => createInitialPurchaseFormFields().idempotencyKey,
        )
        expect(new Set(keys).size).toBe(n)
      }),
      { numRuns: 200 },
    )
  })

  it('always returns the documented fresh defaults regardless of call count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        for (let i = 0; i < n; i += 1) {
          const fields = createInitialPurchaseFormFields(() => '2026-01-01')
          expect(fields.retailerId).toBe('')
          expect(fields.newRetailerName).toBe('')
          expect(fields.currency).toBe('NOK')
          expect(fields.lines).toHaveLength(1)
          expect(fields.shippingInput).toBe('')
          expect(fields.customsInput).toBe('')
          expect(fields.discountInput).toBe('')
          expect(fields.notes).toBe('')
          expect(fields.fxMode).toBe('norges_bank')
          expect(fields.fxRate).toBe('')
          expect(fields.fxRateDate).toBe('')
          expect(fields.fxError).toBeNull()
          expect(fields.error).toBeNull()
          expect(fields.purchasedOn).toBe('2026-01-01')
        }
      }),
      { numRuns: 200 },
    )
  })
})

describe('simulated Purchase Add form over a random operation walk — reset/idempotency/error invariants', () => {
  /** P124 §9: >=50,000 runs over a random walk of every documented operation kind. */
  it('reset returns exact defaults, no cross-attempt leakage, idempotencyKey stable within an attempt, errors clear only when intended', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 150 }), (ops) => {
        let fields: PurchaseFormFields = createInitialPurchaseFormFields(() => WALK_TODAY)
        let idempotencyKeyAtAttemptStart = fields.idempotencyKey
        const seenIdempotencyKeys = new Set([fields.idempotencyKey])

        for (const op of ops) {
          const before = fields
          fields = apply(fields, op)

          if (op.kind === 'newLogicalAttempt') {
            // Property: reset returns EXACT defaults — every field, against LITERAL expected
            // constants (never a second call to the function under test — that would share
            // any bug the function has with itself and silently pass; caught by mutation-testing
            // this exact property, see P124 output file).
            expect(fields.retailerId).toBe('')
            expect(fields.newRetailerName).toBe('')
            expect(fields.currency).toBe('NOK')
            expect(fields.lines).toHaveLength(1)
            expect(fields.shippingInput).toBe('')
            expect(fields.customsInput).toBe('')
            expect(fields.discountInput).toBe('')
            expect(fields.notes).toBe('')
            expect(fields.fxMode).toBe('norges_bank')
            expect(fields.fxRate).toBe('')
            expect(fields.fxRateDate).toBe('')
            expect(fields.fxError).toBeNull()
            expect(fields.error).toBeNull()
            expect(fields.purchasedOn).toBe(WALK_TODAY)
            // Property: state from the previous logical attempt cannot leak — nothing mutated
            // before this op survives onto the new attempt's object identity.
            expect(fields).not.toBe(before)
            expect(fields.lines[0]).not.toBe(before.lines[0])
            // Property: idempotency-key semantics — a genuinely NEW key every logical attempt,
            // never reused from any earlier attempt in this walk.
            expect(seenIdempotencyKeys.has(fields.idempotencyKey)).toBe(false)
            seenIdempotencyKeys.add(fields.idempotencyKey)
            idempotencyKeyAtAttemptStart = fields.idempotencyKey
          } else {
            // Property: idempotency key is STABLE across every ordinary op within one logical
            // attempt (never regenerated by a field edit, a line change, or an error).
            expect(fields.idempotencyKey).toBe(idempotencyKeyAtAttemptStart)
          }

          if (op.kind === 'serverError') {
            expect(fields.error).toBe(op.message)
          }
          if (op.kind === 'clearError') {
            expect(fields.error).toBeNull()
          }
          // Property: errors clear ONLY when intended — an ordinary field/line/currency/fx
          // mutation must never silently clear a pending error out from under the user.
          if (
            op.kind !== 'serverError' &&
            op.kind !== 'clearError' &&
            op.kind !== 'newLogicalAttempt' &&
            before.error !== null
          ) {
            expect(fields.error).toBe(before.error)
          }
        }
      }),
      { numRuns: 50000 },
    )
  }, 120000)
})
