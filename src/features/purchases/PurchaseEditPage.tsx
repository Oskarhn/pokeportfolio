import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getPurchase,
  updatePurchase,
  type PurchaseDetail,
  type PurchaseLineInput,
  type SpendClass,
} from '../../data/purchases'
import { listRetailers } from '../../data/retailers'
import { fromDecimalString, toDecimalString } from '../../domain/money'
import { allocate } from '../../domain/allocation'
import type { CurrencyCode } from '../../domain/currency'
import { Button, FormMessage, SelectField, TextField } from '../../ui/form'
import { LINE_TYPE_LABEL } from './labels'
import { at } from './util'

function parseAmount(raw: string, currency: CurrencyCode): bigint {
  const trimmed = raw.trim().replace(',', '.')
  if (trimmed === '') return 0n
  return fromDecimalString(trimmed, currency).minorUnits
}

interface EditLineState {
  lineId: string
  label: string
  lineType: string
  quantity: string
  unitPrice: string
  spendClassOverride: SpendClass | ''
}

function linesFrom(detail: PurchaseDetail): EditLineState[] {
  return detail.lines.map((line) => ({
    lineId: line.id,
    label:
      line.cardName ?? line.sealedProductName ?? line.description ?? LINE_TYPE_LABEL[line.lineType],
    lineType: line.lineType,
    quantity: String(line.quantity),
    unitPrice: toDecimalString({
      minorUnits: line.unitPriceMinor,
      currency: detail.purchase.currency as CurrencyCode,
    }),
    spendClassOverride: '',
  }))
}

/**
 * Safe-edit path (UX_FLOWS.md "Wrong purchase amount", M8 prompt §56-58). Purchase-level fields
 * plus each existing line's quantity/price/spend-class are editable; lines cannot be added or
 * removed here — see update_purchase's migration header for why. A blocked edit (a produced lot
 * already disposed elsewhere) surfaces the database's own message, which names the line.
 */
export function PurchaseEditPage() {
  const { purchaseId } = useParams({ from: '/purchases/$purchaseId/edit' })
  const detail = useQuery({
    queryKey: ['purchase', purchaseId],
    queryFn: () => getPurchase(purchaseId),
  })

  if (detail.isLoading) {
    return <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
  }
  if (!detail.data) {
    return <p className="py-8 text-center text-sm text-slate-400">Purchase not found.</p>
  }
  if (detail.data.purchase.voidedAt) {
    return (
      <p className="py-8 text-center text-sm text-slate-400">A voided purchase cannot be edited.</p>
    )
  }

  return <PurchaseEditForm purchaseId={purchaseId} detail={detail.data} />
}

/** Mounted only once `detail` is loaded, so every field initializes from real data via a lazy
 *  `useState` initializer — no effect syncing external data into local state is needed at all. */
