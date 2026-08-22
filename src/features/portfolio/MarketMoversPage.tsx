import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getMarketMovers, type MarketMoverSort } from '../../data/pricing'
import { CardImage } from '../catalog/CardImage'
import { formatNokMinor } from '../../ui/money-format'

const PERIODS = [
  ['1', '1D'],
  ['7', '7D'],
  ['30', '30D'],
] as const
type PeriodValue = (typeof PERIODS)[number][0]

const SORTS: { value: MarketMoverSort; label: string }[] = [
  { value: 'most_movement', label: 'Most movement' },
  { value: 'highest_increase', label: 'Highest increase' },
  { value: 'largest_decrease', label: 'Largest decrease' },
  { value: 'least_movement', label: 'Least movement' },
]

function isMarketMoverSort(value: string | undefined): value is MarketMoverSort {
  return value !== undefined && SORTS.some((s) => s.value === value)
}

/**
 * The dedicated Market Movers screen the owner originally asked for (M7.1 prompt §49, reserved
 * pending M9's price history; M9.1 prompt §18-23 finishes it). Real period-over-period movement of
 * the caller's own owned, currently-priced raw-card holdings only — ranked by per-unit percentage
 * change, never a global catalog ranking and never a realized-P/L figure (get_market_movers's own
 * header). Home keeps its compact 7-day preview; this is the full screen with period and sort
 * controls, reached from the Portfolio shortcut and Home's "View all".
 */
export function MarketMoversPage() {
  const search = useSearch({ from: '/market-movers' })
  const navigate = useNavigate({ from: '/market-movers' })
  const period: PeriodValue = search.period ?? '7'
  const sort: MarketMoverSort = isMarketMoverSort(search.sort) ? search.sort : 'most_movement'

  const movers = useQuery({
    queryKey: ['market-movers-full', period, sort],
    queryFn: () => getMarketMovers(Number(period), 25, sort),
  })

  function setPeriod(next: PeriodValue) {
    void navigate({ search: (prev) => ({ ...prev, period: next }), replace: true })
  }
  function setSort(next: MarketMoverSort) {
    void navigate({ search: (prev) => ({ ...prev, sort: next }), replace: true })
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
      <div className="flex items-center gap-2">
        <Link to="/portfolio" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Portfolio
        </Link>
      </div>
      <h1 className="text-lg font-semibold tracking-tight text-slate-100">Market movers</h1>

      <div className="flex gap-2">
        {PERIODS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => {
              setPeriod(value)
            }}
            className={`min-h-9 rounded-full border px-3 text-xs font-medium transition-colors ${
              period === value
                ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {SORTS.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={sort === s.value}
            onClick={() => {
              setSort(s.value)
            }}
            className={`min-h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
              sort === s.value
                ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {movers.isPending ? (
        <ul className="space-y-2" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="h-16 animate-pulse rounded-xl bg-slate-800/60" />
          ))}
        </ul>
      ) : movers.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          Market movers could not be loaded.
        </p>
      ) : movers.data.length > 0 ? (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
          {movers.data.map((m) => (
            <li key={m.holdingId} className="flex items-center gap-3 p-3 text-sm">
              <Link
                to="/portfolio/$holdingId"
                params={{ holdingId: m.holdingId }}
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <CardImage
                  imageBaseUrl={m.cardImageBaseUrl}
                  alt={m.cardName ?? 'Card'}
                  quality="low"
                  className="h-14 w-10 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block truncate text-slate-200">
                    {m.cardName ?? 'Unknown card'}
                  </span>
                  <span className="block text-xs text-slate-500">
                    kr {formatNokMinor(m.currentValueMinor)}
                    {m.quantity > 1 ? ` · x${String(m.quantity)}` : ''}
                  </span>
                </span>
              </Link>
              <span
                className={`shrink-0 text-right tabular-nums ${
                  m.changeMinor >= 0n ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                <span className="block font-medium">
                  {m.changePct !== null
                    ? `${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(1)}%`
                    : '—'}
                </span>
                <span className="block text-xs opacity-80">
                  {m.changeMinor >= 0n ? '+' : ''}
                  {formatNokMinor(m.changeMinor)} kr
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-slate-800 p-4 text-sm text-slate-500">
          Not enough price history yet for this period — check back once your cards have been
          tracked for a while. This is expected early on, not an error.
        </p>
      )}
    </div>
  )
}
