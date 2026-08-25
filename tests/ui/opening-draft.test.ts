import { describe, expect, it } from 'vitest'

import {
  buildBoughtAndOpenedInput,
  buildCreateOpeningInput,
  dateIsValidAndNotFuture,
  draftCostPreview,
  draftStore,
  initialDraft,
  reduceDraft,
  reviewError,
  singleSourceAutoSelect,
  sourcesForHolding,
  stepError,
  type OpeningDraft,
  type PullDraft,
} from '../../src/features/openings/draft'
import type { OpeningSource } from '../../src/features/openings/contract'
import { parseNokInput } from '../../src/ui/money-format'

/**
 * The opening wizard's behavioural gate (prompt §24), exercised against the pure state machine in
 * src/features/openings/draft.ts — no React, no router, no production DB. Every prompt-mandated
 * behaviour maps to one or more cases here.
 */

function source(overrides: Partial<OpeningSource> = {}): OpeningSource {
  return {
    lotId: 'lot-1',
    holdingId: 'holding-1',
    productId: 'product-1',
    productName: 'Prismatic Evolutions ETB',
    productTypeName: 'elite_trainer_box',
    setName: 'Prismatic Evolutions',
    imageUrl: null,
    quantityAvailable: 10,
    acquiredOn: '2026-07-01',
    costKnown: true,
    effectiveUnitBasisNokMinor: 59900n,
    exhaustionResidualNokMinor: 0n,
    ...overrides,
  }
}

const CTX_ONE_LOT = () => ({ availableSources: [source()], selectedLotId: 'lot-1' })
const CTX_TWO_LOTS = () => ({
  availableSources: [
    source(),
    source({ lotId: 'lot-2', acquiredOn: '2026-03-15', costKnown: false }),
  ],
  selectedLotId: null,
})

function draftWithSource(s: OpeningSource, overrides: Partial<OpeningDraft> = {}): OpeningDraft {
  return {
    ...reduceDraft(initialDraft({ holdingId: s.holdingId }), { type: 'SELECT_SOURCE', source: s }),
    ...overrides,
  }
}

describe('entry point preselection', () => {
  it('a sealed Holding Detail launch preselects its holding and lot', () => {
    const draft = initialDraft({ holdingId: 'holding-9', lotId: 'lot-9' })
    expect(draft.holdingId).toBe('holding-9')
    expect(draft.lotId).toBe('lot-9')
  })

  it('the quick-add launch starts with nothing preselected', () => {
    const draft = initialDraft()
    expect(draft.holdingId).toBeNull()
    expect(draft.lotId).toBeNull()
  })
})

describe('multi-lot choice (prompt §7)', () => {
  it('several lots are listed and none is silently chosen', () => {
    const sources = CTX_TWO_LOTS().availableSources
    expect(sourcesForHolding(sources, 'holding-1')).toHaveLength(2)
    expect(singleSourceAutoSelect(sources)).toBeNull()
    // Gate: advancing without an explicit pick is refused.
    const draft = initialDraft({ holdingId: 'holding-1' })
    expect(stepError('quantity', draft, { ...CTX_TWO_LOTS(), selectedLotId: null })).toMatch(
      /Choose which acquisition lot/,
    )
  })

  it('a holding-scoped entry shows only that holding’s lots', () => {
    const otherHolding = source({ lotId: 'other-lot', holdingId: 'holding-2' })
    const scoped = sourcesForHolding([source(), otherHolding], 'holding-2')
    expect(scoped.map((s) => s.lotId)).toEqual(['other-lot'])
  })

  it('exactly one eligible lot auto-confirms without asking', () => {
    const only = singleSourceAutoSelect(CTX_ONE_LOT().availableSources)
    expect(only?.lotId).toBe('lot-1')
  })
})

