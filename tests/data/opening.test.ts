import { describe, expect, it } from 'vitest'
import {
  computeOpeningCostPreview,
  computeOpeningReturn,
  isTrackingIncomplete,
  openingRoiPercent,
} from '../../src/domain/opening'
import { fromMinorUnits } from '../../src/domain/money'

/**
 * Opening-scope analytics (FINANCIAL_MODEL.md §5.3). The worked examples §8 E4/E5 are the
 * fixtures: if a test stops matching the document, the document is what needs examining first
 * (AGENTS.md financial-semantics rule).
 */

const nok = (minorUnits: bigint) => fromMinorUnits(minorUnits, 'NOK')

describe('computeOpeningReturn — FINANCIAL_MODEL §5.3 verbatim', () => {
  it('E4 shape: retained 500.00, no sales, no remainder, cost 753.85 → −253.85', () => {
    const result = computeOpeningReturn({
      retainedTrackedValue: nok(50000n),
      netSoldProceeds: nok(0n),
      bulkRemainderEstimate: null,
      openingCost: nok(75385n),
    })
    expect(result).not.toBeNull()
    expect(result!.minorUnits).toBe(-25385n)
  })

  it('E5 shape: retained 500.00 + sold 450.00, cost 799.00 → +151.00', () => {
    const result = computeOpeningReturn({
      retainedTrackedValue: nok(50000n),
      netSoldProceeds: nok(45000n),
      bulkRemainderEstimate: null,
      openingCost: nok(79900n),
    })
    expect(result!.minorUnits).toBe(15100n)
  })

  it('bulk remainder estimate enters the return when supplied', () => {
    const result = computeOpeningReturn({
      retainedTrackedValue: nok(50000n),
      netSoldProceeds: nok(0n),
      bulkRemainderEstimate: nok(24000n),
      openingCost: nok(59900n),
    })
    expect(result!.minorUnits).toBe(14100n)
  })

  it('unknown cost renders an UNDEFINED result — never a 0-based figure (M1 at opening scope)', () => {
    const result = computeOpeningReturn({
      retainedTrackedValue: nok(50000n),
      netSoldProceeds: nok(45000n),
      bulkRemainderEstimate: null,
      openingCost: null,
    })
    expect(result).toBeNull()
  })

  it('F8 scope sanity: nothing here reads or sums TTEP inputs', () => {
    // The function accepts exactly the four §5.3 components — the type system IS the invariant.
    const components = {
      retainedTrackedValue: nok(1n),
      netSoldProceeds: nok(1n),
      bulkRemainderEstimate: null,
      openingCost: nok(1n),
    }
    expect(computeOpeningReturn(components)!.minorUnits).toBe(1n)
  })
})

describe('openingRoiPercent', () => {
  it('E4: −253.85 / 753.85 → −33.7%', () => {
    const roi = openingRoiPercent(nok(-25385n), nok(75385n))
    expect(roi).toBe(-33.7)
  })

  it('E5: +151.00 / 799.00 → +18.9%', () => {
    const roi = openingRoiPercent(nok(15100n), nok(79900n))
    expect(roi).toBe(18.9)
  })

  it('undefined when cost is unknown', () => {
    expect(openingRoiPercent(nok(15100n), null)).toBeNull()
    expect(openingRoiPercent(null, nok(79900n))).toBeNull()
  })

  it('undefined on a genuine zero-cost denominator rather than fabricating a ratio', () => {
    expect(openingRoiPercent(nok(15100n), nok(0n))).toBeNull()
  })

  it('rounds half away from zero to one decimal', () => {
    // 1/3 → 33.333..% → 33.3 ; 2/3 → 66.666..% → 66.7
    expect(openingRoiPercent(nok(1n), nok(3n))).toBe(33.3)
    expect(openingRoiPercent(nok(2n), nok(3n))).toBe(66.7)
  })
})

describe('isTrackingIncomplete — §5.3 completeness marker rule', () => {
  it('all_cards is complete; everything else forces the incompleteness marker', () => {
    expect(isTrackingIncomplete('all_cards')).toBe(false)
    expect(isTrackingIncomplete('selected_pulls')).toBe(true)
    expect(isTrackingIncomplete('unknown')).toBe(true)
  })
})

describe('computeOpeningCostPreview — the exact preview rule (P53 §7, I4/I5)', () => {
  const awkwardLot = {
    // The canonical §4.3 lot: attributable basis 29995 øre over 3 units → unit floor 9998,
    // residual +1. The server derives these; the domain only composes the preview.
    quantityAvailable: 3,
    effectiveUnitBasisNokMinor: 9998n,
    exhaustionResidualNokMinor: 1n,
  }

  it('opening 2 of 3 previews 19996 — pure units, no residual before exhaustion', () => {
    expect(computeOpeningCostPreview(awkwardLot, 2)).toBe(19996n)
  })

  it('the inverse split (1 then 2) also reconciles: 9998 then 19997 — Σ exactly 29995', () => {
    expect(computeOpeningCostPreview(awkwardLot, 1)).toBe(9998n)
    // After the first opening, 2 units remain on the same lot; the now-exhausting opening of 2
    // adds the residual once.
    expect(computeOpeningCostPreview({ ...awkwardLot, quantityAvailable: 2 }, 2)).toBe(19997n)
    expect(
      (computeOpeningCostPreview(awkwardLot, 1) ?? 0n) +
        (computeOpeningCostPreview({ ...awkwardLot, quantityAvailable: 2 }, 2) ?? 0n),
    ).toBe(29995n)
  })

  it('preview == recorded cost: the exhausting preview reproduces the whole-lot total', () => {
    expect(computeOpeningCostPreview(awkwardLot, 3)).toBe(29995n)
  })

  it('an unknown-cost source previews null — never a computed zero (I6 companion)', () => {
    expect(
      computeOpeningCostPreview(
        {
          quantityAvailable: 3,
          effectiveUnitBasisNokMinor: null,
          exhaustionResidualNokMinor: null,
        },
        2,
      ),
    ).toBeNull()
  })

  it('a genuine known-zero lot previews exactly 0 — zero is a legitimate known fact (P53 §9)', () => {
    expect(
      computeOpeningCostPreview(
        { quantityAvailable: 2, effectiveUnitBasisNokMinor: 0n, exhaustionResidualNokMinor: 0n },
        1,
      ),
    ).toBe(0n)
  })

  it('refuses non-positive or fractional quantities as programming errors', () => {
    expect(() => computeOpeningCostPreview(awkwardLot, 0)).toThrow()
    expect(() => computeOpeningCostPreview(awkwardLot, 1.5)).toThrow()
  })
})
