import { describe, expect, it } from 'vitest'

import type { RecentActivityItem } from '../../src/data/dashboard'
import { ACTIVITY_LABEL, recentActivityRoute } from '../../src/features/home/activity'

/**
 * Home's Recent Activity row contract for the M16 opening arm (P59 §5 / P58 F1): every activity
 * type the backend can emit renders a NONBLANK label and, where a detail surface exists, a
 * clickable route. Before this contract existed, an opening arrived as a blank, dead row because
 * the client type union was never extended — these cases pin that shut.
 */

function item(overrides: Partial<RecentActivityItem> = {}): RecentActivityItem {
  return {
    type: 'opening',
    primaryId: 'opening-77',
    secondaryId: null,
    occurredOn: '2026-08-25',
    amountMinor: 29995n,
    ...overrides,
  }
}

describe('Home recent-activity opening row (P58 F1 / prompt §5)', () => {
  it('the opening label is understood and nonblank', () => {
    const label = ACTIVITY_LABEL[item().type]
    expect(label).toBeDefined()
    expect(label.trim().length).toBeGreaterThan(0)
    expect(label).toBe('Opened')
  })

  it('an opening routes to its Opening Detail via primary_id', () => {
    const route = recentActivityRoute(item({ secondaryId: 'lot-1' }))
    expect(route).toEqual({
      to: '/openings/$openingId',
      params: { openingId: 'opening-77' },
    })
  })

  it('a bought-and-open shows BOTH facts: the purchase row and the opening row, both clickable', () => {
    const purchaseRow = item({
      type: 'purchase',
      primaryId: 'purchase-1',
      amountMinor: 29995n,
    })
    const openingRow = item({ primaryId: 'opening-1', amountMinor: 29995n })

    expect(ACTIVITY_LABEL[purchaseRow.type]).toBe('Recorded purchase')
    expect(ACTIVITY_LABEL[openingRow.type]).toBe('Opened')

    expect(recentActivityRoute(purchaseRow)).toEqual({
      to: '/purchases/$purchaseId',
      params: { purchaseId: 'purchase-1' },
    })
    expect(recentActivityRoute(openingRow)).toEqual({
      to: '/openings/$openingId',
      params: { openingId: 'opening-1' },
    })
  })

  it('an unknown opening cost (null amount) does not break the row contract', () => {
    const unknownCost = item({ amountMinor: null })
    expect(ACTIVITY_LABEL[unknownCost.type]).toBe('Opened')
    expect(recentActivityRoute(unknownCost)).toEqual({
      to: '/openings/$openingId',
      params: { openingId: 'opening-77' },
    })
  })

  it('every known activity type keeps a total, nonblank label map', () => {
    for (const type of ['purchase', 'sale', 'valuation', 'acquisition', 'opening'] as const) {
      expect(ACTIVITY_LABEL[type]).toBeDefined()
      expect(ACTIVITY_LABEL[type].trim().length).toBeGreaterThan(0)
    }
  })

  it('valuation/acquisition rows without a holding id stay non-clickable rather than broken', () => {
    expect(recentActivityRoute(item({ type: 'valuation', secondaryId: null }))).toBeNull()
    expect(recentActivityRoute(item({ type: 'acquisition', secondaryId: 'holding-2' }))).toEqual({
      to: '/portfolio/$holdingId',
      params: { holdingId: 'holding-2' },
    })
  })
})