describe('quantity range (prompt §8)', () => {
  const base = source()

  it('zero and negative are refused', () => {
    const d0 = draftWithSource(base, { quantityInput: '0' })
    const dNeg = draftWithSource(base, { quantityInput: '-3' })
    expect(stepError('quantity', d0, CTX_ONE_LOT())).toMatch(/at least 1/)
    expect(stepError('quantity', dNeg, CTX_ONE_LOT())).toMatch(/at least 1/)
  })

  it('more than available is refused with the availability named', () => {
    const draft = draftWithSource(base, { quantityInput: '11' })
    expect(stepError('quantity', draft, CTX_ONE_LOT())).toMatch(/Only 10 available/)
  })

  it('the whole valid range accepts, including the full lot', () => {
    for (const q of ['1', '5', '10']) {
      const draft = draftWithSource(base, { quantityInput: q })
      expect(stepError('quantity', draft, CTX_ONE_LOT())).toBeNull()
    }
  })

  it('switching lots clamps an impossible typed quantity into the new bounds', () => {
    const big = source({ lotId: 'big', quantityAvailable: 12 })
    const small = source({ lotId: 'small', quantityAvailable: 2 })
    let draft = draftWithSource(big, { quantityInput: '12' })
    draft = reduceDraft(draft, { type: 'SELECT_SOURCE', source: small })
    expect(draft.quantityInput).toBe('2')
  })

  it('"Open N of M" reads from the draft and the lot, not free text', () => {
    const draft = draftWithSource(base, { quantityInput: '3' })
    const parsed = Number.parseInt(draft.quantityInput, 10)
    expect(`Open ${parsed} of ${base.quantityAvailable}`).toBe('Open 3 of 10')
  })
})

describe('opening date (prompt §9)', () => {
  const base = source()

  it('defaults to today', () => {
    const draft = initialDraft()
    expect(draft.openedOn).toBe(new Date().toISOString().slice(0, 10))
  })

  it('backdating is accepted', () => {
    const draft = draftWithSource(base, { openedOn: '2026-01-02' })
    expect(stepError('quantity', draft, CTX_ONE_LOT())).toBeNull()
  })

  it('a future date is refused', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    expect(dateIsValidAndNotFuture(tomorrow)).toBe(false)
    const draft = draftWithSource(base, { openedOn: tomorrow })
    expect(stepError('quantity', draft, CTX_ONE_LOT())).toMatch(/today or earlier/)
  })

  it('garbage dates are refused', () => {
    expect(dateIsValidAndNotFuture('15/01/2026')).toBe(false)
    expect(dateIsValidAndNotFuture('')).toBe(false)
  })
})

describe('pull drafts (prompt §10/§11/§24)', () => {
  const variantPull: Omit<PullDraft, 'key' | 'quantity'> = {
    cardVariantId: 'variant-1',
    manualCardId: null,
    manualIdentity: null,
    displayName: 'Charizard ex',
    subtitle: 'Obsidian Flames · #125',
    imageBaseUrl: null,
    finishLabel: 'Normal',
    condition: 'NM' as const,
  }

  function addPull(
    draft: OpeningDraft,
    pull: Omit<PullDraft, 'key' | 'quantity'>,
    quantity: number,
  ): OpeningDraft {
    return reduceDraft(draft, {
      type: 'ADD_PULL',
      pull,
      quantity,
      makeKey: () => `k${draft.pulls.length + 1}`,
    })
  }

  it('adding and removing drafts works', () => {
    let draft = addPull(initialDraft(), variantPull, 2)
    expect(draft.pulls).toHaveLength(1)
    draft = reduceDraft(draft, { type: 'REMOVE_PULL', key: draft.pulls[0]!.key })
    expect(draft.pulls).toHaveLength(0)
  })

  it('recording the same printing again merges quantities instead of duplicating the line', () => {
    let draft = addPull(initialDraft(), variantPull, 1)
    draft = addPull(draft, variantPull, 3)
    expect(draft.pulls).toHaveLength(1)
    expect(draft.pulls[0]?.quantity).toBe(4)
  })

  it('a different condition of the same card is a separate line', () => {
    let draft = addPull(initialDraft(), variantPull, 1)
    draft = addPull(draft, { ...variantPull, condition: 'GD' }, 2)
    expect(draft.pulls).toHaveLength(2)
  })

  it('two catalog-missing cards with identical stated identity merge; different names do not', () => {
    const manualA = {
      ...variantPull,
      cardVariantId: null,
      manualIdentity: { name: 'Local energy', setName: undefined, collectorNumber: undefined },
    }
    let draft = addPull(initialDraft(), manualA, 1)
    draft = addPull(draft, manualA, 5)
    expect(draft.pulls).toHaveLength(1)
    draft = addPull(draft, { ...manualA, manualIdentity: { name: 'Other oddity' } }, 1)
    expect(draft.pulls).toHaveLength(2)
  })

  it('per-line quantity edits floor at 1 — a pull line never becomes zero silently', () => {
    let draft = addPull(initialDraft(), variantPull, 2)
    const key = draft.pulls[0]!.key
    draft = reduceDraft(draft, { type: 'SET_PULL_QUANTITY', key, quantity: 0 })
    expect(draft.pulls[0]?.quantity).toBe(1)
  })
})

