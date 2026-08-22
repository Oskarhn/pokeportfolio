import { useState } from 'react'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSale, voidSale } from '../../data/sales'
import { toDecimalString } from '../../domain/money'
import type { CurrencyCode } from '../../domain/currency'
import { CONDITION_LABEL, ORIGIN_LABEL } from '../collection/labels'
import { Button, FormMessage } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'

/** UX_FLOWS.md F8.1's sale-detail audit trail (prompt §58). Every figure here is traceable back to
 *  the exact lots that left inventory — no internal UUIDs, no fabricated result where the cost
 *  basis is genuinely unknown. */
export function SaleDetailPage() {
  const { saleId } = useParams({ from: '/sales/$saleId' })
  const search = useSearch({ from: '/sales/$saleId' })
  const queryClient = useQueryClient()
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)

  const detail = useQuery({ queryKey: ['sale', saleId], queryFn: () => getSale(saleId) })

  const voidMutation = useMutation({
    mutationFn: () => voidSale(saleId),
    onSuccess: async () => {
      setVoidOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['sale', saleId] })
      await queryClient.invalidateQueries({ queryKey: ['sales'] })
      await queryClient.invalidateQueries({ queryKey: ['sales-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
    },
    onError: (err: Error) => {
      setVoidError(err.message)
    },
  })

  if (detail.isPending) {
    return (
      <div className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-lg bg-slate-800/60" />
    )
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          That sale could not be found.
        </p>
        <Link to="/history" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Back to History
        </Link>
      </div>
    )
  }

  const { sale, lines } = detail.data
  const currency = sale.currency as CurrencyCode
  const knownLines = lines.filter((l) => l.costBasisAtSaleNokMinor !== null)
  const unknownLines = lines.filter((l) => l.costBasisAtSaleNokMinor === null)
  const realizedSum = knownLines.reduce((sum, l) => sum + (l.realizedResultNokMinor ?? 0n), 0n)
  const uncostedSum = unknownLines.reduce((sum, l) => sum + l.netProceedsNokMinor, 0n)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-2 pb-24">
      <Link to="/history" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to History
      </Link>

      {search.created ? <FormMessage tone="success">Sale recorded.</FormMessage> : null}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">
            {sale.marketplace || 'Sale'}
          </h1>
          <p className="text-sm text-slate-400">
            {sale.soldOn}
            {sale.voidedAt ? <span className="ml-2 text-rose-300">Voided</span> : null}
          </p>
        </div>
        {!sale.voidedAt ? (
          <div className="flex shrink-0 gap-2">
            <Link
              to="/sales/$saleId/edit"
              params={{ saleId }}
              className="min-h-9 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={() => {
                setVoidError(null)
                setVoidOpen(true)
              }}
              className="min-h-9 rounded-lg border border-rose-900/60 px-3 text-sm font-medium text-rose-300 hover:bg-rose-950/40"
            >
              Void
            </button>
          </div>
        ) : null}
      </div>

      <div className="space-y-1 rounded-2xl border border-slate-800 p-4 text-sm">
        <Row label="Gross sale price" value={sale.grossMinor} currency={currency} />
        <Row label="Fees" value={-sale.feesMinor} currency={currency} />
        <Row label="Your shipping cost" value={-sale.shippingCostMinor} currency={currency} />
        <Row label="Shipping paid by buyer" value={sale.shippingChargedMinor} currency={currency} />
        <div className="flex justify-between border-t border-slate-800 pt-2 font-semibold text-slate-100">
          <span>Net proceeds</span>
          <span>
            {toDecimalString({ minorUnits: sale.netProceedsMinor, currency })} {currency}
          </span>
        </div>
        {currency !== 'NOK' ? (
          <p className="pt-1 text-xs text-slate-500">
            {toDecimalString({ minorUnits: sale.netProceedsNokMinor, currency: 'NOK' })} NOK · rate{' '}
            {sale.fxRateToNok} · {sale.fxRateDate} ·{' '}
            {sale.fxSource === 'norges_bank' ? 'Norges Bank' : 'Manual rate'}
          </p>
        ) : null}
      </div>

      {/* Mixed known/unknown summary (prompt §80/§123) — never a single collapsed "Profit". */}
      <div className="space-y-1 rounded-2xl border border-slate-800 p-4 text-sm">
        {knownLines.length > 0 ? (
          <Row
            label="Realized result on costed items"
            value={realizedSum}
            currency="NOK"
            emphasize
          />
        ) : null}
        {unknownLines.length > 0 ? (
          <Row
            label="Proceeds from items without recorded cost"
            value={uncostedSum}
            currency="NOK"
          />
        ) : null}
        {knownLines.length === 0 && unknownLines.length === 0 ? (
          <p className="text-slate-500">No lines.</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-200">Items</h2>
        {lines.map((line) => (
          <div key={line.id} className="space-y-1 rounded-2xl border border-slate-800 p-3 text-sm">
            <p className="font-medium text-slate-100">
              {line.cardName ?? line.sealedProductName ?? line.manualCardName ?? 'Card'} ×{' '}
              {line.quantity}
            </p>
            <p className="text-xs text-slate-500">
              {ORIGIN_LABEL[line.lotOrigin]} lot acquired {line.lotAcquiredOn}
              {line.condition ? ` · ${CONDITION_LABEL[line.condition]}` : ''}
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 pt-1 text-xs text-slate-400">
              <span>Gross</span>
              <span className="text-right">
                {toDecimalString({ minorUnits: line.lineGrossMinor, currency })} {currency}
              </span>
              <span>Allocated fees</span>
              <span className="text-right">
                {toDecimalString({ minorUnits: line.allocatedFeesMinor, currency })} {currency}
              </span>
              <span>Allocated shipping</span>
              <span className="text-right">
                {toDecimalString({ minorUnits: line.allocatedShippingMinor, currency })} {currency}
              </span>
              <span>Allocated buyer shipping</span>
              <span className="text-right">
                {toDecimalString({ minorUnits: line.allocatedShippingChargedMinor, currency })}{' '}
                {currency}
              </span>
              <span>Net proceeds</span>
              <span className="text-right">
                {toDecimalString({ minorUnits: line.netProceedsNokMinor, currency: 'NOK' })} NOK
              </span>
              <span>Cost basis</span>
              <span className="text-right">
                {line.costBasisAtSaleNokMinor !== null
                  ? `${toDecimalString({ minorUnits: line.costBasisAtSaleNokMinor, currency: 'NOK' })} NOK`
                  : '—'}
              </span>
              <span>Result</span>
              <span className="text-right font-medium text-slate-200">
                {line.realizedResultNokMinor !== null
                  ? `${toDecimalString({ minorUnits: line.realizedResultNokMinor, currency: 'NOK' })} NOK`
                  : '—'}
              </span>
            </div>
            {line.costBasisAtSaleNokMinor === null ? (
              <p className="text-xs text-slate-500">
                Cost basis unavailable — proceeds only, not a profit.
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {sale.notes ? (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-200">Notes</h2>
          <p className="text-sm text-slate-400">{sale.notes}</p>
        </div>
      ) : null}

      <Sheet
        open={voidOpen}
        onClose={() => {
          setVoidOpen(false)
        }}
        title="Void this sale?"
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            The sold quantity returns to your Portfolio and this sale no longer counts toward your
            totals. The sale stays visible in History, marked voided.
          </p>
          {voidError ? <FormMessage tone="error">{voidError}</FormMessage> : null}
          <Button
            variant="primary"
            className="border border-rose-900/60 bg-rose-900/80 hover:bg-rose-800"
            disabled={voidMutation.isPending}
            onClick={() => {
              voidMutation.mutate()
            }}
          >
            {voidMutation.isPending ? 'Voiding…' : 'Void sale'}
          </Button>
        </div>
      </Sheet>
    </div>
  )
}

function Row({
  label,
  value,
  currency,
  emphasize,
}: {
  label: string
  value: bigint
  currency: CurrencyCode
  emphasize?: boolean
}) {
  return (
    <div
      className={`flex justify-between ${emphasize ? 'font-semibold text-slate-100' : 'text-slate-300'}`}
    >
      <span>{label}</span>
      <span>
        {toDecimalString({ minorUnits: value, currency })} {currency}
      </span>
    </div>
  )
}
