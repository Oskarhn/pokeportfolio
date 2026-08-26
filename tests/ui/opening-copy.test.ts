import { describe, expect, it } from 'vitest'

import {
  COMPLETENESS_OPTIONS,
  INCOMPLETE_TRACKING_MARKER,
  MANUAL_CARD_CREATE_FAILED,
  OPENING_COST_LABEL,
  PROVISIONAL_COST_NOTE,
  PROVISIONAL_LINK_HINT,
  PULL_COST_NOTE,
  PURCHASE_COST_NOT_RECORDED,
  RECONCILE_EMPTY_COPY,
  RECONCILE_EMPTY_HINT,
  RECONCILE_EXPLANATION,
  RECONCILED_STATE_LABEL,
  THE_SEALED_NOTICE,
  UNPRICED_RETAINED_MARKER,
  VOID_PURCHASE_NOTE,
  completenessNote,
  formatNok,
  openingCostPreview,
  pullRemainingCopy,
  resultCopy,
} from '../../src/features/openings/copy'
import type { OpeningDetail } from '../../src/features/openings/contract'

/**
 * The honesty language of the openings feature (prompt §14/§15/§17), pinned as tests. These copy
 * rules come straight from FINANCIAL_MODEL.md §5 and the project's core quality bar — missing
 * money is never zero, per-pull ROI does not exist, and a partially tracked opening never shows
 * a bare percentage.
 */

function detail(overrides: Partial<OpeningDetail> = {}): OpeningDetail {
  return {
    openingId: 'opening-1',
    sealedProductId: 'product-1',
    sourceLotId: 'lot-1',
    productName: 'Prismatic Evolutions ETB',
    openedOn: '2026-08-01',
    quantityOpened: 1,
    costKnown: true,
    costNokMinor: 75385n,
    trackingCompleteness: 'all_cards',
    bulkRemainderEstimateMinor: null,
    bulkRemainderCount: null,
    pulls: [],
    resultNokMinor: null,
    ...overrides,
  }
}

describe('opening cost copy (prompt §14 / P53 §7)', () => {
  it('a known lot derives the EXACT preview incl. the exhaustion residual', () => {
    // The canonical 29995-øre lot (unit basis 9998 ×3 + residual 1): opening 2 of 3 must
    // preview 19996 — pure units, no residual yet.
    const partialPreview = openingCostPreview(
      {
        costKnown: true,
        quantityAvailable: 3,
        effectiveUnitBasisNokMinor: 9998n,
        exhaustionResidualNokMinor: 1n,
      },
      2,
    )
    expect(partialPreview).toEqual({ kind: 'known', minorUnits: 19996n })
    // …and the exhausting final unit previews 9999 — exactly what the backend will freeze.
    const exhaustingPreview = openingCostPreview(
      {
        costKnown: true,
        quantityAvailable: 3,
        effectiveUnitBasisNokMinor: 9998n,
        exhaustionResidualNokMinor: 1n,
      },
      3,
    )
    expect(exhaustingPreview).toEqual({ kind: 'known', minorUnits: 29995n })
    // nb-NO grouping uses a (narrow) non-breaking space — matched loosely on purpose.
    expect(`${OPENING_COST_LABEL}: ${formatNok(119800n)} kr`).toMatch(
      new RegExp('^Opening cost: 1[\\s\\u00a0\\u202f]198,00 kr$'),
    )
  })

  it('an unknown lot renders "not recorded" — NEVER 0', () => {
    const preview = openingCostPreview(
      {
        costKnown: false,
        quantityAvailable: 2,
        effectiveUnitBasisNokMinor: null,
        exhaustionResidualNokMinor: null,
      },
      2,
    )
    expect(preview).toEqual({ kind: 'unknown' })
    expect(PURCHASE_COST_NOT_RECORDED.toLowerCase()).toContain('not recorded')
    expect(PURCHASE_COST_NOT_RECORDED).not.toContain('0')
  })

  it('the pulled-card note never claims a cost or an ROI', () => {
    expect(PULL_COST_NOTE).toBe('No individual purchase cost — cost belongs to the opening.')
    expect(PULL_COST_NOTE.toLowerCase()).not.toContain('roi')
    expect(PULL_COST_NOTE).not.toContain('0 kr')
    expect(PULL_COST_NOTE.toLowerCase()).not.toContain('cost basis')
  })
})

describe('opening result rendering (FINANCIAL_MODEL §5.3 / prompt §17)', () => {
  it('kroner first, percentage second, when complete and cost is known', () => {
    const copy = resultCopy(detail({ resultNokMinor: -25385n, costNokMinor: 75385n }))
    expect(copy?.headline).toBe('−253,85 kr')
    expect(copy?.percentage).toMatch(/^−33/)
    expect(copy?.incompleteMarker).toBeNull()
  })

  it('an unknown cost renders "—" with no percentage and no fabricated number', () => {
    const copy = resultCopy(detail({ costKnown: false, costNokMinor: null, resultNokMinor: null }))
    expect(copy?.headline).toBe('—')
    expect(copy?.percentage).toBeNull()
  })

  it('incomplete tracking keeps the kroner figure but adds the fixed marker and NO percentage', () => {
    const copy = resultCopy(
      detail({ resultNokMinor: 15100n, trackingCompleteness: 'selected_pulls' }),
    )
    expect(copy?.headline).toBe('+151,00 kr')
    expect(copy?.percentage).toBeNull()
    expect(copy?.incompleteMarker).toBe(INCOMPLETE_TRACKING_MARKER)
    // The exact §5.3 wording:
    expect(INCOMPLETE_TRACKING_MARKER).toBe('Tracked pulls only — actual return is higher.')
  })

  it('"Not sure" completeness is marked exactly like selected_pulls', () => {
    const copy = resultCopy(detail({ resultNokMinor: 15100n, trackingCompleteness: 'unknown' }))
    expect(copy?.incompleteMarker).toBe(INCOMPLETE_TRACKING_MARKER)
    expect(copy?.percentage).toBeNull()
  })

  it('a result field the backend cannot provide yet hides its row entirely', () => {
    expect(resultCopy(detail({ resultNokMinor: undefined }))).toBeNull()
  })
})

