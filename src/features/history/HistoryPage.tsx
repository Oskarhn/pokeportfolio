import { useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listSales, type SaleListSort } from '../../data/sales'
import { toDecimalString } from '../../domain/money'

/**
 * History (UX_FLOWS.md F8.1) — Sold / Traded / Other. Not a bottom-nav destination (prompt §55).
 * Sold is the only functional tab in M10; Traded/Other state their real status honestly rather
 * than faking a record (prompt §56/§116) — M18 owns trade recording.
 */
export function HistoryPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/history' })
  const tab = search.tab ?? 'sold'
  const [sort, setSort] = useState<SaleListSort>('newest')

  const sales = useQuery({
    queryKey: ['sales', sort],
    queryFn: () => listSales({ sort, limit: 50 }),
    enabled: tab === 'sold',
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 py-2 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">History</h1>
        <Link
          to="/sales/new"
          className="min-h-9 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Record sale
        </Link>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-800 p-1" role="tablist">
        {(['sold', 'traded', 'other'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              void navigate({ to: '/history', search: { tab: t } })
            }}
            className={`min-h-9 flex-1 rounded-md text-sm font-medium capitalize transition-colors ${
              tab === t ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'sold' ? (
        <div className="space-y-3">
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as SaleListSort)
            }}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="result_desc">Result: high to low</option>
            <option value="result_asc">Result: low to high</option>
            <option value="proceeds_desc">Highest proceeds</option>
            <option value="marketplace">Marketplace</option>
          </select>

          {sales.isPending ? (
            <div className="h-40 animate-pulse rounded-lg bg-slate-800/60" />
          ) : sales.data && sales.data.length > 0 ? (
            <ul className="space-y-2">
              {sales.data.map((sale) => (
                <li key={sale.id}>
                  <Link
                    to="/sales/$saleId"
                    params={{ saleId: sale.id }}
                    className="block rounded-lg border border-slate-800 p-3 hover:bg-slate-800/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-slate-100">
                        {sale.marketplace || 'Sale'} · {sale.itemCount} item
                        {sale.itemCount === 1 ? '' : 's'}
                      </p>
                      {sale.voidedAt ? (
                        <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                          Voided
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-slate-500">Sold {sale.soldOn}</p>
                    <div className="mt-1 flex items-center gap-4 text-xs text-slate-400">
                      <span>
                        Net proceeds{' '}
                        {toDecimalString({ minorUnits: sale.netProceedsNokMinor, currency: 'NOK' })}{' '}
                        kr
                      </span>
                      <span>
                        Result{' '}
                        {sale.realizedResultNokMinor !== null
                          ? `${toDecimalString({ minorUnits: sale.realizedResultNokMinor, currency: 'NOK' })} kr`
                          : '—'}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3 rounded-lg border border-dashed border-slate-800 p-6 text-center">
              <p className="text-sm font-medium text-slate-200">No sales recorded</p>
              <p className="text-xs text-slate-500">
                Sales reduce your Portfolio and preserve the cost basis of the exact cards sold.
              </p>
              <Link
                to="/sales/new"
                className="inline-flex min-h-9 items-center rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
              >
                Record sale
              </Link>
            </div>
          )}
        </div>
      ) : tab === 'traded' ? (
        <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
          No trades recorded yet — trade recording is not available yet.
        </p>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
          Nothing to show here yet.
        </p>
      )}
    </div>
  )
}
