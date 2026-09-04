import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSale,
  updateSale,
  type Sale,
  type SaleLine,
  type SaleLineUpdateInput,
} from '../../data/sales'
import { fetchFxRate } from '../../data/fx'
import { fromDecimalString, toDecimalString } from '../../domain/money'
import type { CurrencyCode } from '../../domain/currency'
import { Button, FormMessage, TextField } from '../../ui/form'
import { useUnsavedWorkSnapshot } from '../../platform/unsaved-work-registry'

function parseAmount(raw: string, currency: CurrencyCode): bigint {
  const trimmed = raw.trim().replace(',', '.')
  if (trimmed === '') return 0n
  return fromDecimalString(trimmed, currency).minorUnits
}

/**
 * Safe-correction path (prompt §50-51, mirrors update_purchase's scope): fixes sale-level charges
 * and each existing line's unit price. Cannot change which lot or how many units were sold — that
 * needs a real disposal reversal, which this milestone defers in favour of "void this sale, record
 * a corrected one" (the sale detail page's Void action).
 *
 * This shell only decides *whether* to render the form; `SaleEditForm` below mounts once (`key`
 * pinned to saleId) only after real data exists, so every field's initial value comes straight from
 * props via a lazy `useState` initializer — no effect syncing server data into local state.
 */
export function SaleEditPage() {
  const { saleId } = useParams({ from: '/sales/$saleId/edit' })
  const detail = useQuery({ queryKey: ['sale', saleId], queryFn: () => getSale(saleId) })

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
      </div>
    )
  }
  if (detail.data.sale.voidedAt) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <FormMessage tone="error">A voided sale cannot be edited.</FormMessage>
        <Link
          to="/sales/$saleId"
          params={{ saleId }}
          className="text-sm text-sky-400 underline-offset-4 hover:underline"
        >
          ← Back to sale
        </Link>
      </div>
    )
  }

  return (
    <SaleEditForm key={saleId} saleId={saleId} sale={detail.data.sale} lines={detail.data.lines} />
  )
}

