import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { getHoldingLots, type AcquisitionLot } from '../../data/collection'
import {
  listPortfolio,
  portfolioDisplayName,
  portfolioSubtitle,
  type PortfolioTile,
} from '../../data/portfolio'
import { createSale, type SaleLineInput } from '../../data/sales'
import { fetchFxRate, FxRateNotFoundError } from '../../data/fx'
import { fromDecimalString, toDecimalString } from '../../domain/money'
import { allocate } from '../../domain/allocation'
import { suggestFifoOrder } from '../../domain/sales'
import type { CurrencyCode } from '../../domain/currency'
import { CONDITION_LABEL, GRADER_LABEL, ORIGIN_LABEL } from '../collection/labels'
import { CardImage } from '../catalog/CardImage'
import { Button, FormMessage, SelectField, TextField } from '../../ui/form'
import { ItemPicker } from './ItemPicker'

const CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseAmount(raw: string, currency: CurrencyCode): bigint {
  const trimmed = raw.trim().replace(',', '.')
  if (trimmed === '') return 0n
  return fromDecimalString(trimmed, currency).minorUnits
}

interface LotSelection {
  quantity: number
  unitGrossInput: string
}

interface ItemDraft {
  holdingId: string
  displayName: string
  subtitle: string
  imageBaseUrl: string | null
  /** null while the lots for this item are still loading. */
  lots: AcquisitionLot[] | null
  selections: Record<string, LotSelection>
}

function lotCostLabel(lot: AcquisitionLot): string {
  switch (lot.costBasisState) {
    case 'known':
      return lot.unitCostBasisMinor !== null
        ? `Cost ${toDecimalString({ minorUnits: lot.unitCostBasisMinor, currency: (lot.costBasisCurrency ?? 'NOK') as CurrencyCode })} ${lot.costBasisCurrency ?? 'NOK'} each`
        : 'Cost —'
    case 'unallocated_opening':
      return 'From an opening — no individual cost'
    case 'not_paid':
      return 'Gifted — no cost'
    case 'trade_in':
      return 'Traded in — no cost'
    default:
      return 'Cost unknown'
  }
}

/**
 * Record sale (UX_FLOWS.md F7/F8, FINANCIAL_MODEL.md §2.2/§4.5). Reached from the central + menu,
 * Portfolio's select mode ("Sell selected"), or a Holding Detail's "Sell" button — all three feed
 * the same `holdingIds` search param.
 *
 * Lot selection is always explicit (prompt §10-11): every open lot for an added item is shown with
 * its own quantity stepper, the FIFO-oldest lot is pre-filled as a quiet suggestion, and nothing is
 * saved until the caller has confirmed exactly which lots leave inventory.
 */
