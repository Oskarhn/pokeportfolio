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

export interface SpendBarGeometry {
  /** Bar height as a percentage of the tallest month, 0–100. */
  totalPct: number
  /** Collectible share of THIS month's bar, 0–100 (the hobby remainder stacks beneath). */
  collectiblePct: number
  /** True when the month has any spend at all (drives a minimal visible sliver). */
  hasSpend: boolean
}

/** Bar geometry for the monthly-spend view. The only place monetary values become display
 *  ratios — components render these numbers and never compute from money themselves
 *  (AGENTS.md: no monetary arithmetic outside src/domain). */
export function monthlySpendBars(
  months: {
    collectibleMinor: bigint
    totalMinor: bigint
  }[],
): SpendBarGeometry[] {
  const max = months.reduce((acc, m) => (m.totalMinor > acc ? m.totalMinor : acc), 0n)
  return months.map((m) => ({
    totalPct: max === 0n ? 0 : Number((m.totalMinor * 100n) / max),
    collectiblePct: m.totalMinor === 0n ? 0 : Number((m.collectibleMinor * 100n) / m.totalMinor),
    hasSpend: m.totalMinor > 0n,
  }))
}

/** The active chart range for a session (M12a owner feedback §5): the URL's own value when it
 *  names one of the seven shipped ranges, otherwise the shipped default. The URL is the single
 *  source of truth — no duplicate useState to drift from it — so a selected range survives a
 *  reload or an arriving deep link instead of silently snapping back to 3M. */
export function resolveActiveRange(value: unknown): DashboardRange {
  return isDashboardRange(value) ? value : '3M'
}

export type HistoryPanelState = 'ready' | 'insufficient-history' | 'no-history'

/** Which honest panel the chart area renders for the selected window: a trend needs at least two
 *  covered days. One real point is a beginning, not a failure — and never stretched into a line
 *  (D-008). Zero points is simply "not started yet". */
export function historyPanelState(windowPoints: HistoryPoint[]): HistoryPanelState {
  const covered = windowPoints.filter((p) => p.hasCoverage && p.marketValueMinor !== null).length
  if (covered >= 2) return 'ready'
  return covered === 1 ? 'insufficient-history' : 'no-history'
}

export type HoldingValueDisplayState =
  { kind: 'missing' } | { kind: 'hidden' } | { kind: 'known'; minorUnits: bigint }

/** Rendering state for a per-holding value (M12a owner feedback §D: Most Valuable cards must show
 *  each card's resolved value). NULL means UNAVAILABLE — render "—", never a fabricated 0 kr; a
 *  genuine zero is a real answer and stays visible as 0; hide_values masks any PRESENT value.
 *  Same missing-vs-zero discipline as ttepDisplayState / MoneyDisplay. */
export function holdingValueDisplayState(
  holdingValueMinor: bigint | null | undefined,
  hidden: boolean,
): HoldingValueDisplayState {
  if (holdingValueMinor === null || holdingValueMinor === undefined) {
    return { kind: 'missing' }
  }
  if (hidden) {
    return { kind: 'hidden' }
  }
  return { kind: 'known', minorUnits: holdingValueMinor }
}

export type RefreshPollDecision = number | false

/**
 * How often Home may refetch `dashboard-summary` while a recompute is queued (P42). Polling
 * exists ONLY for the pending window: an ordinary owner mutation enqueues a snapshot recompute,
 * the cron worker settles it, and until it settles every fetch honestly reports
 * `pending_recompute = true`. Without a poll the badge and figures sit on whatever the last
 * fetch returned — indefinitely, if the user just watches the screen (the exact owner-reported
 * failure). Once pending is false the interval drops to false permanently — no idle polling.
 *
 * 3 s sits inside the reviewed 2-5 s band: fast enough that a settled recompute appears within
 * one tick of the worker finishing (~1 min cadence), slow enough that the whole pending window
 * costs a handful of bounded RPC calls, not a request loop.
 */
export const DASHBOARD_PENDING_POLL_MS = 3000

/** Pure decision for TanStack Query's `refetchInterval` callback. */
export function dashboardSummaryRefetchInterval(
  pendingRecompute: boolean | undefined,
): RefreshPollDecision {
  return pendingRecompute ? DASHBOARD_PENDING_POLL_MS : false
}

/** True when the pending flag has just flipped from queued to drained across two observed
 *  states. This transition is what must trigger the remaining snapshot-derived queries to
 *  refresh — a disappearing badge above a still-stale chart is exactly the bug this guards
 *  against. Undefined counts as "not pending" so first observations never fire it. */
export function recomputeJustSettled(
  previouslyPending: boolean | undefined,
  currentlyPending: boolean | undefined,
): boolean {
  return previouslyPending === true && currentlyPending === false
}

export type TtepDisplayState =
  { kind: 'missing' } | { kind: 'hidden' } | { kind: 'known'; minorUnits: bigint }

