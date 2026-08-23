import { useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listPortfolio, getPortfolioCounts } from '../../data/portfolio'
import { getCollectionMemberCount } from '../../data/customCollections'
import { getMyProfile, updateMyProfile } from '../../data/profile'
import {
  getDashboardSummary,
  getMonthlySpend,
  getPortfolioHistory,
  getRecentActivity,
} from '../../data/dashboard'
import { ScopeSelector } from '../../ui/ScopeSelector'
import { CurrencySelector } from '../../ui/CurrencySelector'
import { MoneyDisplay, ValuePrivacyToggle } from '../../ui/MoneyDisplay'
import { formatNokMinor } from '../../ui/money-format'
import {
  DASHBOARD_RANGES,
  accessibleHistorySummary,
  computePeriodChange,
  filterHistoryWindow,
  resolveRangeWindow,
  ttepDisplayState,
  toChartSeries,
  type ChartSeriesPoint,
  type DashboardRange,
  type HistoryPoint,
  type PeriodChange,
} from '../../domain/dashboard'
import { PortfolioValueChart } from './PortfolioValueChart'
import {
  BreakdownRow,
  DataQualityRow,
  MarketMoversSection,
  MonthlySpending,
  MostValuableCards,
  RecentActivity,
  StatTile,
  SummaryLine,
} from './home-sections'