export function SaleFormPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = useSearch({ from: '/sales/new' })

  const [items, setItems] = useState<ItemDraft[]>([])
  const prefillStarted = useRef(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [soldOn, setSoldOn] = useState(today)
  const [marketplace, setMarketplace] = useState('')
  const [currency, setCurrency] = useState<CurrencyCode>('NOK')
  const [feesInput, setFeesInput] = useState('')
  const [shippingCostInput, setShippingCostInput] = useState('')
  const [shippingChargedInput, setShippingChargedInput] = useState('')
  const [notes, setNotes] = useState('')
  const [fxMode, setFxMode] = useState<'norges_bank' | 'manual'>('norges_bank')
  const [fxRate, setFxRate] = useState('')
  const [fxRateDate, setFxRateDate] = useState('')
  const [fxError, setFxError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  const holdingIds = useMemo(() => {
    const ids = new Set<string>()
    if (search.holdingId) ids.add(search.holdingId)
    for (const id of (search.holdingIds ?? '').split(',')) {
      if (id) ids.add(id)
    }
    return [...ids]
  }, [search.holdingId, search.holdingIds])

  // One-time prefill from the route's holdingId(s) — a bounded direct lookup, not a search. The
  // "already started" flag lives in a ref (never a setState call in the effect body itself,
  // react-hooks/set-state-in-effect) — only the eventual async result calls setState, inside .then.
  useEffect(() => {
    if (prefillStarted.current || holdingIds.length === 0) return
    prefillStarted.current = true
    let active = true
    void listPortfolio({ sort: 'name_asc', limit: 100 }).then((page) => {
      if (!active) return
      const byId = new Map(page.results.map((t) => [t.holdingId, t]))
      const found = holdingIds.map((id) => byId.get(id)).filter((t): t is PortfolioTile => !!t)
      setItems((current) => [
        ...current,
        ...found
          .filter((tile) => !current.some((i) => i.holdingId === tile.holdingId))
          .map((tile) => draftFromTile(tile)),
      ])
    })
    return () => {
      active = false
    }
  }, [holdingIds])

  const lotQueries = useQueries({
    queries: items.map((item) => ({
      queryKey: ['holding-lots', item.holdingId],
      queryFn: () => getHoldingLots(item.holdingId),
    })),
  })

  function addItem(tile: PortfolioTile) {
    setItems((current) => [...current, draftFromTile(tile)])
  }

  function removeItem(holdingId: string) {
    setItems((current) => current.filter((i) => i.holdingId !== holdingId))
  }

  function setLotQuantity(
    holdingId: string,
    lotId: string,
    quantity: number,
    defaultPrice: string,
  ) {
    setItems((current) =>
      current.map((item) => {
        if (item.holdingId !== holdingId) return item
        const existing = item.selections[lotId]
        return {
          ...item,
          selections: {
            ...item.selections,
            [lotId]: { quantity, unitGrossInput: existing?.unitGrossInput ?? defaultPrice },
          },
        }
      }),
    )
  }

  function setItemPrice(holdingId: string, price: string) {
    setItems((current) =>
      current.map((item) => {
        if (item.holdingId !== holdingId) return item
        const selections = Object.fromEntries(
          Object.entries(item.selections).map(([lotId, sel]) => [
            lotId,
            { ...sel, unitGrossInput: price },
          ]),
        )
        return { ...item, selections }
      }),
    )
  }

  // Flattened, quantity > 0 selections only — the actual sale lines.
  const activeLines = useMemo(() => {
    const lines: { holdingId: string; lotId: string; quantity: number; unitGrossInput: string }[] =
      []
    for (const item of items) {
      for (const [lotId, sel] of Object.entries(item.selections)) {
        if (sel.quantity > 0) {
          lines.push({
            holdingId: item.holdingId,
            lotId,
            quantity: sel.quantity,
            unitGrossInput: sel.unitGrossInput,
          })
        }
      }
    }
    return lines
  }, [items])

  const preview = useMemo(() => {
    try {
      const fees = parseAmount(feesInput, currency)
      const shippingCost = parseAmount(shippingCostInput, currency)
      const shippingCharged = parseAmount(shippingChargedInput, currency)
      const lineGross = activeLines.map(
        (l) => parseAmount(l.unitGrossInput || '0', currency) * BigInt(l.quantity),
      )
      const gross = lineGross.reduce((a, b) => a + b, 0n)
      const net = gross - fees - shippingCost + shippingCharged
      const allocFees = allocate(fees, lineGross)
      const allocShip = allocate(shippingCost, lineGross)
      const allocShipCharged = allocate(shippingCharged, lineGross)
      const lineNet = lineGross.map(
        (g, i) => g - (allocFees[i] ?? 0n) - (allocShip[i] ?? 0n) + (allocShipCharged[i] ?? 0n),
      )
      return { gross, fees, shippingCost, shippingCharged, net, lineNet }
    } catch {
      return null
    }
  }, [activeLines, feesInput, shippingCostInput, shippingChargedInput, currency])

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (activeLines.length === 0) {
        throw new Error('Choose at least one card and quantity to sell.')
      }
      const lineInputs: SaleLineInput[] = activeLines.map((l) => ({
        lotId: l.lotId,
        quantity: l.quantity,
        unitGrossMinor: parseAmount(l.unitGrossInput || '0', currency),
      }))

      let resolvedFxRate: string | undefined
      let resolvedFxDate: string | undefined
      if (currency !== 'NOK') {
        if (fxMode === 'manual') {
          if (!fxRate.trim()) throw new Error('Enter an exchange rate.')
          resolvedFxRate = fxRate.trim()
          resolvedFxDate = soldOn
        } else if (!fxRate) {
          const result = await fetchFxRate(currency, soldOn)
          setFxRate(result.rate)
          setFxRateDate(result.rateDate)
          resolvedFxRate = result.rate
          resolvedFxDate = result.rateDate
        } else {
          resolvedFxRate = fxRate
          resolvedFxDate = fxRateDate
        }
      }

      return createSale(
        lineInputs,
        {
          soldOn,
          currency,
          marketplace: marketplace || undefined,
          feesMinor: parseAmount(feesInput, currency),
          shippingCostMinor: parseAmount(shippingCostInput, currency),
          shippingChargedMinor: parseAmount(shippingChargedInput, currency),
          fxRateToNok: resolvedFxRate,
          fxRateDate: resolvedFxDate,
          fxSource: currency === 'NOK' ? undefined : fxMode,
          notes: notes || undefined,
        },
        idempotencyKey,
      )
    },
    onSuccess: async (sale) => {
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      await queryClient.invalidateQueries({ queryKey: ['sales'] })
      await queryClient.invalidateQueries({ queryKey: ['sales-summary'] })
      await navigate({
        to: '/sales/$saleId',
        params: { saleId: sale.id },
        search: { created: true },
      })
    },
    onError: (err: Error) => {
      if (err instanceof FxRateNotFoundError) {
        setFxError(err.message)
      } else {
        setError(err.message)
      }
    },
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-4 pb-24">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Record sale</h1>
        <p className="mt-1 text-sm text-slate-400">
          Sales reduce your Portfolio and preserve the exact acquisition cost of the cards sold.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Date"
          type="date"
          value={soldOn}
          max={today()}
          onChange={(event) => {
            setSoldOn(event.target.value)
            setFxRate('')
          }}
        />
        <SelectField
          label="Currency"
          value={currency}
          onChange={(event) => {
            setCurrency(event.target.value as CurrencyCode)
            setFxRate('')
          }}
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </SelectField>
      </div>

      <TextField
        label="Marketplace"
        value={marketplace}
        onChange={(event) => {
          setMarketplace(event.target.value)
        }}
        placeholder="Finn, Cardmarket, eBay…"
      />

      {currency !== 'NOK' ? (
        <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Exchange rate</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setFxMode('norges_bank')
              }}
              className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${fxMode === 'norges_bank' ? 'border-sky-500 bg-sky-600/20 text-sky-200' : 'border-slate-700 text-slate-300'}`}
            >
              Norges Bank
            </button>
            <button
              type="button"
              onClick={() => {
                setFxMode('manual')
              }}
              className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${fxMode === 'manual' ? 'border-sky-500 bg-sky-600/20 text-sky-200' : 'border-slate-700 text-slate-300'}`}
            >
              Manual rate
            </button>
          </div>
          {fxMode === 'manual' ? (
            <TextField
              label={`NOK per 1 ${currency}`}
              inputMode="decimal"
              value={fxRate}
              onChange={(event) => {
                setFxRate(event.target.value)
              }}
              placeholder="11.5400"
            />
          ) : (
            <p className="text-xs text-slate-400">
              {fxRate
                ? `${fxRate} NOK/${currency} · Norges Bank · ${fxRateDate}`
                : 'Rate will be fetched from Norges Bank when you save.'}
            </p>
          )}
          {fxError ? <FormMessage tone="error">{fxError}</FormMessage> : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-200">Items</h2>
        {items.map((item, index) => (
          <ItemLotSelector
            key={item.holdingId}
            item={item}
            lots={lotQueries[index]?.data ?? null}
            loading={lotQueries[index]?.isPending ?? true}
            onQuantityChange={(lotId, qty) => {
              setLotQuantity(item.holdingId, lotId, qty, firstPrice(item))
            }}
            onPriceChange={(price) => {
              setItemPrice(item.holdingId, price)
            }}
            onRemove={() => {
              removeItem(item.holdingId)
            }}
          />
        ))}
        <button
          type="button"
          onClick={() => {
            setPickerOpen(true)
          }}
          className="min-h-11 w-full rounded-lg border border-dashed border-slate-700 text-sm font-medium text-slate-300 hover:bg-slate-800/40"
        >
          + Add item
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TextField
          label="Fees"
          inputMode="decimal"
          value={feesInput}
          onChange={(event) => {
            setFeesInput(event.target.value)
          }}
          placeholder="0.00"
        />
        <TextField
          label="Your shipping cost"
          inputMode="decimal"
          value={shippingCostInput}
          onChange={(event) => {
            setShippingCostInput(event.target.value)
          }}
          placeholder="0.00"
        />
        <TextField
          label="Shipping paid by buyer"
          inputMode="decimal"
          value={shippingChargedInput}
          onChange={(event) => {
            setShippingChargedInput(event.target.value)
          }}
          placeholder="0.00"
        />
      </div>

      {preview ? (
        <div className="space-y-1 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 text-sm">
          <Row label="Gross sale price" value={preview.gross} currency={currency} />
          <Row label="Fees" value={-preview.fees} currency={currency} />
          <Row label="Your shipping cost" value={-preview.shippingCost} currency={currency} />
          <Row label="Shipping paid by buyer" value={preview.shippingCharged} currency={currency} />
          <div className="flex justify-between border-t border-slate-800 pt-2 font-semibold text-slate-100">
            <span>Net proceeds</span>
            <span>
              {toDecimalString({ minorUnits: preview.net, currency })} {currency}
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
        disabled={submitMutation.isPending}
        onClick={() => {
          setError(null)
          submitMutation.mutate()
        }}
      >
        {submitMutation.isPending ? 'Saving…' : 'Save sale'}
      </Button>

      <ItemPicker
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false)
        }}
        excludeHoldingIds={new Set(items.map((i) => i.holdingId))}
        onPick={(tile) => {
          setPickerOpen(false)
          addItem(tile)
        }}
      />
    </div>
  )
}

