import { describe, expect, it } from 'vitest'

import {
  COMPLETENESS_OPTIONS,
  INCOMPLETE_TRACKING_MARKER,
  OPENING_COST_LABEL,
  PULL_COST_NOTE,
  PURCHASE_COST_NOT_RECORDED,
  THE_SEALED_NOTICE,
  completenessNote,
  formatNok,
  openingCostPreview,
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

describe('opening cost copy (prompt §14)', () => {
  it('a known lot derives the cost from the sealed purchase', () => {
    const preview = openingCostPreview({ costKnown: true, unitCostNokMinor: 59900n }, 2)
    expect(preview).toEqual({ kind: 'known', minorUnits: 119800n })
    // nb-NO grouping uses a (narrow) non-breaking space — matched loosely on purpose.
    expect(`${OPENING_COST_LABEL}: ${formatNok(119800n)} kr`).toMatch(
      new RegExp('^Opening cost: 1[\\s\\u00a0\\u202f]198,00 kr$'),
    )
  })

  it('an unknown lot renders "not recorded" — NEVER 0', () => {
    const preview = openingCostPreview({ costKnown: false, unitCostNokMinor: null }, 2)
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
