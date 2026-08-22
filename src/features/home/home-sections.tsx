import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { formatNokMinor } from '../../ui/money-format'
import { CardImage } from '../catalog/CardImage'
import { portfolioDisplayName, portfolioSubtitle } from '../../data/portfolio'
import type { PortfolioTile } from '../../data/portfolio'
import { getMarketMovers } from '../../data/pricing'
import type { MonthlySpendMonth, RecentActivityItem } from '../../data/dashboard'

/**
 * Home's lower dashboard sections (M12). Presentation only — every figure arrives already
 * computed by the database or src/domain; these components format numbers and never compute
 * money (AGENTS.md). All monetary text respects the hide-values eye via the `hidden` prop.
 */

export function StatTile({
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

/** Data quality directly beneath the headline (UX_FLOWS.md F10, prompt §80): priced vs not,
 *  manual vs automatic, uncosted lots. Counts are harmless to show when values are hidden. */
export function DataQualityRow({
  priced,
  unpriced,
  manualValued,
  autoPriced,
  uncostedLots,
}: {
  priced: number
  unpriced: number
  manualValued: number
  autoPriced: number
  uncostedLots: number
}) {
  return (
    <div className="space-y-0.5 border-t border-slate-800 pt-3 text-xs text-slate-500">
      <p>
        {priced.toLocaleString('nb-NO')} priced
        {unpriced > 0 ? ` · ${unpriced.toLocaleString('nb-NO')} without a price` : ''}
      </p>
      {(manualValued > 0 || autoPriced > 0) && (
        <p>
          {autoPriced.toLocaleString('nb-NO')} automatic
          {manualValued > 0 ? ` · ${manualValued.toLocaleString('nb-NO')} manual` : ''}
        </p>
      )}
      {uncostedLots > 0 && (
        <p>{uncostedLots.toLocaleString('nb-NO')} lots without a recorded cost</p>
      )}
    </div>
  )
}

export function BreakdownRow({
  label,
  minor,
  hidden,
}: {
  label: string
  minor: bigint
  hidden: boolean
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-400">{label}</span>
      {hidden ? (
        <span aria-label="Value hidden" className="tabular-nums text-slate-500">
          ••••
        </span>
      ) : (
        <span className="tabular-nums text-slate-100">{formatNokMinor(minor)} kr</span>
      )}
    </div>
  )
}

export function SummaryLine({
  label,
  minor,
  hidden,
  muted = false,
  to,
}: {
  label: string
  minor: bigint | null
  hidden: boolean
  muted?: boolean
  to?: { to: '/purchases' | '/history'; search?: Record<string, unknown> }
}) {
  const value =
    minor === null ? (
      <span className="tabular-nums text-slate-600">—</span>
    ) : hidden ? (
      <span aria-label="Value hidden" className="tabular-nums text-slate-500">
        ••••
      </span>
    ) : (
      <span className={`tabular-nums ${muted ? 'text-slate-300' : 'text-slate-100'}`}>
        {formatNokMinor(minor)} kr
      </span>
    )
  if (to) {
    return (
      <Link
        to={to.to}
        search={to.search}
        className="-mx-1 flex items-center justify-between rounded px-1 py-1 hover:bg-slate-800/40"
      >
        <span className="text-sm text-slate-300">
          {label} <span className="text-xs text-slate-600">→</span>
        </span>
        {value}
      </Link>
    )
  }
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={`text-sm ${muted ? 'text-slate-500' : 'text-slate-300'}`}>{label}</span>
      {value}
    </div>
  )
}

/** Simple stacked CSS bars (collectibles + hobby per month). Deliberately no second chart
 *  library (prompt §126 "do not overbuild"). Heights encode relative magnitude only; exact
 *  figures render as masked-or-full text beneath each bar. */
export function MonthlySpending({
  months,
  hidden,
}: {
  months: MonthlySpendMonth[]
  hidden: boolean
}) {
  const max = months.reduce((acc, m) => (m.totalMinor > acc ? m.totalMinor : acc), 0n)
  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-300">Monthly spending</h2>
        <p className="text-[11px] text-slate-600">last {months.length} months</p>
      </div>
      <div
        className="flex h-28 items-end gap-1.5"
        role="img"
        aria-label={`Monthly spending, last ${months.length} months`}
      >
        {months.map((m) => {
          const totalPct = max === 0n ? 0 : Number((m.totalMinor * 100n) / max)
          const collectiblePct =
            m.totalMinor === 0n ? 0 : Number((m.collectibleMinor * 100n) / m.totalMinor)
          return (
            <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div
                className="flex w-full flex-col justify-end overflow-hidden rounded-t bg-slate-800"
                style={{
                  height: `${Math.max(totalPct, m.totalMinor > 0n ? 3 : 1)}%`,
                  minHeight: 2,
                }}
              >
                {collectiblePct > 0 ? (
                  <div
                    className="w-full bg-sky-700"
                    style={{ height: `${Math.min(collectiblePct, 100)}%` }}
                  />
                ) : null}
              </div>
              <span className="w-full truncate text-center text-[9px] tabular-nums text-slate-600">
                {m.month.slice(2, 7)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-sm bg-sky-700" /> Collectibles
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-sm bg-slate-800 ring-1 ring-inset ring-slate-700" />
          Hobby
        </span>
        <span>
          {(() => {
            const latest = months[months.length - 1]
            if (!latest) return null
            return hidden ? (
              <span aria-label="Value hidden">•••• this month</span>
            ) : (
              `${formatNokMinor(latest.totalMinor)} kr this month`
            )
          })()}
        </span>
      </div>
    </section>
  )
}

const ACTIVITY_LABEL: Record<RecentActivityItem['type'], string> = {
  purchase: 'Recorded purchase',
  sale: 'Sold',
  valuation: 'Set valuation',
  acquisition: 'Acquired',
}

export function RecentActivity({
  items,
  hidden,
}: {
  items: RecentActivityItem[]
  hidden: boolean
}) {
  function routeFor(item: RecentActivityItem) {
    switch (item.type) {
      case 'purchase':
        return { to: '/purchases/$purchaseId' as const, params: { purchaseId: item.primaryId } }
      case 'sale':
        return { to: '/sales/$saleId' as const, params: { saleId: item.primaryId } }
      case 'valuation':
      case 'acquisition':
        return item.secondaryId
          ? ({
              to: '/portfolio/$holdingId',
              params: { holdingId: item.secondaryId },
            } as const)
          : null
    }
  }
  return (
    <section className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="text-sm font-semibold text-slate-300">Recent activity</h2>
      <ul className="divide-y divide-slate-800">
        {items.map((item) => {
          const route = routeFor(item)
          const content = (
            <>
              <span className="min-w-0 truncate text-sm text-slate-300">
                {ACTIVITY_LABEL[item.type]}
                <span className="ml-2 text-xs text-slate-600">{item.occurredOn ?? ''}</span>
              </span>
              {item.amountMinor === null ? null : hidden ? (
                <span
                  aria-label="Amount hidden"
                  className="shrink-0 text-xs tabular-nums text-slate-500"
                >
                  ••••
                </span>
              ) : (
                <span className="shrink-0 text-xs tabular-nums text-slate-400">
                  {formatNokMinor(item.amountMinor)} kr
                </span>
              )}
            </>
          )
          return (
            <li key={`${item.type}-${item.primaryId}`} className="py-2 first:pt-0 last:pb-0">
              {route ? (
                <Link
                  {...route}
                  className="flex items-center justify-between gap-3 hover:opacity-90"
                >
                  {content}
                </Link>
              ) : (
                <div className="flex items-center justify-between gap-3">{content}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function MostValuableCards({
  topCards,
  pending,
  hideValues,
}: {
  topCards: PortfolioTile[]
  pending: boolean
  hideValues: boolean
}) {
  const valued = topCards.filter((tile) => tile.unitValueMinor !== null)
  void hideValues // tiles intentionally show artwork + subtitle only, no monetary text
  return (
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
      {pending ? (
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="aspect-[5/7] animate-pulse rounded-xl bg-slate-800/60" />
          ))}
        </div>
      ) : valued.length > 0 ? (
        <div className="grid grid-cols-4 gap-2">
          {valued.map((tile) => (
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
  )
}

export function MarketMoversSection() {
  const movers = useQuery({ queryKey: ['market-movers'], queryFn: () => getMarketMovers(7, 5) })
  return (
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
                className={`shrink-0 tabular-nums ${
                  m.changeMinor >= 0n ? 'text-emerald-400' : 'text-rose-400'
                }`}
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
  )
}
