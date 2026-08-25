import { useState } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getPurchase, voidPurchase } from '../../data/purchases'
import { toDecimalString, type Money } from '../../domain/money'
import { formatNokMinor } from '../../ui/money-format'
import { Button, FormMessage } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'
import { LINE_TYPE_LABEL, SPEND_CLASS_LABEL } from './labels'

function fmt(minorUnits: bigint, currency: string): string {
  return toDecimalString({ minorUnits, currency } as Money)
}

/**
 * Purchase detail (UX_FLOWS.md F3 / M8 prompt §17): every krone traceable — original amount, FX
 * provenance, per-line allocation, attributable cost, and where the money ended up (which lines
 * created inventory). Edit/void are offered only while the purchase is live.
 */
export function PurchaseDetailPage() {
  const { purchaseId } = useParams({ from: '/purchases/$purchaseId' })
  const { created } = useSearch({ from: '/purchases/$purchaseId' })
  const navigate = useNavigate({ from: '/purchases/$purchaseId' })
  const queryClient = useQueryClient()
  const [voidSheetOpen, setVoidSheetOpen] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState<string | null>(null)

  const detail = useQuery({
    queryKey: ['purchase', purchaseId],
    queryFn: () => getPurchase(purchaseId),
  })

  const voidMutation = useMutation({
    mutationFn: () => voidPurchase(purchaseId, voidReason || undefined),
    onSuccess: async () => {
      setVoidSheetOpen(false)
      setVoidError(null)
      await queryClient.invalidateQueries({ queryKey: ['purchase', purchaseId] })
      await queryClient.invalidateQueries({ queryKey: ['purchases'] })
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      // Voiding reverts ownership and spend — Home's live figures must refetch.
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
    },
    onError: (error: Error) => {
      setVoidError(error.message)
    },
  })

  if (detail.isLoading) {
    return <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
  }
  if (!detail.data) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-slate-400">Purchase not found.</p>
        <Link to="/purchases" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          Back to purchases
        </Link>
      </div>
    )
  }

  const { purchase, retailerName, lines } = detail.data
  const isVoided = purchase.voidedAt !== null
  const isForeign = purchase.currency !== 'NOK'

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link to="/purchases" className="text-xs text-slate-500 hover:text-slate-300">
            ← Purchases
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">
            {retailerName ?? 'Purchase'}
            {isVoided ? (
              <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                Voided
              </span>
            ) : null}
          </h1>
        </div>
        {!isVoided ? (
          <div className="flex shrink-0 gap-2">
            <Link
              to="/purchases/$purchaseId/edit"
              params={{ purchaseId }}
              className="inline-flex min-h-9 items-center rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={() => {
                setVoidError(null)
                setVoidSheetOpen(true)
              }}
              className="inline-flex min-h-9 items-center rounded-lg border border-rose-900/60 px-3 text-sm font-medium text-rose-300 hover:bg-rose-950/40"
            >
              Void
            </button>
          </div>
        ) : null}
      </div>

      {created ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-900/60 bg-emerald-950/40 p-3 text-sm text-emerald-200">
          <span>Purchase recorded.</span>
          <span className="flex shrink-0 items-center gap-3">
            <Link to="/portfolio" className="font-medium underline-offset-4 hover:underline">
              View Portfolio
            </Link>
            <button
              type="button"
              onClick={() => {
                void navigate({ search: {}, replace: true })
              }}
              aria-label="Dismiss"
              className="text-emerald-300/70 hover:text-emerald-200"
            >
              ✕
            </button>
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm sm:grid-cols-4">
        <Field label="Date" value={purchase.purchasedOn} />
        <Field label="Currency" value={purchase.currency} />
        <Field
          label="Total"
          value={`${fmt(purchase.totalMinor, purchase.currency)} ${purchase.currency}`}
        />
        <Field label="Total (NOK)" value={`${formatNokMinor(purchase.totalNokMinor)} kr`} />
      </div>

      {isForeign ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
            Exchange rate
          </p>
          <p className="mt-1 text-slate-200">
            {purchase.fxRateToNok} NOK/{purchase.currency}
          </p>
          <p className="text-xs text-slate-500">
            {purchase.fxSource === 'manual'
              ? 'Manual rate'
              : `Norges Bank · ${purchase.fxRateDate}`}
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-300">Lines ({lines.length})</h2>
        <ul className="space-y-2">
          {lines.map((line) => (
            <li
              key={line.id}
              className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-100">
                    {line.cardName ??
                      line.sealedProductName ??
                      line.description ??
                      LINE_TYPE_LABEL[line.lineType]}
                  </p>
                  <p className="text-xs text-slate-500">
                    {LINE_TYPE_LABEL[line.lineType]} · {SPEND_CLASS_LABEL[line.spendClass]}
                    {line.cardLocalId ? ` · #${line.cardLocalId}` : ''} · ×{line.quantity}
                  </p>
                </div>
                <p className="shrink-0 font-semibold text-slate-100">
                  {fmt(line.attributableCostMinor, purchase.currency)} {purchase.currency}
                </p>
              </div>
              {line.allocatedShippingMinor > 0n ||
              line.allocatedCustomsMinor > 0n ||
              line.allocatedDiscountMinor > 0n ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-800 pt-2 text-xs text-slate-500 sm:grid-cols-4">
                  <div>
                    <dt className="inline">Item: </dt>
                    <dd className="inline">{fmt(line.lineTotalMinor, purchase.currency)}</dd>
                  </div>
                  {line.allocatedShippingMinor > 0n ? (
                    <div>
                      <dt className="inline">+ Shipping: </dt>
                      <dd className="inline">
                        {fmt(line.allocatedShippingMinor, purchase.currency)}
                      </dd>
                    </div>
                  ) : null}
                  {line.allocatedCustomsMinor > 0n ? (
                    <div>
                      <dt className="inline">+ Customs: </dt>
                      <dd className="inline">
                        {fmt(line.allocatedCustomsMinor, purchase.currency)}
                      </dd>
                    </div>
                  ) : null}
                  {line.allocatedDiscountMinor > 0n ? (
                    <div>
                      <dt className="inline">− Discount: </dt>
                      <dd className="inline">
                        {fmt(line.allocatedDiscountMinor, purchase.currency)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
        <Row label="Subtotal" value={fmt(purchase.subtotalMinor, purchase.currency)} />
        <Row label="Shipping" value={fmt(purchase.shippingMinor, purchase.currency)} />
        <Row label="Customs" value={fmt(purchase.customsMinor, purchase.currency)} />
        <Row label="Discount" value={`−${fmt(purchase.discountMinor, purchase.currency)}`} />
        <Row
          label="Total"
          value={`${fmt(purchase.totalMinor, purchase.currency)} ${purchase.currency}`}
          strong
        />
      </div>

      {purchase.notes ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Notes</p>
          <p className="mt-1 whitespace-pre-wrap text-slate-300">{purchase.notes}</p>
        </div>
      ) : null}

      <Sheet
        open={voidSheetOpen}
        onClose={() => {
          setVoidSheetOpen(false)
        }}
        title="Void this purchase?"
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            The purchase and everything it created are retained but excluded from spending totals.
            This cannot be undone here — you would need to record a new purchase.
          </p>
          <textarea
            value={voidReason}
            onChange={(event) => {
              setVoidReason(event.target.value)
            }}
            placeholder="Reason (optional)"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
            rows={2}
          />
          {voidError ? <FormMessage tone="error">{voidError}</FormMessage> : null}
          <Button
            variant="primary"
            className="border border-rose-900/60 bg-rose-900/80 hover:bg-rose-800"
            disabled={voidMutation.isPending}
            onClick={() => {
              voidMutation.mutate()
            }}
          >
            {voidMutation.isPending ? 'Voiding…' : 'Void purchase'}
          </Button>
        </div>
      </Sheet>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-0.5 font-medium text-slate-100">{value}</p>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between py-1 ${strong ? 'mt-1 border-t border-slate-800 pt-2 font-semibold text-slate-100' : 'text-slate-400'}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}
