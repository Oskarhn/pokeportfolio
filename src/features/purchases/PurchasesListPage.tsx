import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getSpendingSummary, listPurchases } from '../../data/purchases'
import { formatNokMinor } from '../../ui/money-format'
import { PlusIcon } from '../../ui/icons'

/**
 * The M8 spending ledger (UX_FLOWS.md F3). Leads with the headline spend figures — Total spent /
 * Spent on collectibles / Spent on accessories, the UI labels FINANCIAL_MODEL.md §9 assigns to
 * GPO/CS/HS — then the purchase list itself, newest first.
 */
export function PurchasesListPage() {
  const [showVoided, setShowVoided] = useState(false)

  const summary = useQuery({ queryKey: ['spending-summary'], queryFn: getSpendingSummary })
  const purchases = useQuery({
    queryKey: ['purchases', showVoided],
    queryFn: () => listPurchases({ includeVoided: showVoided }),
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Purchases</h1>
        <Link
          to="/purchases/new"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-accent-foreground hover:bg-sky-500"
        >
          <PlusIcon className="size-4" />
          Record purchase
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <SummaryStat label="Total spent" value={summary.data?.gpoNokMinor} />
        <SummaryStat label="Collectibles" value={summary.data?.csNokMinor} />
        <SummaryStat label="Accessories" value={summary.data?.hsNokMinor} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">
          {purchases.data
            ? `${purchases.data.length} purchase${purchases.data.length === 1 ? '' : 's'}`
            : 'Ledger'}
        </h2>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={showVoided}
            onChange={(event) => {
              setShowVoided(event.target.checked)
            }}
            className="size-4 rounded border-slate-700 bg-slate-900"
          />
          Show voided
        </label>
      </div>

      {purchases.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : purchases.data && purchases.data.length > 0 ? (
        <ul className="space-y-2">
          {purchases.data.map((item) => (
            <li key={item.purchase.id}>
              <Link
                to="/purchases/$purchaseId"
                params={{ purchaseId: item.purchase.id }}
                className={`block rounded-xl border px-4 py-3 hover:bg-slate-800/40 ${
                  item.purchase.voidedAt
                    ? 'border-slate-800/60 opacity-60'
                    : 'border-slate-800 bg-slate-900/40'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {item.retailerName ?? 'No retailer'}
                      {item.purchase.voidedAt ? (
                        <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                          Voided
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-slate-500">
                      {item.purchase.purchasedOn} · {item.lineCount} line
                      {item.lineCount === 1 ? '' : 's'}
                      {item.purchase.currency !== 'NOK' ? ` · ${item.purchase.currency}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-slate-100">
                      {formatNokMinor(item.purchase.totalNokMinor)} kr
                    </p>
                    {item.hobbyNokMinor > 0n ? (
                      <p className="text-xs text-slate-500">
                        {formatNokMinor(item.hobbyNokMinor)} kr accessories
                      </p>
                    ) : null}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mx-auto max-w-sm space-y-2 rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center">
          <p className="text-sm font-medium text-slate-300">No purchases recorded</p>
          <p className="text-sm text-slate-500">
            Record a purchase when you bought several items together, need to include shipping or
            customs, or just want the receipt in your spending history.
          </p>
          <Link
            to="/purchases/new"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-sky-600 px-4 text-sm font-semibold text-accent-foreground hover:bg-sky-500"
          >
            Record purchase
          </Link>
        </div>
      )}
    </div>
  )
}

function SummaryStat({ label, value }: { label: string; value: bigint | undefined }) {
  return (
    <div>
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-100">
        {value === undefined ? '—' : `${formatNokMinor(value)} kr`}
      </p>
    </div>
  )
}