/**
 * Home: the investment-style portfolio dashboard (M12). The primary number is Current
 * Portfolio Value (D-023); Total tracked economic position (TTEP) sits nearby as the honest
 * secondary figure — never labelled "profit" (FINANCIAL_MODEL.md §9/§10).
 *
 * Headline figures come from the LATEST SNAPSHOT via one bounded summary request (UX_FLOWS.md
 * F10: no per-card computation on page load). While a recompute is queued after the user's own
 * mutation, an explicit "Updating…" badge says so instead of presenting stale cache as live
 * truth (prompt §67).
 *
 * Custom-collection scope shows correct current figures but no historical chart: membership
 * history was never recorded, and projecting current membership backwards would fabricate
 * history (DECISIONS.md D-065, prompt §45/§89).
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function HomePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [range, setRangeState] = useState<DashboardRange>('3M') // default 3M (prompt §70)
  const [scopeId, setScopeId] = useState<string | null>(null)
  const scoped = scopeId !== null

  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const hideValues = profile.data?.hideValues ?? false

  const toggleHideValues = useMutation({
    mutationFn: (next: boolean) => updateMyProfile({ hideValues: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
  })
  const setCurrency = useMutation({
    mutationFn: (currency: string) => updateMyProfile({ displayCurrency: currency }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
  })

  const summary = useQuery({ queryKey: ['dashboard-summary'], queryFn: getDashboardSummary })
  const displayCurrency = profile.data?.displayCurrency ?? 'NOK'

  // The full stored series once; range selection filters client-side in domain code, so
  // flipping ranges never refetches.
  const history = useQuery({
    queryKey: ['portfolio-history', displayCurrency],
    queryFn: () =>
      getPortfolioHistory({
        displayCurrency:
          displayCurrency === 'EUR' || displayCurrency === 'USD' ? displayCurrency : 'NOK',
      }),
    enabled: !scoped,
    staleTime: 30_000,
  })

  const monthly = useQuery({
    queryKey: ['monthly-spend', 12],
    queryFn: () => getMonthlySpend(12),
    enabled: !scoped,
  })
  const activity = useQuery({
    queryKey: ['recent-activity', 8],
    queryFn: () => getRecentActivity(8),
    enabled: !scoped,
  })

  const scopeCount = useQuery({
    queryKey: ['collection-member-count', scopeId],
    queryFn: () => getCollectionMemberCount(scopeId as string),
    enabled: scoped,
  })
  const topCards = useQuery({
    queryKey: ['portfolio-top-value', scopeId],
    queryFn: () =>
      listPortfolio({
        sort: 'value_desc',
        limit: 4,
        filters: scoped ? { customCollectionId: scopeId } : undefined,
      }),
  })

  const setRange = (next: DashboardRange) => {
    setRangeState(next)
    void navigate({ to: '/', search: { range: next }, replace: true })
  }

  const allPoints: HistoryPoint[] = useMemo(
    () =>
      (history.data ?? []).map((p) => ({
        snapshotDate: p.snapshotDate,
        marketValueMinor: p.marketValueMinor,
        hasCoverage: p.hasCoverage,
      })),
    [history.data],
  )

  const windowPoints = useMemo(() => {
    if (allPoints.length === 0) return []
    const firstTracked = summary.data?.firstTrackedDate ?? allPoints[0]?.snapshotDate ?? null
    const win = resolveRangeWindow(range, firstTracked, todayIso())
    return filterHistoryWindow(allPoints, win.from, win.to)
  }, [allPoints, range, summary.data?.firstTrackedDate])

  const coveredCount = windowPoints.filter(
    (p) => p.hasCoverage && p.marketValueMinor !== null,
  ).length
  const chartReady = coveredCount >= 2
  const series: ChartSeriesPoint[] = useMemo(() => toChartSeries(windowPoints), [windowPoints])
  const change: PeriodChange = useMemo(
    () => computePeriodChange(windowPoints, range),
    [windowPoints, range],
  )

  const s = summary.data
  const emptyAccount =
    s !== undefined && s.uniqueHoldingCount === 0 && s.gpoMinor === 0n && s.pudMinor === 0n

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <div className="md:hidden">
        <span className="text-lg font-semibold tracking-tight text-slate-100">PokePortfolio</span>
      </div>

      {/* ── Headline ─────────────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <ScopeSelector value={scopeId} onChange={setScopeId} />
          <div className="flex items-center gap-1">
            <CurrencySelector
              value={profile.data?.displayCurrency ?? 'NOK'}
              onChange={(currency) => {
                setCurrency.mutate(currency)
              }}
            />
            <ValuePrivacyToggle
              hidden={hideValues}
              onToggle={() => {
                toggleHideValues.mutate(!hideValues)
              }}
            />
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <MoneyDisplay
              state={
                scoped || !s || s.marketValueMinor === null || !s.marketValueHasCoverage
                  ? 'missing'
                  : 'known'
              }
              minorUnits={s?.marketValueMinor ?? undefined}
              size="lg"
              hidden={hideValues}
              displayCurrency={displayCurrency}
            />
            {!scoped && s?.pendingRecompute ? (
              <span
                className="rounded-full border border-sky-800/60 bg-sky-950/40 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
                title="Your latest changes are being reflected — figures refresh automatically."
              >
                Updating…
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">Current Portfolio Value</p>
          {!scoped && s?.latestSnapshotDate && !s.pendingRecompute ? (
            <p className="text-[11px] text-slate-600">as of {s.latestSnapshotDate}</p>
          ) : null}
          {scoped ? <ScopeCurrentValue scopeId={scopeId} hidden={hideValues} /> : null}
        </div>

        {!scoped ? (
          <PeriodChangeLine change={change} coveredCount={coveredCount} hidden={hideValues} />
        ) : null}

        {/* ── Chart / honest placeholders ──────────────────────────────────────────────── */}
        <div className="space-y-3 border-t border-slate-800 pt-4">
          {scoped ? (
            <p className="rounded-xl border border-dashed border-slate-800 p-4 text-sm text-slate-500">
              Historical collection membership is not tracked yet — this chart follows your Main
              Portfolio only. Current figures for this collection are shown above.
            </p>
          ) : chartReady ? (
            <PortfolioValueChart points={series} hidden={hideValues} />
          ) : s && s.firstTrackedDate ? (
            <div className="flex h-48 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-800 px-4 text-center sm:h-56">
              <span className="text-sm font-medium text-slate-200">No price history yet</span>
              <span className="text-xs text-slate-500">
                Your value tracking begins {s.firstTrackedDate}. A trend appears once a second
                valued day exists.
              </span>
            </div>
          ) : (
            <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-slate-800 px-4 text-center text-xs text-slate-500 sm:h-56">
              History starts with your first tracked card or purchase.
            </div>
          )}

          {!scoped ? (
            <div className="flex justify-between" role="group" aria-label="Chart period">
              {DASHBOARD_RANGES.map((period) => (
                <button
                  key={period}
                  type="button"
                  onClick={() => {
                    setRange(period)
                  }}
                  aria-pressed={range === period}
                  className={`min-h-9 min-w-11 rounded-lg px-2 text-[11px] font-medium tabular-nums transition-colors ${
                    range === period
                      ? 'bg-sky-600/20 text-sky-400 ring-1 ring-inset ring-sky-800'
                      : 'text-slate-600 hover:bg-slate-800 hover:text-slate-300'
                  }`}
                >
                  {period}
                </button>
              ))}
            </div>
          ) : null}
          {chartReady && !scoped ? (
            <ul className="sr-only" aria-label="Portfolio value by date">
              {accessibleHistorySummary(windowPoints, hideValues).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {chartReady && !scoped ? (
            <p className="text-[11px] leading-snug text-slate-600">
              Older market-value history uses weekly retained market observations.
            </p>
          ) : null}
        </div>

        {/* Total tracked economic position — secondary, honestly labelled (prompt §124).
            ttepMinor is NULL until the first snapshot exists: render the missing state ("—"),
            never a fabricated 0 kr (ttepDisplayState / DESIGN_SYSTEM.md §7). */}
        {!scoped && s ? (
          <div className="flex items-start justify-between gap-4 border-t border-slate-800 pt-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold tabular-nums text-slate-100">
                {(() => {
                  const ttep = ttepDisplayState(s.ttepMinor, hideValues)
                  if (ttep.kind === 'missing') {
                    return (
                      <span aria-label="Not computed yet" className="text-slate-500">
                        —
                      </span>
                    )
                  }
                  if (ttep.kind === 'hidden') {
                    return <span aria-label="Value hidden">•••• kr</span>
                  }
                  return <>{formatNokMinor(ttep.minorUnits)} kr</>
                })()}
              </p>
              <p className="text-xs text-slate-500">Total tracked economic position</p>
            </div>
            <p className="max-w-[60%] text-right text-[11px] leading-snug text-slate-600">
              Market value plus net sales proceeds minus collectible spend — a position, not a
              profit.
            </p>
          </div>
        ) : null}

        {/* Data quality directly beneath the headline (UX_FLOWS F10, prompt §80). */}
        {!scoped && s ? (
          <DataQualityRow
            priced={s.pricedHoldingCount}
            unpriced={s.unpricedHoldingCount}
            manualValued={s.manualValuedHoldingCount}
            autoPriced={s.autoPricedHoldingCount}
            uncostedLots={s.uncostedOpenLotCount}
          />
        ) : null}
      </section>

      {/* ── Empty account: one clear CTA, not six zeroed cards (prompt §130 / UX_FLOWS F10) ── */}
      {emptyAccount ? (
        <section className="space-y-3 rounded-2xl border border-dashed border-slate-700 p-6 text-center">
          <h2 className="text-base font-semibold text-slate-100">Start your Portfolio</h2>
          <p className="text-sm text-slate-400">
            Add a card or record a purchase — spending, valuation and history build from there.
          </p>
          <Link
            to="/catalog"
            className="inline-block min-h-11 rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-sky-500"
          >
            Search cards
          </Link>
        </section>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3">
            {scoped ? (
              <StatTile label="Cards in this collection" value={scopeCount.data} wide />
            ) : s ? (
              <>
                <StatTile label="Physical cards" value={s.physicalCardCount} />
                <StatTile label="Unique holdings" value={s.uniqueHoldingCount} />
                <StatTile label="Graded" value={s.gradedHoldingCount} />
                <StatTile label="Sealed units" value={s.sealedUnitCount} />
              </>
            ) : null}
          </section>

          {/* Value breakdown — raw + graded + sealed always sum to CMV (prompt §82/§127). */}
          {!scoped &&
          s &&
          (s.rawValueMinor !== 0n || s.gradedValueMinor !== 0n || s.sealedValueMinor !== 0n) ? (
            <section className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              <h2 className="text-sm font-semibold text-slate-300">Value breakdown</h2>
              <BreakdownRow label="Raw cards" minor={s.rawValueMinor} hidden={hideValues} />
              <BreakdownRow label="Graded" minor={s.gradedValueMinor} hidden={hideValues} />
              <BreakdownRow label="Sealed" minor={s.sealedValueMinor} hidden={hideValues} />
            </section>
          ) : null}

          {!scoped && s ? (
            <section className="space-y-1.5 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              <h2 className="pb-1 text-sm font-semibold text-slate-300">Spending &amp; results</h2>
              <SummaryLine
                label="Total spent"
                minor={s.gpoMinor}
                hidden={hideValues}
                to={{ to: '/purchases' }}
              />
              <SummaryLine label="Collectible spend" minor={s.csMinor} hidden={hideValues} muted />
              <SummaryLine
                label="Net sales proceeds"
                minor={s.nspMinor}
                hidden={hideValues}
                to={{ to: '/history', search: { tab: 'sold' } }}
              />
              <SummaryLine
                label="Realized result on costed sales"
                minor={s.rrcMinor}
                hidden={hideValues}
                muted
              />
              {s.pudMinor !== 0n ? (
                <SummaryLine
                  label="Proceeds, items without recorded cost"
                  minor={s.pudMinor}
                  hidden={hideValues}
                  muted
                />
              ) : null}
              <SummaryLine
                label="Net invested in collectibles"
                minor={s.nccoMinor}
                hidden={hideValues}
                muted
              />
              <SummaryLine
                label="Net cost of the hobby"
                minor={s.thcoMinor}
                hidden={hideValues}
                muted
              />
            </section>
          ) : null}

          {!scoped && monthly.data && monthly.data.length > 0 ? (
            <MonthlySpending months={monthly.data} hidden={hideValues} />
          ) : null}

          {!scoped && activity.data && activity.data.length > 0 ? (
            <RecentActivity items={activity.data} hidden={hideValues} />
          ) : null}
        </>
      )}

      <MostValuableCards
        topCards={topCards.data?.results ?? []}
        pending={topCards.isPending}
        hideValues={hideValues}
      />

      <MarketMoversSection />

      <section className="flex gap-3">
        <Link
          to="/catalog"
          className="min-h-11 flex-1 rounded-xl border border-slate-700 px-4 py-2 text-center text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Search cards
        </Link>
        <Link
          to="/portfolio"
          className="min-h-11 flex-1 rounded-xl bg-sky-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-sky-500"
        >
          Open Portfolio
        </Link>
      </section>
    </div>
  )
}

/** Scoped custom-collection view: correct CURRENT figures only — no invented history (D-065). */
function ScopeCurrentValue({ scopeId, hidden }: { scopeId: string; hidden: boolean }) {
  const counts = useQuery({
    queryKey: ['portfolio-counts', scopeId],
    queryFn: () => getPortfolioCounts(scopeId),
  })
  if (!counts.data) return null
  if (counts.data.portfolioValueMinor === 0n && counts.data.pricedHoldingCount === 0) return null
  return (
    <p className="text-xs text-slate-500">
      {hidden ? (
        <span aria-label="Value hidden">Current value ••••</span>
      ) : (
        <>Current value {formatNokMinor(counts.data.portfolioValueMinor)} kr</>
      )}
    </p>
  )
}

function PeriodChangeLine({
  change,
  coveredCount,
  hidden,
}: {
  change: PeriodChange
  coveredCount: number
  hidden: boolean
}) {
  if (coveredCount < 2 || change.amountMinor === null) {
    return <p className="text-xs text-slate-500">— not enough history for a period comparison</p>
  }
  const amountText = `${change.amountMinor >= 0n ? '+' : ''}${formatNokMinor(change.amountMinor)} kr`
  return (
    <p className="text-sm font-medium">
      {hidden ? (
        <span aria-label="Change hidden" className="tabular-nums text-slate-500">
          ••••
        </span>
      ) : (
        <span
          className={`tabular-nums ${
            change.amountMinor >= 0n ? 'text-emerald-400' : 'text-rose-400'
          }`}
        >
          {amountText}
          {change.pct !== null
            ? ` (${change.pct >= 0 ? '+' : ''}${change.pct.toFixed(1)}%)`
            : ' (—%)'}
          <span className="ml-2 text-xs font-normal text-slate-600">selected period</span>
        </span>
      )}
    </p>
  )
}
