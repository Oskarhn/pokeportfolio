/**
 * M12 dashboard domain helpers (prompt Part G). Pure functions only — every monetary
 * computation the Home screen performs lives here, never in a component (AGENTS.md: no
 * monetary arithmetic outside src/domain).
 *
 * Canonical storage is exact bigint NOK minor units (FINANCIAL_MODEL.md §1). The ONE place
 * values become JavaScript numbers is `toChartSeries` — the final visualization adapter
 * (prompt §78) — which refuses to represent anything above Number.MAX_SAFE_INTEGER rather
 * than silently lose øre.
 */

export const DASHBOARD_RANGES = ['1D', '1W', '1M', '3M', '6M', '1Y', 'MAX'] as const

export type DashboardRange = (typeof DASHBOARD_RANGES)[number]

export function isDashboardRange(value: unknown): value is DashboardRange {
  return typeof value === 'string' && (DASHBOARD_RANGES as readonly string[]).includes(value)
}

/** Approximate window length in days for each range. Daily-resolution data makes these
 *  approximations honest — 1D compares across available daily points, never intraday ticks
 *  (prompt §49); calendar-exact month/year boundaries buy nothing over daily snapshots. */
export const RANGE_DAYS: Record<DashboardRange, number> = {
  '1D': 1,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '6M': 182,
  '1Y': 365,
  MAX: Number.POSITIVE_INFINITY,
}

export interface HistoryPoint {
  snapshotDate: string
  /** Exact NOK minor units; present only when the day's open lots had at least one resolvable
   *  value (has_coverage). Never zero to mean "no data" (F14/prompt §33). */
  marketValueMinor: bigint | null
  hasCoverage: boolean
}

export interface ChartSeriesPoint {
  time: string
  value?: number
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** Final display-boundary conversion: exact minor units → major units as a JS number.
 *  Throws on any value that cannot be represented exactly — the failure is loud by design. */
export function safeMajorUnits(minor: bigint): number {
  if (minor > MAX_SAFE || minor < -MAX_SAFE) {
    throw new Error(`chart value ${minor} exceeds safe integer range`)
  }
  return Number(minor) / 100
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The visible window for a range, given the user's real history origin (prompt §71/§73):
 *  never earlier than the first tracked date — options with little history show all the real
 *  data there is, and MAX uses the server's own bounded default (4 years). */
export function resolveRangeWindow(
  range: DashboardRange,
  firstTrackedDate: string | null,
  todayIso: string,
): { from: string | null; to: string } {
  if (!firstTrackedDate) return { from: null, to: todayIso }
  if (range === 'MAX') {
    return {
      from:
        firstTrackedDate < addDays(todayIso, -1460) ? addDays(todayIso, -1460) : firstTrackedDate,
      to: todayIso,
    }
  }
  const requestedFrom = addDays(todayIso, -RANGE_DAYS[range])
  // A range reaching before tracking began still shows everything real from the origin on.
  return { from: requestedFrom < firstTrackedDate ? firstTrackedDate : requestedFrom, to: todayIso }
}

/** Filter raw history rows down to a resolved window. */
export function filterHistoryWindow(
  points: HistoryPoint[],
  from: string | null,
  to: string,
): HistoryPoint[] {
  return points.filter((p) => p.snapshotDate <= to && (from === null || p.snapshotDate >= from))
}

export interface PeriodChange {
  amountMinor: bigint | null
  pct: number | null
  baselineDate: string | null
}

/** Selected-period change (prompt §72): the latest legitimate point versus the LAST legitimate
 *  point at or before the target boundary date. If no point exists at/before the boundary —
 *  history starts inside the selected window — the earliest available point is the baseline so
 *  the figure stays defined without inventing an earlier one. Percentage needs a non-zero base:
 *  a zero baseline makes it mathematically undefined → null, never "0%" or "∞". */
export function computePeriodChange(
  windowPoints: HistoryPoint[],
  range: DashboardRange,
): PeriodChange {
  const covered = windowPoints.filter((p) => p.hasCoverage && p.marketValueMinor !== null)
  if (covered.length === 0) {
    return { amountMinor: null, pct: null, baselineDate: null }
  }
  const latest = covered[covered.length - 1]
  if (!latest) {
    return { amountMinor: null, pct: null, baselineDate: null }
  }
  if (covered.length === 1) {
    return { amountMinor: null, pct: null, baselineDate: null }
  }

  let baseline: HistoryPoint | undefined
  if (range !== 'MAX') {
    const target = addDays(latest.snapshotDate, -RANGE_DAYS[range])
    for (let i = covered.length - 1; i >= 0; i -= 1) {
      const candidate = covered[i]
      if (candidate && candidate.snapshotDate <= target) {
        baseline = candidate
        break
      }
    }
  }
  baseline ??= covered[0]
  if (!baseline || baseline.snapshotDate === latest.snapshotDate) {
    return { amountMinor: null, pct: null, baselineDate: null }
  }

  const latestValue = latest.marketValueMinor ?? 0n
  const baselineValue = baseline.marketValueMinor ?? 0n
  return {
    amountMinor: latestValue - baselineValue,
    pct:
      baselineValue === 0n
        ? null
        : (Number(latestValue - baselineValue) / Number(baselineValue)) * 100,
    baselineDate: baseline.snapshotDate,
  }
}

/** Chart-ready series (prompt §74 gap policy): a day whose open lots were entirely unvalued
 *  becomes a whitespace point — the library breaks the line there instead of drawing a
 *  fabricated connection through missing coverage. Days before the first covered point are
 *  dropped entirely (the chart begins at the first real valuation). */
export function toChartSeries(windowPoints: HistoryPoint[]): ChartSeriesPoint[] {
  const series: ChartSeriesPoint[] = []
  let started = false
  for (const p of windowPoints) {
    if (p.hasCoverage && p.marketValueMinor !== null) {
      started = true
      series.push({ time: p.snapshotDate, value: safeMajorUnits(p.marketValueMinor) })
    } else if (started) {
      series.push({ time: p.snapshotDate })
    }
  }
  return series
}

/** Accessible fallback text for the chart (prompt §106): dated values as plain text. Hidden
 *  values render masked here too — a screen reader must not leak what the eye hides (§75). */
export function accessibleHistorySummary(windowPoints: HistoryPoint[], hidden: boolean): string[] {
  return windowPoints
    .filter((p) => p.hasCoverage && p.marketValueMinor !== null)
    .map((p) =>
      hidden
        ? `${p.snapshotDate}: ••••`
        : `${p.snapshotDate}: ${(Number(p.marketValueMinor ?? 0n) / 100).toFixed(2)} kr`,
    )
}