describe('tracking completeness (prompt §12)', () => {
  it('all three states set and hold', () => {
    for (const value of ['all_cards', 'selected_pulls', 'unknown'] as const) {
      const draft = reduceDraft(initialDraft(), { type: 'SET_COMPLETENESS', value })
      expect(draft.completeness).toBe(value)
    }
  })

  it('default is all_cards (PRODUCT_SPEC §4.7)', () => {
    expect(initialDraft().completeness).toBe('all_cards')
  })

  it('an empty pull list may not pass as all_cards — it must be declared honestly', () => {
    const emptyAll = reviewError(initialDraft())
    expect(emptyAll).toMatch(/declare that you recorded only selected pulls/)
    const declaredSelected = reduceDraft(initialDraft(), {
      type: 'SET_COMPLETENESS',
      value: 'selected_pulls',
    })
    expect(reviewError(declaredSelected)).toBeNull()
  })
})

describe('bulk remainder estimate (prompt §13)', () => {
  it('optional — absent fields produce no remainder in the input', () => {
    const input = buildCreateOpeningInput(
      draftWithSource(source(), { quantityInput: '1' }),
      'lot-1',
      'key-1',
      (raw) => BigInt(Math.round(Number.parseFloat(raw) * 100)),
    )
    expect(input.bulkRemainderEstimateMinor).toBeUndefined()
    expect(input.bulkRemainderCount).toBeUndefined()
  })

  it('half-filled pairs are refused — both or neither', () => {
    const estimateOnly = draftWithSource(source(), { bulkEstimateInput: '240', bulkCountInput: '' })
    const countOnly = draftWithSource(source(), { bulkEstimateInput: '', bulkCountInput: '60' })
    expect(reviewError(estimateOnly)).toMatch(/both/)
    expect(reviewError(countOnly)).toMatch(/both/)
  })

  it('a filled pair travels as minor units plus count', () => {
    const input = buildCreateOpeningInput(
      draftWithSource(source(), { bulkEstimateInput: '240,50', bulkCountInput: '60' }),
      'lot-1',
      'key-1',
      (raw) => BigInt(Math.round(Number.parseFloat(raw.replace(',', '.')) * 100)),
    )
    expect(input.bulkRemainderEstimateMinor).toBe(24050n)
    expect(input.bulkRemainderCount).toBe(60)
  })
})

describe('submission lifecycle (prompt §23/§24)', () => {
  it('double-submit is swallowed while a submission is in flight', () => {
    let draft = reduceDraft(initialDraft(), { type: 'BEGIN_SUBMIT' })
    expect(draft.phase).toBe('submitting')
    draft = reduceDraft(draft, { type: 'BEGIN_SUBMIT' })
    expect(draft.phase).toBe('submitting')
    expect(draft.submitError).toBeNull()
  })

  it('a controller failure retains EVERY drafted field verbatim', () => {
    const before = draftWithSource(source(), {
      quantityInput: '2',
      openedOn: '2026-05-05',
      completeness: 'selected_pulls',
      bulkEstimateInput: '120',
      bulkCountInput: '30',
      notes: 'top rows were damp',
    })
    const submitted = reduceDraft(before, { type: 'BEGIN_SUBMIT' })
    const failed = reduceDraft(submitted, {
      type: 'SUBMIT_FAILED',
      message: 'network unreachable',
    })
    expect(failed).toEqual({ ...before, submitError: 'network unreachable' })
    expect(failed.pulls).toBe(before.pulls)
  })

  it('success records the opening id and ends the editing phase', () => {
    let draft = reduceDraft(initialDraft(), { type: 'BEGIN_SUBMIT' })
    draft = reduceDraft(draft, { type: 'SUBMIT_SUCCEEDED', openingId: 'opening-77' })
    expect(draft.phase).toBe('submitted')
    expect(draft.submittedOpeningId).toBe('opening-77')
  })
})