function SaleEditForm({ saleId, sale, lines }: { saleId: string; sale: Sale; lines: SaleLine[] }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currency = sale.currency as CurrencyCode

  const [soldOn, setSoldOn] = useState(sale.soldOn)
  const [marketplace, setMarketplace] = useState(sale.marketplace ?? '')
  const [feesInput, setFeesInput] = useState(() =>
    toDecimalString({ minorUnits: sale.feesMinor, currency }),
  )
  const [shippingCostInput, setShippingCostInput] = useState(() =>
    toDecimalString({ minorUnits: sale.shippingCostMinor, currency }),
  )
  const [shippingChargedInput, setShippingChargedInput] = useState(() =>
    toDecimalString({ minorUnits: sale.shippingChargedMinor, currency }),
  )
  const [notes, setNotes] = useState(sale.notes ?? '')
  const [fxRate, setFxRate] = useState(sale.fxRateToNok)
  const [lineInputs, setLineInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.id, toDecimalString({ minorUnits: l.unitGrossMinor, currency })]),
    ),
  )
  const [error, setError] = useState<string | null>(null)

  // F-40 (P89): see PurchaseFormPage's identical registration for why.
  useUnsavedWorkSnapshot('sale-edit-form', {
    soldOn,
    marketplace,
    feesInput,
    shippingCostInput,
    shippingChargedInput,
    notes,
    fxRate,
    lineInputs,
  })

  const preview = useMemo(() => {
    try {
      const gross = lines.reduce(
        (sum, l) => sum + parseAmount(lineInputs[l.id] ?? '0', currency) * BigInt(l.quantity),
        0n,
      )
      const fees = parseAmount(feesInput, currency)
      const ship = parseAmount(shippingCostInput, currency)
      const shipCharged = parseAmount(shippingChargedInput, currency)
      return gross - fees - ship + shipCharged
    } catch {
      return null
    }
  }, [lines, lineInputs, feesInput, shippingCostInput, shippingChargedInput, currency])

  const submitMutation = useMutation({
    mutationFn: async () => {
      const saleLines: SaleLineUpdateInput[] = lines.map((l) => ({
        lineId: l.id,
        unitGrossMinor: parseAmount(lineInputs[l.id] ?? '0', currency),
      }))

      let resolvedFxRate: string | undefined = fxRate || undefined
      let resolvedFxDate: string | undefined = sale.fxRateDate
      if (currency !== 'NOK' && !resolvedFxRate) {
        const result = await fetchFxRate(currency, soldOn)
        resolvedFxRate = result.rate
        resolvedFxDate = result.rateDate
      }

      return updateSale(saleId, saleLines, {
        soldOn,
        currency,
        marketplace: marketplace || undefined,
        feesMinor: parseAmount(feesInput, currency),
        shippingCostMinor: parseAmount(shippingCostInput, currency),
        shippingChargedMinor: parseAmount(shippingChargedInput, currency),
        fxRateToNok: resolvedFxRate,
        fxRateDate: resolvedFxDate,
        fxSource: currency === 'NOK' ? undefined : sale.fxSource,
        notes: notes || undefined,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sale', saleId] })
      await queryClient.invalidateQueries({ queryKey: ['sales'] })
      await queryClient.invalidateQueries({ queryKey: ['sales-summary'] })
      // A price/fee correction changes NSP behind Home's live TTEP and spend figures.
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      await navigate({ to: '/sales/$saleId', params: { saleId } })
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-4 pb-24">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Edit sale</h1>
        <p className="mt-1 text-sm text-slate-400">
          Correct the price, fees or shipping. Which cards or lots were sold cannot change here —
          void this sale and record a new one for that.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Date"
          type="date"
          value={soldOn}
          onChange={(event) => {
            setSoldOn(event.target.value)
          }}
        />
        <TextField
          label="Marketplace"
          value={marketplace}
          onChange={(event) => {
            setMarketplace(event.target.value)
          }}
        />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-200">Items</h2>
        {lines.map((line) => (
          <div
            key={line.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-slate-200">
                {line.cardName ?? line.sealedProductName ?? line.manualCardName ?? 'Card'} ×{' '}
                {line.quantity}
              </p>
              <p className="text-xs text-slate-500">Lot from {line.lotAcquiredOn}</p>
            </div>
            <input
              inputMode="decimal"
              value={lineInputs[line.id] ?? ''}
              onChange={(event) => {
                setLineInputs((current) => ({ ...current, [line.id]: event.target.value }))
              }}
              className="w-28 shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-right text-sm text-slate-100 outline-none focus-visible:border-sky-500"
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TextField
          label="Fees"
          inputMode="decimal"
          value={feesInput}
          onChange={(event) => {
            setFeesInput(event.target.value)
          }}
        />
        <TextField
          label="Your shipping cost"
          inputMode="decimal"
          value={shippingCostInput}
          onChange={(event) => {
            setShippingCostInput(event.target.value)
          }}
        />
        <TextField
          label="Shipping paid by buyer"
          inputMode="decimal"
          value={shippingChargedInput}
          onChange={(event) => {
            setShippingChargedInput(event.target.value)
          }}
        />
      </div>

      {currency !== 'NOK' ? (
        <TextField
          label={`NOK per 1 ${currency}`}
          inputMode="decimal"
          value={fxRate}
          onChange={(event) => {
            setFxRate(event.target.value)
          }}
        />
      ) : null}

      {preview !== null ? (
        <p className="text-sm font-semibold text-slate-100">
          Net proceeds: {toDecimalString({ minorUnits: preview, currency })} {currency}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="sale-edit-notes" className="block text-sm font-medium text-slate-300">
          Notes
        </label>
        <textarea
          id="sale-edit-notes"
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value)
          }}
          rows={2}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
        />
      </div>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      <Button
        disabled={submitMutation.isPending}
        onClick={() => {
          setError(null)
          submitMutation.mutate()
        }}
      >
        {submitMutation.isPending ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  )
}
