/**
 * Opening-result oracle — pure, runs everywhere.
 *
 * FINANCIAL_MODEL §5.3 verbatim semantics, the F8 non-additivity construction
 * (§19), bulk-estimate NULL-vs-zero distinction (§9), unknown cost (§7) and
 * the tracking-completeness marker rule (§8).
 */
import { describe, expect, it } from 'vitest'

import {
  BULK_ESTIMATE_DISTINCTION,
  F8_DOUBLE_COUNT_CASE,
  INCOMPLETE_TRACKING_MARKER_COPY,
  TRACKING_COMPLETENESS_VALUES,
  isEstimateSupplied,
  isValidRemainderShape,
  openingReturnNokMinor,
  openingRoiPercent,
  requiresIncompletenessMarker,
  ttepNokMinor,
} from '../helpers/oracle'

describe('§5.3 opening_return — formula exactness', () => {
  it('reproduces E4: opened ETB, tracked pulls only, no estimate', () => {
    // E4: opening cost 753.85 NOK (75385 øre), pulls worth 500.00 today.
    const value = openingReturnNokMinor({
      retainedTrackedValueNokMinor: 50_000,
      netProceedsFromSoldPullsNokMinor: 0,
      bulkRemainderEstimateNokMinor: null,
      openingCostNokMinor: 75_385,
    })
    expect(value).toBe(-25_385)
    // ROI is defined here and matches the document's −33.7% shape.
    const roi = openingRoiPercent(value, 75_385)
    expect(roi).not.toBeNull()
    expect(roi as number).toBeCloseTo(-33.7, 1)
  })

  it('reproduces E5: sold pull proceeds feed the opening permanently', () => {
    const value = openingReturnNokMinor({
      retainedTrackedValueNokMinor: 50_000,
      netProceedsFromSoldPullsNokMinor: 45_000,
      bulkRemainderEstimateNokMinor: null,
      openingCostNokMinor: 79_900,
    })
    expect(value).toBe(15_100)
  })

  it('a missing bulk estimate and an explicit zero both add zero — but are distinct facts', () => {
    const common = {
      retainedTrackedValueNokMinor: 10_000,
      netProceedsFromSoldPullsNokMinor: 0,
      openingCostNokMinor: 8_000,
    }
    const notSupplied = openingReturnNokMinor({
      ...common,
      bulkRemainderEstimateNokMinor: BULK_ESTIMATE_DISTINCTION.notSupplied,
    })
    const explicitZero = openingReturnNokMinor({
      ...common,
      bulkRemainderEstimateNokMinor: BULK_ESTIMATE_DISTINCTION.explicitZero,
    })
    expect(notSupplied).toBe(explicitZero)
    expect(notSupplied).toBe(2_000)

    // The DISTINCTION lives in the supplied-ness flag, not the arithmetic:
    expect(isEstimateSupplied(BULK_ESTIMATE_DISTINCTION.notSupplied, null)).toBe(false)
    // An explicit zero estimate is a supplied pair — legal only with count > 0.
    expect(isEstimateSupplied(0, 12)).toBe(true)
    expect(isValidRemainderShape(0, 12)).toBe(true)
    expect(isValidRemainderShape(0, 0)).toBe(false) // count must be positive
    expect(isValidRemainderShape(null, 5)).toBe(false) // both-or-neither
    expect(isValidRemainderShape(-1, 5)).toBe(false) // estimates are never negative
    expect(isValidRemainderShape(BULK_ESTIMATE_DISTINCTION.notSupplied, null)).toBe(true)
  })

  it('§7 unknown cost → return AND roi are undefined, never fabricated from zero', () => {
    const value = openingReturnNokMinor({
      retainedTrackedValueNokMinor: 50_000,
      netProceedsFromSoldPullsNokMinor: 4_500,
      bulkRemainderEstimateNokMinor: null,
      openingCostNokMinor: null,
    })
    expect(value).toBeNull()
    expect(openingRoiPercent(value, null)).toBeNull()
    expect(openingRoiPercent(null, 79_900)).toBeNull()
  })
})