describe('create-opening input assembly', () => {
  const parseNok = (raw: string) =>
    BigInt(Math.round(Number.parseFloat(raw.replace(',', '.')) * 100))

  it('carries identity, range-checked numbers and the idempotency key', () => {
    const pulls = [
      {
        key: 'k1',
        cardVariantId: 'v1',
        manualCardId: null,
        manualIdentity: null,
        displayName: 'A',
        subtitle: null,
        imageBaseUrl: null,
        finishLabel: null,
        condition: 'NM' as const,
        quantity: 2,
      },
    ]
    const input = buildCreateOpeningInput(
      draftWithSource(source(), { quantityInput: '2', pulls }),
      'lot-1',
      'key-abc',
      parseNok,
    )
    expect(input.idempotencyKey).toBe('key-abc')
    expect(input.sourceLotId).toBe('lot-1')
    expect(input.quantity).toBe(2)
    expect(input.openedOn).toBeTruthy()
    expect(input.trackingCompleteness).toBe('all_cards')
    expect(input.pulls).toEqual([
      { cardVariantId: 'v1', manualCardId: undefined, condition: 'NM', quantity: 2 },
    ])
  })

  it('refuses to send an unresolved manual-card identity', () => {
    const broken = draftWithSource(source(), {
      pulls: [
        {
          key: 'k1',
          cardVariantId: null,
          manualCardId: null,
          manualIdentity: { name: 'Unresolved' },
          displayName: 'Unresolved',
          subtitle: null,
          imageBaseUrl: null,
          finishLabel: null,
          condition: 'NM',
          quantity: 1,
        },
      ],
    })
    expect(() => buildCreateOpeningInput(broken, 'lot-1', 'key', parseNok)).toThrow(
      /resolved identity/,
    )
  })
})

describe('session-memory draft store — USER-SCOPED (prompt §23, P56 §9)', () => {
  it("a user's draft survives an unload/remount cycle and clears on deliberate reset", () => {
    draftStore.clearAll()
    const draft = draftWithSource(source(), { quantityInput: '7' })
    draftStore.save('user-a', draft)
    expect(draftStore.load('user-a')?.quantityInput).toBe('7')
    // Deliberate RESET drops only this user's stored draft.
    draftStore.clear('user-a')
    expect(draftStore.load('user-a')).toBeNull()
  })

  it('another account never inherits the previous account’s in-memory draft', () => {
    draftStore.clearAll()
    draftStore.save(
      'user-a',
      draftWithSource(source(), { quantityInput: '3', notes: 'private stash' }),
    )
    expect(draftStore.load('user-b')).toBeNull()
    // B saving their own draft does not disturb A's.
    draftStore.save('user-b', draftWithSource(source(), { quantityInput: '9' }))
    expect(draftStore.load('user-a')?.quantityInput).toBe('3')
    expect(draftStore.load('user-b')?.quantityInput).toBe('9')
    draftStore.clearAll()
  })

  it('an anonymous owner loads and saves nothing', () => {
    draftStore.clearAll()
    draftStore.save('user-a', draftWithSource(source(), { quantityInput: '4' }))
    expect(draftStore.load(null)).toBeNull()
    // A save without an authenticated owner is refused outright.
    draftStore.save(null, draftWithSource(source(), { quantityInput: '1' }))
    expect(draftStore.load(null)).toBeNull()
    draftStore.clearAll()
  })

  it('clearAll drops every account’s draft at once (sign-out path)', () => {
    draftStore.save('user-a', draftWithSource(source(), { quantityInput: '2' }))
    draftStore.save('user-b', draftWithSource(source(), { quantityInput: '5' }))
    draftStore.clearAll()
    expect(draftStore.load('user-a')).toBeNull()
    expect(draftStore.load('user-b')).toBeNull()
  })
})