function PurchaseEditForm({ purchaseId, detail }: { purchaseId: string; detail: PurchaseDetail }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currency = detail.purchase.currency as CurrencyCode

  const retailers = useQuery({ queryKey: ['retailers'], queryFn: listRetailers })

  const [purchasedOn, setPurchasedOn] = useState(detail.purchase.purchasedOn)
  const [retailerId, setRetailerId] = useState(detail.purchase.retailerId ?? '')
  const [shippingInput, setShippingInput] = useState(() =>
    toDecimalString({ minorUnits: detail.purchase.shippingMinor, currency }),
  )
  const [customsInput, setCustomsInput] = useState(() =>
    toDecimalString({ minorUnits: detail.purchase.customsMinor, currency }),
  )
  const [discountInput, setDiscountInput] = useState(() =>
    toDecimalString({ minorUnits: detail.purchase.discountMinor, currency }),
  )
  const [notes, setNotes] = useState(detail.purchase.notes ?? '')
  const [editLines, setEditLines] = useState<EditLineState[]>(() => linesFrom(detail))
  const [error, setError] = useState<string | null>(null)

  const preview = useMemo(() => {
    try {
      const shipping = parseAmount(shippingInput, currency)
      const customs = parseAmount(customsInput, currency)
      const discount = parseAmount(discountInput, currency)
      const weights = editLines.map((line) => {
        const qty = BigInt(Math.max(1, Number.parseInt(line.quantity || '1', 10)))
        return parseAmount(line.unitPrice, currency) * qty
      })
      if (weights.length === 0) return null
      const allocShip = allocate(shipping, weights)
      const allocCustoms = allocate(customs, weights)
      const allocDiscount = allocate(discount, weights)
      const total = weights.reduce((a, b) => a + b, 0n) + shipping + customs - discount
      return {
        total,
        lines: editLines.map((line, i) => {
          const weight = at(weights, i)
          const ship = at(allocShip, i)
          const cust = at(allocCustoms, i)
          const disc = at(allocDiscount, i)
          return { label: line.label, attributable: weight + ship + cust - disc }
        }),
      }
    } catch {
      return null
    }
  }, [editLines, shippingInput, customsInput, discountInput, currency])

  const submit = useMutation({
    mutationFn: async () => {
      const lineInputs: PurchaseLineInput[] = editLines.map((line) => {
        const quantity = Number.parseInt(line.quantity, 10)
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new Error(`${line.label}: quantity must be a positive number.`)
        }
        const unitPriceMinor = fromDecimalString(line.unitPrice || '0', currency).minorUnits
        if (unitPriceMinor < 0n) throw new Error(`${line.label}: unit price cannot be negative.`)
        return {
          lineId: line.lineId,
          lineType: line.lineType as PurchaseLineInput['lineType'],
          quantity,
          unitPriceMinor,
          spendClass: line.spendClassOverride || undefined,
        }
      })

      return updatePurchase(purchaseId, {
        purchasedOn,
        currency,
        lines: lineInputs,
        retailerId: retailerId || undefined,
        shippingMinor: parseAmount(shippingInput, currency),
        customsMinor: parseAmount(customsInput, currency),
        discountMinor: parseAmount(discountInput, currency),
        fxRateToNok: detail.purchase.fxRateToNok,
        fxRateDate: detail.purchase.fxRateDate,
        fxSource: detail.purchase.fxSource,
        notes: notes || undefined,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['purchase', purchaseId] })
      await queryClient.invalidateQueries({ queryKey: ['purchases'] })
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await navigate({ to: '/purchases/$purchaseId', params: { purchaseId } })
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-4 pb-24">
      <Link
        to="/purchases/$purchaseId"
        params={{ purchaseId }}
        className="text-xs text-slate-500 hover:text-slate-300"
      >
        ← Back
      </Link>
      <h1 className="text-xl font-semibold tracking-tight text-slate-100">Edit purchase</h1>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Date"
          type="date"
          value={purchasedOn}
          onChange={(event) => {
            setPurchasedOn(event.target.value)
          }}
        />
        <TextField
          label="Currency"
          value={currency}
          disabled
          hint="Currency cannot change on edit."
        />
      </div>

      <SelectField
        label="Retailer"
        value={retailerId}
        onChange={(event) => {
          setRetailerId(event.target.value)
        }}
      >
        <option value="">No retailer</option>
        {(retailers.data ?? []).map((retailer) => (
          <option key={retailer.id} value={retailer.id}>
            {retailer.name}
          </option>
        ))}
      </SelectField>

      <div className="space-y-3">
        {editLines.map((line, index) => (
          <div
            key={line.lineId}
            className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4"
          >
            <p className="text-sm font-medium text-slate-200">{line.label}</p>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Quantity"
                type="number"
                min={1}
                value={line.quantity}
                onChange={(event) => {
                  const value = event.target.value
                  setEditLines((current) =>
                    current.map((l, i) => (i === index ? { ...l, quantity: value } : l)),
                  )
                }}
              />
              <TextField
                label="Unit price"
                inputMode="decimal"
                value={line.unitPrice}
                onChange={(event) => {
                  const value = event.target.value
                  setEditLines((current) =>
                    current.map((l, i) => (i === index ? { ...l, unitPrice: value } : l)),
                  )
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TextField
          label="Shipping"
          inputMode="decimal"
          value={shippingInput}
          onChange={(event) => {
            setShippingInput(event.target.value)
          }}
        />
        <TextField
          label="Customs"
          inputMode="decimal"
          value={customsInput}
          onChange={(event) => {
            setCustomsInput(event.target.value)
          }}
        />
        <TextField
          label="Discount"
          inputMode="decimal"
          value={discountInput}
          onChange={(event) => {
            setDiscountInput(event.target.value)
          }}
        />
      </div>

      {preview ? (
        <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Allocation preview</p>
          <ul className="space-y-1 text-xs text-slate-400">
            {preview.lines.map((line, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="truncate">{line.label}</span>
                <span className="shrink-0 text-slate-200">
                  {toDecimalString({ minorUnits: line.attributable, currency })} {currency}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-slate-800 pt-2 text-sm font-semibold text-slate-100">
            <span>Total</span>
            <span>
              {toDecimalString({ minorUnits: preview.total, currency })} {currency}
            </span>
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-slate-300">Notes</label>
        <textarea
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
        disabled={submit.isPending}
        onClick={() => {
          setError(null)
          submit.mutate()
        }}
      >
        {submit.isPending ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  )
}