function draftFromTile(tile: PortfolioTile): ItemDraft {
  return {
    holdingId: tile.holdingId,
    displayName: portfolioDisplayName(tile),
    subtitle: `${portfolioSubtitle(tile)}${tile.condition ? ` · ${CONDITION_LABEL[tile.condition]}` : ''}${tile.grader ? ` · ${GRADER_LABEL[tile.grader]} ${tile.grade ?? ''}` : ''}`,
    imageBaseUrl: tile.cardImageBaseUrl,
    lots: null,
    selections: {},
  }
}

function firstPrice(item: ItemDraft): string {
  const anySelection = Object.values(item.selections).find((s) => s.unitGrossInput)
  return anySelection?.unitGrossInput ?? ''
}

function Row({ label, value, currency }: { label: string; value: bigint; currency: CurrencyCode }) {
  return (
    <div className="flex justify-between text-slate-300">
      <span>{label}</span>
      <span>
        {toDecimalString({ minorUnits: value, currency })} {currency}
      </span>
    </div>
  )
}

function ItemLotSelector({
  item,
  lots,
  loading,
  onQuantityChange,
  onPriceChange,
  onRemove,
}: {
  item: ItemDraft
  lots: AcquisitionLot[] | null
  loading: boolean
  onQuantityChange: (lotId: string, quantity: number) => void
  onPriceChange: (price: string) => void
  onRemove: () => void
}) {
  const openLots = useMemo(() => {
    const open = (lots ?? []).filter((l) => !l.voidedAt && l.quantityRemaining > 0)
    return suggestFifoOrder(open)
  }, [lots])

  const price = firstPrice(item)
  const totalSelected = Object.values(item.selections).reduce((sum, s) => sum + s.quantity, 0)

  return (
    <div className="space-y-2 rounded-2xl border border-slate-800 p-3">
      <div className="flex items-center gap-3">
        <CardImage
          imageBaseUrl={item.imageBaseUrl}
          alt={item.displayName}
          quality="low"
          className="h-14 w-10 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-100">{item.displayName}</p>
          <p className="truncate text-xs text-slate-500">{item.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-xs text-rose-300 hover:underline"
        >
          Remove
        </button>
      </div>

      {loading ? (
        <div className="h-16 animate-pulse rounded-lg bg-slate-800/60" />
      ) : openLots.length === 0 ? (
        <p className="text-xs text-slate-500">No open lots remain for this holding.</p>
      ) : (
        <div className="space-y-1.5">
          {openLots.map((lot, index) => (
            <div
              key={lot.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <p className="text-slate-200">
                  {lot.acquiredOn} · {lot.quantityRemaining} available
                  {index === 0 ? (
                    <span className="ml-1 text-sky-400">Suggested: oldest acquired first</span>
                  ) : null}
                </p>
                <p className="text-slate-500">
                  {ORIGIN_LABEL[lot.origin]} · {lotCostLabel(lot)}
                  {lot.storageLocationName ? ` · ${lot.storageLocationName}` : ''}
                </p>
              </div>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={lot.quantityRemaining}
                value={item.selections[lot.id]?.quantity ?? 0}
                onChange={(event) => {
                  const raw = Number.parseInt(event.target.value, 10)
                  const clamped = Number.isFinite(raw)
                    ? Math.max(0, Math.min(raw, lot.quantityRemaining))
                    : 0
                  onQuantityChange(lot.id, clamped)
                }}
                className="w-14 shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center text-slate-100 outline-none focus-visible:border-sky-500"
              />
            </div>
          ))}
        </div>
      )}

      {totalSelected > 0 ? (
        <TextField
          label="Sale price per unit"
          inputMode="decimal"
          value={price}
          onChange={(event) => {
            onPriceChange(event.target.value)
          }}
          placeholder="0.00"
        />
      ) : null}
    </div>
  )
}