describe('completeness question (prompt §12)', () => {
  it('offers all three natural options with restrained notes', () => {
    expect(COMPLETENESS_OPTIONS.map((option) => option.label)).toEqual([
      'All cards',
      'Selected pulls only',
      'Not sure',
    ])
    for (const option of COMPLETENESS_OPTIONS) {
      expect(completenessNote(option.value)).toBe(option.note)
    }
  })

  it('the selected-pulls note is the restrained disclosure, not a warning', () => {
    expect(completenessNote('selected_pulls')).toBe(
      'Opening results will only include the cards you recorded.',
    )
  })
})

describe('sealed-inventory notice (UX_FLOWS F5)', () => {
  it('states both facts plainly', () => {
    expect(THE_SEALED_NOTICE).toBe(
      'The purchase stays in your spending history. This product leaves sealed inventory.',
    )
  })
})

describe('void copy (P53 §10 policy)', () => {
  it('states that voiding an opening never undoes its purchase', () => {
    expect(VOID_PURCHASE_NOTE).toBe(
      'The purchase itself stays in your spending history — voiding an opening does not undo it.',
    )
    expect(VOID_PURCHASE_NOTE.toLowerCase()).toContain('does not undo')
  })
})

describe('provisional / reconciled provenance copy (P59 §13 / P58 F6)', () => {
  it('the pre-reconciliation note states where the figure came from — never claims "no purchase"', () => {
    expect(PROVISIONAL_COST_NOTE).toBe(
      'Cost from the total you entered when you recorded this opening.',
    )
    // The old FALSE claim must not come back: a bought-and-open DOES cite a real purchase.
    expect(PROVISIONAL_COST_NOTE.toLowerCase()).not.toContain('not linked')
    expect(PROVISIONAL_COST_NOTE.toLowerCase()).not.toContain('entered manually')
  })

  it('the secondary line offers the link without inventing a feature', () => {
    expect(PROVISIONAL_LINK_HINT).toBe('You can link it to the matching recorded purchase later.')
  })

  it('the reconciled state names what the opening now cites', () => {
    expect(RECONCILED_STATE_LABEL).toBe('Linked to recorded purchase')
    expect(RECONCILED_STATE_LABEL.toLowerCase()).not.toContain('uuid')
  })
})

describe('reconciliation sheet copy (P59 §9–§11)', () => {
  it('explains the action in one honest sentence', () => {
    expect(RECONCILE_EXPLANATION).toBe(
      'You originally entered this amount while opening the product. Pick the recorded purchase it actually came from.',
    )
  })

  it('the empty state points at recording a purchase first — no fake link-by-receipt feature', () => {
    expect(RECONCILE_EMPTY_COPY).toBe('No matching recorded purchase is available yet.')
    expect(RECONCILE_EMPTY_HINT).toMatch(/Record the purchase first/)
  })
})

describe('manual-card failure copy (P59 §17 / P58 F10)', () => {
  it('concise, retryable, free of backend internals', () => {
    expect(MANUAL_CARD_CREATE_FAILED).toBe("Couldn't create the manual card. Try again.")
    const lowered = MANUAL_CARD_CREATE_FAILED.toLowerCase()
    for (const forbidden of ['postgrest', 'sql', 'constraint', 'schema', 'uuid', 'relation']) {
      expect(lowered).not.toContain(forbidden)
    }
  })
})

describe('unpriced retained coverage marker (P59 §16 / P58 F9)', () => {
  it('says plainly that some retained pulls have no current price', () => {
    expect(UNPRICED_RETAINED_MARKER).toBe('Some retained pulls have no current price.')
    expect(UNPRICED_RETAINED_MARKER).not.toBe('0')
  })
})

describe('pull row sold/remaining states (P59 §15 / P58 F9)', () => {
  it('a fully sold pull reads Sold — never like currently-held inventory', () => {
    expect(pullRemainingCopy(2, 0)).toBe('Sold')
  })

  it('a partially sold pull states exactly what remains', () => {
    expect(pullRemainingCopy(2, 1)).toBe('1 of 2 remaining')
    expect(pullRemainingCopy(3, 2)).toBe('2 of 3 remaining')
  })

  it('an ordinary held line carries no state suffix', () => {
    expect(pullRemainingCopy(2, 2)).toBeNull()
    expect(pullRemainingCopy(1, 1)).toBeNull()
  })

  it('an unknown remaining count renders nothing rather than guessing', () => {
    expect(pullRemainingCopy(2, undefined)).toBeNull()
    expect(pullRemainingCopy(2, null)).toBeNull()
  })
})