describe('§19 F8 — opening_return is NOT additive with TTEP', () => {
  it('in a single-opening world the two figures coincide over the same kroner', () => {
    const c = F8_DOUBLE_COUNT_CASE
    const ttep = ttepNokMinor(c.cmvNokMinor, c.nspNokMinor, c.csNokMinor)
    const openingReturn = openingReturnNokMinor({
      retainedTrackedValueNokMinor: c.retainedTrackedValueNokMinor,
      netProceedsFromSoldPullsNokMinor: c.netProceedsFromSoldPullsNokMinor,
      bulkRemainderEstimateNokMinor: c.bulkRemainderEstimateNokMinor,
      openingCostNokMinor: c.openingCostNokMinor,
    })
    expect(ttep).toBe(c.expectedTtepNokMinor)
    expect(openingReturn).toBe(c.expectedOpeningReturnNokMinor)
    expect(ttep).toBe(openingReturn)
  })

  it('adding them double-counts the purchase money exactly once too many', () => {
    const naiveSum =
      F8_DOUBLE_COUNT_CASE.expectedTtepNokMinor + F8_DOUBLE_COUNT_CASE.expectedOpeningReturnNokMinor
    // Exactly double the honest position — one full extra copy of everything,
    // including the 79900 øre of purchase money.
    expect(naiveSum).toBe(2 * F8_DOUBLE_COUNT_CASE.expectedTtepNokMinor)
    expect(naiveSum - F8_DOUBLE_COUNT_CASE.expectedTtepNokMinor).toBe(
      F8_DOUBLE_COUNT_CASE.expectedOpeningReturnNokMinor,
    )
    // Both figures carry −CS exactly once, so the sum carries it twice: that
    // second −79900 IS the double count.
    const c = F8_DOUBLE_COUNT_CASE
    expect(c.expectedTtepNokMinor).toBe(c.cmvNokMinor + c.nspNokMinor - c.csNokMinor)
    expect(c.expectedOpeningReturnNokMinor).toBe(
      c.retainedTrackedValueNokMinor + c.netProceedsFromSoldPullsNokMinor - c.openingCostNokMinor,
    )
    // And no surface may ever display that sum: the honest position is TTEP alone.
  })

  it('the sold-pull proceeds term exists in both scopes — still the same kroner', () => {
    // Selling a pull moves NSP (+4500) and the opening's proceeds term (+4500):
    // again identical money at two scopes. F8 forbids summation regardless of
    // how many terms coincide.
    const beforeSaleTtep = ttepNokMinor(50_000, 0, 79_900)
    const afterSaleTtep = ttepNokMinor(50_000, 4_500, 79_900)
    expect(afterSaleTtep - beforeSaleTtep).toBe(4_500)
  })
})

describe('§8 tracking completeness — incompleteness must be marked, never bare', () => {
  it('every non-all_cards mode requires the marker', () => {
    for (const kind of TRACKING_COMPLETENESS_VALUES) {
      if (kind === 'all_cards') {
        expect(requiresIncompletenessMarker(kind)).toBe(false)
      } else {
        expect(requiresIncompletenessMarker(kind)).toBe(true)
      }
    }
  })

  it('the mandated marker copy is pinned verbatim from FINANCIAL_MODEL §5.3', () => {
    expect(INCOMPLETE_TRACKING_MARKER_COPY).toBe('Tracked pulls only — actual return is higher.')
  })

  it('a bare ROI percentage for a partially tracked opening is a bug — the marker must accompany it', () => {
    // The contract: any rendered return/roi for selected_pulls/unknown carries
    // the marker. The figure and the flag are one unit; this pair of asserts is
    // what an implementation binding must check together.
    const incomplete = 'selected_pulls' as const
    const roi = openingRoiPercent(15_100, 79_900)
    expect(requiresIncompletenessMarker(incomplete)).toBe(true)
    expect(roi).not.toBeNull()
  })
})

describe('§9 bulk estimate isolation — an estimate is not inventory', () => {
  it('TTEP has no estimate input at all — structurally cannot absorb it', () => {
    // Portfolio scope: CMV counts tracked holdings only. A 240.00 kr guess about
    // untracked commons contributes NOTHING here; the signature of ttepNokMinor
    // has no estimate slot, which is the structural form of this rule.
    expect(ttepNokMinor(50_000, 0, 79_900)).toBe(-29_900)
  })

  it('an opening with ONLY an estimate still shows a real figure at opening scope', () => {
    expect(
      openingReturnNokMinor({
        retainedTrackedValueNokMinor: 0,
        netProceedsFromSoldPullsNokMinor: 0,
        bulkRemainderEstimateNokMinor: 24_000,
        openingCostNokMinor: 79_900,
      }),
    ).toBe(-55_900)
  })
})