describe('manual-card resolution persistence (P56 §10)', () => {
  function manualPullDraft(): OpeningDraft {
    return reduceDraft(initialDraft(), {
      type: 'ADD_PULL',
      pull: {
        cardVariantId: null,
        manualCardId: null,
        manualIdentity: { name: 'Local energy' },
        displayName: 'Local energy',
        subtitle: null,
        imageBaseUrl: null,
        finishLabel: null,
        condition: 'NM' as const,
      },
      quantity: 1,
      makeKey: () => 'k1',
    })
  }

  it('RESOLVE_MANUAL_CARDS writes the created id onto the pull line', () => {
    const draft = manualPullDraft()
    const resolved = reduceDraft(draft, {
      type: 'RESOLVE_MANUAL_CARDS',
      idsByKey: new Map([['k1', 'manual-42']]),
    })
    expect(resolved.pulls[0]?.manualCardId).toBe('manual-42')
    // The identity stays too — display and merge logic keep working.
    expect(resolved.pulls[0]?.manualIdentity?.name).toBe('Local energy')
  })

  it('a resolved id makes the assembled input reuse THAT definition — no second row on retry', () => {
    const resolved = reduceDraft(manualPullDraft(), {
      type: 'RESOLVE_MANUAL_CARDS',
      idsByKey: new Map([['k1', 'manual-42']]),
    })
    const input = buildCreateOpeningInput(resolved, 'lot-1', 'key-retry', parseNokInput)
    expect(input.pulls[0]?.manualCardId).toBe('manual-42')
  })

  it('resolution survives a submit failure untouched (failure retains every field)', () => {
    let draft = reduceDraft(manualPullDraft(), {
      type: 'RESOLVE_MANUAL_CARDS',
      idsByKey: new Map([['k1', 'manual-42']]),
    })
    draft = reduceDraft(draft, { type: 'BEGIN_SUBMIT' })
    draft = reduceDraft(draft, { type: 'SUBMIT_FAILED', message: 'opening RPC failed' })
    expect(draft.phase).toBe('editing')
    expect(draft.submitError).toBe('opening RPC failed')
    expect(draft.pulls[0]?.manualCardId).toBe('manual-42')
  })

  it('unknown keys and empty maps change nothing', () => {
    const draft = manualPullDraft()
    expect(reduceDraft(draft, { type: 'RESOLVE_MANUAL_CARDS', idsByKey: new Map() })).toBe(draft)
    const untouched = reduceDraft(draft, {
      type: 'RESOLVE_MANUAL_CARDS',
      idsByKey: new Map([['other-key', 'manual-7']]),
    })
    expect(untouched.pulls[0]?.manualCardId).toBeNull()
  })
})

describe('cost preview (prompt §14 / P53 §7 exact rule)', () => {
  it('a partial opening previews pure units — no residual before exhaustion', () => {
    // The canonical 29995-øre lot: unit basis 9998, residual +1, quantity 3.
    const lot = source({
      quantityAvailable: 3,
      effectiveUnitBasisNokMinor: 9998n,
      exhaustionResidualNokMinor: 1n,
    })
    const preview = draftCostPreview(draftWithSource(lot, { quantityInput: '2' }), lot)
    expect(preview).toEqual({ kind: 'known', minorUnits: 19996n })
    // Exhausting the lot adds the residual exactly once — preview == recorded cost (I5).
    const final = draftCostPreview(draftWithSource(lot, { quantityInput: '3' }), lot)
    expect(final).toEqual({ kind: 'known', minorUnits: 29995n })
  })

  it('an unknown-cost lot stays unknown — never multiplied into zero', () => {
    const unknownLot = source({
      costKnown: false,
      effectiveUnitBasisNokMinor: null,
      exhaustionResidualNokMinor: null,
    })
    const preview = draftCostPreview(draftWithSource(unknownLot), unknownLot)
    expect(preview).toEqual({ kind: 'unknown' })
  })
})

