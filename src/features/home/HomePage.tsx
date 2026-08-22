import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getPortfolioCounts,
  listPortfolio,
  portfolioDisplayName,
  portfolioSubtitle,
} from '../../data/portfolio'
import { getCollectionMemberCount } from '../../data/customCollections'
import { getMyProfile, updateMyProfile } from '../../data/profile'
import { getSpendingSummary } from '../../data/purchases'
import { getSalesSummary } from '../../data/sales'
import { getMarketMovers } from '../../data/pricing'
import { ScopeSelector } from '../../ui/ScopeSelector'
import { CurrencySelector } from '../../ui/CurrencySelector'
import { MoneyDisplay, ValuePrivacyToggle } from '../../ui/MoneyDisplay'
import { formatNokMinor } from '../../ui/money-format'
import { CardImage } from '../catalog/CardImage'
import { ChartIcon, TagIcon } from '../../ui/icons'

const PERIODS = ['1D', '1W', '1M', '3M', '6M', '1Y', 'MAX'] as const

/**
 * Home: the future investment-style portfolio dashboard (M7.1 prompt §15-20, owner feedback pass
 * — supersedes M7's plain stat-tile Home). Structure is built for the real thing (a scope
 * selector, a headline value with currency and privacy controls, a value-over-time chart, the
 * four most valuable owned cards) but every figure that depends on M9 (raw pricing) or M12
 * (portfolio snapshots/chart) is an honest, polished "not available yet" — never a sample chart,
 * never a fabricated total. No page-title heading: the active bottom-nav tab already says where
 * the user is (M7.1 prompt §13/§67).
 */