/** Rendering state for a SNAPSHOT-sourced Total tracked economic position (prompt §124): the
 *  summary RPC returns ttep = NULL whenever no portfolio snapshot exists yet. NULL means
 *  UNAVAILABLE: render "—", never a fabricated "0 kr" (DESIGN_SYSTEM.md §7 / CLAUDE.md honesty
 *  bar). A genuine zero is a real answer and stays visible as 0; hide_values masks any PRESENT
 *  value. Historical/snapshot uses keep this mapping; Home's CURRENT figure now goes through
 *  liveTtepDisplayState below (D-086). */
export function ttepDisplayState(
  ttepMinor: bigint | null | undefined,
  hidden: boolean,
): TtepDisplayState {
  if (ttepMinor === null || ttepMinor === undefined) {
    return { kind: 'missing' }
  }
  if (hidden) {
    return { kind: 'hidden' }
  }
  return { kind: 'known', minorUnits: ttepMinor }
}

/* ── P48: CURRENT figures are LIVE, HISTORICAL figures are snapshots (D-086) ──────────────── */

/** The exact summary fields the live current-value derivation needs — all already returned by
 *  one bounded `get_dashboard_summary()` call, so no second request, no per-card computation,
 *  no N+1 resolver exists anywhere on this path. */
export interface LivePortfolioValueInput {
  /** Distinct holdings currently open (unique_holding_count). */
  uniqueHoldingCount: number
  /** Of those, how many carry at least one resolvable current value (priced_holding_count).
   *  raw/graded/sealed sums already exclude unpriced holdings by construction. */
  pricedHoldingCount: number
  /** Lifetime ledger markers used only to distinguish a never-used account from an account
   *  that legitimately owns nothing anymore (everything sold). */
  gpoMinor: bigint
  pudMinor: bigint
  rawValueMinor: bigint
  gradedValueMinor: bigint
  sealedValueMinor: bigint
}

export type LivePortfolioValueState =
  { kind: 'no-data' } | { kind: 'missing' } | { kind: 'known'; minorUnits: bigint }

/**
 * Current Portfolio Value from LIVE state (D-086): raw + graded + sealed as resolved for the
 * user's open holdings right now — never the latest snapshot's cached CMV, which may lag until
 * the history worker drains.
 *
 * Missing-vs-zero discipline (the project honesty bar):
 * - A brand-new account (nothing owned, nothing ever spent or received) is `no-data` — the UI
 *   keeps its existing empty-state contract, rendering "—" plus the start CTA.
 * - Owned holdings with NONE priced are `missing` ("—"), NEVER 0 kr — absent pricing must not
 *   masquerade as a valuation.
 * - An account that genuinely owns nothing anymore (sold out of everything) has a REAL zero:
 *   `known` with 0n.
 * - Mixed coverage shows the sum of resolvable values; unpriced holdings stay surfaced through
 *   the existing data-quality row, never silently converted to zero.
 */
export function livePortfolioValue(input: LivePortfolioValueInput): LivePortfolioValueState {
  if (input.uniqueHoldingCount === 0 && input.gpoMinor === 0n && input.pudMinor === 0n) {
    return { kind: 'no-data' }
  }
  if (input.pricedHoldingCount === 0) {
    return input.uniqueHoldingCount === 0 ? { kind: 'known', minorUnits: 0n } : { kind: 'missing' }
  }
  return {
    kind: 'known',
    minorUnits: input.rawValueMinor + input.gradedValueMinor + input.sealedValueMinor,
  }
}

export interface LiveTtepInput extends LivePortfolioValueInput {
  /** Live net sales proceeds and collectible spend — canonical ledger sums, already current. */
  nspMinor: bigint
  csMinor: bigint
}

/**
 * Current TTEP (D-086): CMV + NSP − CS with every term LIVE. The formula is unchanged
 * (FINANCIAL_MODEL.md §2.6); what changed is that the CURRENT headline no longer waits for a
 * snapshot row to exist. Where current CMV has zero pricing coverage the composite is honestly
 * missing — coalescing it to 0 would fabricate a position out of nothing (§6.5's rule, applied
 * to live coverage instead of snapshot existence). Snapshot-sourced historical TTEP semantics
 * are untouched.
 */
export function liveTtepDisplayState(input: LiveTtepInput, hidden: boolean): TtepDisplayState {
  const cmv = livePortfolioValue(input)
  if (cmv.kind !== 'known') {
    return ttepDisplayState(null, hidden)
  }
  return ttepDisplayState(cmv.minorUnits + input.nspMinor - input.csMinor, hidden)
}

/** Copy for the pending status shown while a snapshot recompute is queued (P48). It names what
 *  is actually waiting — HISTORY — because the current value beside it is already live. It must
 *  never imply that Current Portfolio Value itself is stale, and it never shows fake progress. */
export const PENDING_HISTORY_LABEL = 'Updating history…'

/** Whether Home shows the history-updating status (P48): only while a recompute is genuinely
 *  queued. Undefined (summary not loaded yet) counts as not pending — no status before any
 *  state is known. */
export function historyStatusVisible(pendingRecompute: boolean | undefined): boolean {
  return pendingRecompute === true
}