describe('bought-and-open mode (P53 §11)', () => {
  it('defaults to the existing-lot mode', () => {
    expect(initialDraft().mode).toBe('existing_lot')
  })

  it('switching modes clears the other mode’s selection but keeps entered pulls', () => {
    let draft = reduceDraft(initialDraft(), {
      type: 'SELECT_SOURCE',
      source: source(),
    })
    draft = reduceDraft(draft, {
      type: 'ADD_PULL',
      pull: {
        cardVariantId: 'variant-1',
        manualCardId: null,
        manualIdentity: null,
        displayName: 'Charizard',
        subtitle: null,
        imageBaseUrl: null,
        finishLabel: null,
        condition: 'NM',
      },
      quantity: 1,
      makeKey: () => 'k1',
    })
    draft = reduceDraft(draft, { type: 'SET_MODE', mode: 'bought_now' })
    expect(draft.mode).toBe('bought_now')
    expect(draft.lotId).toBeNull()
    expect(draft.pulls).toHaveLength(1)
    // And back again clears the product, not the pulls.
    draft = reduceDraft(draft, {
      type: 'SELECT_PRODUCT',
      productId: 'product-9',
      productName: 'Booster bundle',
    })
    draft = reduceDraft(draft, { type: 'SET_MODE', mode: 'existing_lot' })
    expect(draft.productId).toBeNull()
    expect(draft.pulls).toHaveLength(1)
  })

  it('the bought-now gates require product, total paid and valid dates', () => {
    let draft = reduceDraft(initialDraft(), { type: 'SET_MODE', mode: 'bought_now' })
    expect(stepError('source', draft, CTX_ONE_LOT())).toMatch(/Choose the sealed product/)
    draft = reduceDraft(draft, {
      type: 'SELECT_PRODUCT',
      productId: 'product-9',
      productName: 'Booster bundle',
    })
    expect(stepError('source', draft, { availableSources: [], selectedLotId: null })).toBeNull()
    expect(stepError('quantity', draft, { availableSources: [], selectedLotId: null })).toMatch(
      /total you paid/,
    )
    draft = reduceDraft(draft, { type: 'SET_TOTAL_PAID_INPUT', value: '299,95' })
    expect(stepError('quantity', draft, { availableSources: [], selectedLotId: null })).toBeNull()
  })

  it('buildBoughtAndOpenedInput carries the exact entered total and idempotency key', () => {
    let draft = reduceDraft(initialDraft(), { type: 'SET_MODE', mode: 'bought_now' })
    draft = reduceDraft(draft, {
      type: 'SELECT_PRODUCT',
      productId: 'product-9',
      productName: 'Booster bundle',
    })
    draft = reduceDraft(draft, { type: 'SET_QUANTITY_INPUT', value: '3' })
    draft = reduceDraft(draft, { type: 'SET_TOTAL_PAID_INPUT', value: '299,95' })
    draft = reduceDraft(draft, { type: 'SET_PURCHASED_ON', value: '2026-08-01' })
    const input = buildBoughtAndOpenedInput(draft, 'key-1', parseNokInput)
    expect(input.sealedProductId).toBe('product-9')
    expect(input.quantity).toBe(3)
    expect(input.totalPaidNokMinor).toBe(29995n)
    expect(input.idempotencyKey).toBe('key-1')
    expect(input.purchasedOn).toBe('2026-08-01')
  })

  it('building without a product is a programming error, never a silent submission', () => {
    const draft = reduceDraft(initialDraft(), { type: 'SET_MODE', mode: 'bought_now' })
    expect(() => buildBoughtAndOpenedInput(draft, 'key-2', parseNokInput)).toThrow(
      /Choose the sealed product/,
    )
  })
})