export function HomePage() {
  const [scopeId, setScopeId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const counts = useQuery({
    queryKey: ['portfolio-counts', scopeId],
    queryFn: () => getPortfolioCounts(scopeId ?? undefined),
  })
  const scopeCount = useQuery({
    queryKey: ['collection-member-count', scopeId],
    queryFn: () => getCollectionMemberCount(scopeId as string),
    enabled: scopeId !== null,
  })
  const topCards = useQuery({
    queryKey: ['portfolio-top-value', scopeId],
    queryFn: () =>
      listPortfolio({
        sort: 'value_desc',
        limit: 4,
        filters: scopeId ? { customCollectionId: scopeId } : undefined,
      }),
  })

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

  const valuedTopCards = (topCards.data?.results ?? []).filter(
    (tile) => tile.unitValueMinor !== null,
  )

  const spending = useQuery({ queryKey: ['spending-summary'], queryFn: getSpendingSummary })
  const salesSummary = useQuery({ queryKey: ['sales-summary'], queryFn: getSalesSummary })

  // Market Movers (prompt §54-55/§94): real price movement of owned, priced holdings over the
  // last 7 days. Never a global catalog ranking, never a sale/realized-result figure.
  const movers = useQuery({
    queryKey: ['market-movers'],
    queryFn: () => getMarketMovers(7, 5),
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <div className="md:hidden">
        <span className="text-lg font-semibold tracking-tight text-slate-100">PokePortfolio</span>
      </div>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <ScopeSelector value={scopeId} onChange={setScopeId} />
          <CurrencySelector
            value={profile.data?.displayCurrency ?? 'NOK'}
            onChange={(currency) => {
              setCurrency.mutate(currency)
            }}
          />
        </div>

        <div className="flex items-end justify-between">
          <MoneyDisplay
            state={counts.data && counts.data.pricedHoldingCount > 0 ? 'known' : 'missing'}
            minorUnits={counts.data?.portfolioValueMinor}
            size="lg"
            hidden={hideValues}
            displayCurrency={profile.data?.displayCurrency}
          />
          <ValuePrivacyToggle
            hidden={hideValues}
            onToggle={() => {
              toggleHideValues.mutate(!hideValues)
            }}
          />
        </div>
        {counts.data ? (
          <p className="text-xs text-slate-500">
            {counts.data.pricedHoldingCount} priced
            {counts.data.unpricedHoldingCount > 0
              ? ` · ${counts.data.unpricedHoldingCount} without a price`
              : ''}
          </p>
        ) : null}

        {/* Reserved for the real value-over-time chart (M12, lightweight-charts spike — D-015).
            Period controls establish the layout only; they are not interactive yet. */}
        <div className="space-y-2 border-t border-slate-800 pt-4">
          <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-slate-800 text-xs text-slate-500">
            Chart arrives once portfolio history is tracked
          </div>
          <div className="flex justify-between text-[11px] font-medium text-slate-600">
            {PERIODS.map((period) => (
              <span key={period}>{period}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3">
        {scopeId === null ? (
          <>
            <StatTile label="Physical cards" value={counts.data?.physicalCardCount} />
            <StatTile label="Unique holdings" value={counts.data?.uniqueHoldingCount} />
            <StatTile label="Graded" value={counts.data?.gradedCount} />
            <StatTile label="Manual entries" value={counts.data?.manualCount} />
          </>
        ) : (
          <StatTile label="Cards in this collection" value={scopeCount.data} wide />
        )}
      </section>

      <Link
        to="/purchases"
        className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 hover:bg-slate-800/40"
      >
        <span className="flex items-center gap-3">
          <ChartIcon className="size-5 text-slate-400" />
          <span>
            <span className="block text-sm font-medium text-slate-200">Purchases</span>
            <span className="block text-xs text-slate-500">View your receipts →</span>
          </span>
        </span>
        <span className="text-right">
          <span className="block text-sm font-semibold text-slate-100">
            {spending.data ? `${formatNokMinor(spending.data.gpoNokMinor)} kr` : '—'}
          </span>
          <span className="block text-xs text-slate-500">Total spent</span>
        </span>
      </Link>

      <Link
        to="/history"
        search={{ tab: 'sold' }}
        className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 hover:bg-slate-800/40"
      >
        <span className="flex items-center gap-3">
          <TagIcon className="size-5 text-slate-400" />
          <span>
            <span className="block text-sm font-medium text-slate-200">History</span>
            <span className="block text-xs text-slate-500">Sold, traded and more →</span>
          </span>
        </span>
        <span className="text-right">
          <span className="block text-sm font-semibold text-slate-100">
            {salesSummary.data ? `${formatNokMinor(salesSummary.data.nspNokMinor)} kr` : '—'}
          </span>
          <span className="block text-xs text-slate-500">Net sales proceeds</span>
        </span>
      </Link>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">Most valuable cards</h2>
          <Link
            to="/portfolio"
            search={{ sort: 'value_desc' }}
            className="text-xs font-medium text-sky-400 hover:underline"
          >
            View all
          </Link>
        </div>
        {topCards.isPending ? (
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-[5/7] animate-pulse rounded-xl bg-slate-800/60" />
            ))}
          </div>
        ) : valuedTopCards.length > 0 ? (
          <div className="grid grid-cols-4 gap-2">
            {valuedTopCards.map((tile) => (
              <Link
                key={tile.holdingId}
                to="/portfolio/$holdingId"
                params={{ holdingId: tile.holdingId }}
                className="space-y-1"
              >
                <CardImage
                  imageBaseUrl={tile.cardImageBaseUrl}
                  alt={portfolioDisplayName(tile)}
                  quality="low"
                  className="aspect-[5/7] w-full"
                />
                <p className="truncate text-[11px] text-slate-400">{portfolioSubtitle(tile)}</p>
              </Link>
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-800 p-4 text-sm text-slate-500">
            No valued cards yet — set a value on a graded card, or check back once market pricing
            arrives.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">Market movers · 7 days</h2>
          <Link to="/market-movers" className="text-xs font-medium text-sky-400 hover:underline">
            View all
          </Link>
        </div>
        {movers.isPending ? (
          <div className="h-14 animate-pulse rounded-xl bg-slate-800/60" />
        ) : movers.data && movers.data.length > 0 ? (
          <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
            {movers.data.map((m) => (
              <li key={m.holdingId} className="flex items-center justify-between gap-3 p-3 text-sm">
                <Link
                  to="/portfolio/$holdingId"
                  params={{ holdingId: m.holdingId }}
                  className="min-w-0 truncate text-slate-200 hover:underline"
                >
                  {m.cardName ?? 'Unknown card'}
                </Link>
                <span
                  className={`shrink-0 tabular-nums ${m.changeMinor >= 0n ? 'text-emerald-400' : 'text-rose-400'}`}
                >
                  {m.changeMinor >= 0n ? '+' : ''}
                  {formatNokMinor(m.changeMinor)} NOK
                  {m.changePct !== null
                    ? ` (${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(1)}%)`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-800 p-4 text-sm text-slate-500">
            Not enough price history yet to show movement — check back once your cards have been
            tracked for a few days.
          </p>
        )}
      </section>

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

function StatTile({
  label,
  value,
  wide = false,
}: {
  label: string
  value: number | undefined
  wide?: boolean
}) {
  return (
    <div className={`rounded-xl border border-slate-800 p-4 ${wide ? 'col-span-2' : ''}`}>
      <p className="text-2xl font-semibold tabular-nums text-slate-100">
        {value === undefined ? '—' : value.toLocaleString('nb-NO')}
      </p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  )
}
