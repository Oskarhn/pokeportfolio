import { describe, expect, it } from 'vitest'
import {
  accessibleHistorySummary,
  computePeriodChange,
  filterHistoryWindow,
  isDashboardRange,
  resolveRangeWindow,
  safeMajorUnits,
  toChartSeries,
  type HistoryPoint,
} from '../../src/domain/dashboard'

/**
 * Pure-domain coverage for the M12 dashboard helpers (prompt §121): period-change semantics
 * including the zero-base and insufficient-history cases, window resolution against a real
 * tracking origin, gap-preserving chart-series construction (whitespace, never fabricated
 * connections), the exact display-boundary number conversion, and privacy-masked accessibility
 * summaries. No pixel snapshots, no library internals.
 */

const TODAY = '2026-08-30'

function point(date: string, valueMinor: bigint | null, hasCoverage = true): HistoryPoint {
  return { snapshotDate: date, marketValueMinor: valueMinor, hasCoverage }
}

describe('isDashboardRange', () => {
  it('accepts exactly the seven shipped ranges', () => {
    expect(isDashboardRange('3M')).toBe(true)
    expect(isDashboardRange('MAX')).toBe(true)
    expect(isDashboardRange('2M')).toBe(false)
    expect(isDashboardRange(null)).toBe(false)
    expect(isDashboardRange(undefined)).toBe(false)
  })
})

describe('resolveRangeWindow', () => {
  const first = '2026-05-01'

  it('clamps a range reaching before tracking began to the first tracked date', () => {
    const win = resolveRangeWindow('1Y', first, TODAY)
    expect(win.from).toBe(first)
    expect(win.to).toBe(TODAY)
  })

  it('uses the plain day offset when history covers the whole range', () => {
    const lateOrigin = '2025-06-01'
    const win = resolveRangeWindow('3M', lateOrigin, TODAY)
    expect(win.from).toBe('2026-06-01') // 90 days before TODAY
    expect(win.to).toBe(TODAY)
  })

  it('MAX stays bounded by the server-side four-year cap, never earlier than the origin', () => {
    expect(resolveRangeWindow('MAX', first, TODAY).from).toBe(first)
    expect(resolveRangeWindow('MAX', '2019-01-01', TODAY).from).toBe('2022-08-31')
  })

  it('answers "no origin" with an open start so callers can render the empty state', () => {
    expect(resolveRangeWindow('1M', null, TODAY).from).toBeNull()
  })
})

describe('filterHistoryWindow', () => {
  it('keeps only points inside [from, to]', () => {
    const rows = [point('2026-01-01', 1n), point('2026-02-01', 2n), point('2026-03-01', 3n)]
    expect(
      filterHistoryWindow(rows, '2026-02-01', '2026-03-01').map((p) => p.snapshotDate),
    ).toEqual(['2026-02-01', '2026-03-01'])
    expect(filterHistoryWindow(rows, null, '2026-02-01')).toHaveLength(2)
  })
})

describe('computePeriodChange', () => {
  it('compares latest vs the last covered point at/before the target boundary', () => {
    // 3M ≈ 90 days: baseline target = latest(08-30) − 90d = 06-01.
    const rows = [
      point('2026-04-15', 100_000n),
      point('2026-05-20', 110_000n), // last point ≤ 06-01
      point('2026-07-10', 120_000n),
      point('2026-08-30', 132_000n),
    ]
    const change = computePeriodChange(rows, '3M')
    expect(change.baselineDate).toBe('2026-05-20')
    expect(change.amountMinor).toBe(22_000n)
    expect(change.pct).toBeCloseTo(20, 6)
  })

  it('falls back to the earliest point when history starts inside the selected window', () => {
    const rows = [
      point('2026-08-20', 50_000n),
      point('2026-08-25', 55_000n),
      point('2026-08-30', 60_000n),
    ]
    const change = computePeriodChange(rows, '1Y')
    expect(change.baselineDate).toBe('2026-08-20')
    expect(change.amountMinor).toBe(10_000n)
  })

  it('never divides by zero: a zero base makes the percentage undefined (prompt §72)', () => {
    const rows = [point('2026-08-01', 0n), point('2026-08-30', 500n)]
    const change = computePeriodChange(rows, '1M')
    expect(change.amountMinor).toBe(500n)
    expect(change.pct).toBeNull()
  })

  it('returns nothing when fewer than two covered points exist (§71)', () => {
    expect(computePeriodChange([], '3M')).toEqual({
      amountMinor: null,
      pct: null,
      baselineDate: null,
    })
    expect(computePeriodChange([point('2026-08-30', 100n)], '3M')).toEqual({
      amountMinor: null,
      pct: null,
      baselineDate: null,
    })
  })

  it('ignores uncovered days when choosing comparison points (§33/§74)', () => {
    const rows = [
      point('2026-06-01', null, false), // zero-coverage gap
      point('2026-08-29', 80_000n),
      point('2026-08-30', 88_000n),
    ]
    const change = computePeriodChange(rows, '3M')
    expect(change.baselineDate).toBe('2026-08-29') // the gap never becomes a fake baseline
    expect(change.amountMinor).toBe(8_000n)
  })

  it('handles a negative change honestly', () => {
    const rows = [point('2026-08-20', 200_000n), point('2026-08-30', 150_000n)]
    const change = computePeriodChange(rows, '1M')
    expect(change.amountMinor).toBe(-50_000n)
    expect(change.pct).toBeCloseTo(-25, 6)
  })
})

describe('toChartSeries', () => {
  it('converts exact minor units to major-unit numbers at the final boundary', () => {
    const series = toChartSeries([point('2026-08-01', 123_456n), point('2026-08-02', 234_567n)])
    expect(series[0]).toEqual({ time: '2026-08-01', value: 1234.56 })
    expect(series[1]?.value).toBeCloseTo(2345.67, 9)
  })

  it('renders uncovered days as whitespace gaps once tracking started (§74)', () => {
    const series = toChartSeries([
      point('2026-08-01', 100n),
      point('2026-08-02', null, false), // interior gap — line breaks here
      point('2026-08-03', 300n),
    ])
    expect(series[1]).toEqual({ time: '2026-08-02' }) // whitespace item, no value
    expect(series).toHaveLength(3)
  })

  it('drops leading uncovered days entirely — the chart begins at the first real valuation', () => {
    const series = toChartSeries([
      point('2026-07-01', null, false),
      point('2026-07-02', null, false),
      point('2026-07-03', 500n),
    ])
    expect(series.map((s) => s.time)).toEqual(['2026-07-03'])
  })

  it('refuses values beyond the exact-representation boundary instead of losing øre (§78)', () => {
    expect(() => safeMajorUnits(9007199254740993n)).toThrow(/safe integer/)
    expect(safeMajorUnits(9007199254740991n)).toBe(90071992547409.91)
  })
})

describe('accessibleHistorySummary', () => {
  it('lists dated values for screen readers and masks every one while hidden (§75/§106)', () => {
    const rows = [
      point('2026-08-01', 100_00n),
      point('2026-08-02', null, false),
      point('2026-08-03', 250_00n),
    ]
    expect(accessibleHistorySummary(rows, false)).toEqual([
      '2026-08-01: 100.00 kr',
      '2026-08-03: 250.00 kr',
    ])
    expect(accessibleHistorySummary(rows, true)).toEqual(['2026-08-01: ••••', '2026-08-03: ••••'])
  })
})
