import { useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createManualCard } from '../../data/collection'
import { createPurchase, type PurchaseLineInput } from '../../data/purchases'
import { createRetailer, listRetailers } from '../../data/retailers'
import { fetchFxRate, FxRateNotFoundError } from '../../data/fx'
import { fromDecimalString, toDecimalString } from '../../domain/money'
import { allocate } from '../../domain/allocation'
import type { CurrencyCode } from '../../domain/currency'
import { Button, FormMessage, SelectField, TextField } from '../../ui/form'
import { LineEditorRow } from './LineEditor'
import { LINE_TYPE_LABEL } from './labels'
import { at } from './util'
import { useUnsavedWorkSnapshot } from '../../platform/unsaved-work-registry'
import { localTodayIso } from '../../platform/local-date'
import {
  addPurchaseLine,
  createInitialPurchaseFormFields,
  patchPurchaseFormFields,
  removePurchaseLine,
  updatePurchaseLine,
} from './purchase-form-state'

const CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

const today = localTodayIso

/** Parses a decimal charge/price field; blank means zero, never a fabricated amount. */
function parseAmount(raw: string, currency: CurrencyCode): bigint {
  const trimmed = raw.trim().replace(',', '.')
  if (trimmed === '') return 0n
  return fromDecimalString(trimmed, currency).minorUnits
}

interface LinePreview {
  label: string
  lineTotal: bigint
  allocatedShipping: bigint
  allocatedCustoms: bigint
  allocatedDiscount: bigint
  attributable: bigint
}

/**
 * New multi-line purchase (UX_FLOWS.md F3, M8 prompt §18-21). The live allocation preview
 * (§36) uses the exact same `allocate()` domain function the create_purchase RPC's SQL port
 * reproduces — see tests/db/m8_purchase_ledger.test.ts for the parity proof between the two.
 */
export function PurchaseFormPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // P124: every field that names one Purchase Add attempt now lives in `fields`, a single object
  // produced and reset by purchase-form-state.ts — see that module's header for why Purchase Add
  // (unlike Sale Add) has no EntityKeyChangeTracker: /purchases/new has no URL-driven entity
  // identity to switch between mid-mount.
  const [fields, setFields] = useState(() => createInitialPurchaseFormFields(today))
  const {
    purchasedOn,
    retailerId,
    newRetailerName,
    currency,
    lines,
    shippingInput,
    customsInput,
    discountInput,
    notes,
    fxMode,
    fxRate,
    fxRateDate,
    fxError,
    error,
    idempotencyKey,
  } = fields

  /** Shallow-merges `patch` into the current fields. Never used for `lines` (those go through
   *  the dedicated line helpers, which need the current array to map/filter). */
  function patch(update: Partial<typeof fields>) {
    setFields((current) => patchPurchaseFormFields(current, update))
  }

  // F-40 (P89): registers this form's own dirty-by-diff state (see unsaved-work-registry.ts) so
  // an app-wide automatic reload (stale deployment / new chunk) never silently discards typed-
  // but-unsubmitted purchase input the way it used to for every route except Scanner.
  useUnsavedWorkSnapshot('purchase-form', {
    purchasedOn,
    retailerId,
    newRetailerName,
    currency,
    lines,
    shippingInput,
    customsInput,
    discountInput,
    notes,
    fxMode,
    fxRate,
  })

  // P130-05: a manual card line's definition must be created AT MOST ONCE per logical purchase
  // attempt, not once per submit attempt. Before this cache existed, a retry after a lost response
  // (the same failure mode idempotencyKey exists to survive) called createManualCard again with a
  // fresh row before ever reaching create_purchase's idempotent boundary — the second attempt's
  // p_idempotency_key matched the first, but its manual_card_id didn't, so the server correctly
  // refused it as idempotency-key-reuse, leaving the first manual card orphaned from any purchase
  // still visible to the user as a raw error. Keyed by `${line.id}:${name}` (not by line id alone)
  // so a genuine identity change — the user editing the manual card's name before retrying — still
  // resolves a new id rather than silently reusing a stale one; mirrors
  // OpeningsWizardPage's `resolvedManualCards` (P56 §10).
  const resolvedManualCards = useRef(new Map<string, string>())

  const retailers = useQuery({ queryKey: ['retailers'], queryFn: listRetailers })

  const createRetailerMutation = useMutation({
    mutationFn: (name: string) => createRetailer(name),
    onSuccess: async (retailer) => {
      await queryClient.invalidateQueries({ queryKey: ['retailers'] })
      patch({ retailerId: retailer.id, newRetailerName: '' })
    },
  })

  const fxQuery = useMutation({
    mutationFn: () => fetchFxRate(currency as Exclude<CurrencyCode, 'NOK'>, purchasedOn),
    onSuccess: (result) => {
      patch({ fxRate: result.rate, fxRateDate: result.rateDate, fxError: null })
    },
    onError: (err: Error) => {
      patch({
        fxError:
          err instanceof FxRateNotFoundError
            ? err.message
            : 'Could not reach Norges Bank. Enter a rate manually.',
      })
    },
  })

  const preview = useMemo<{
    lines: LinePreview[]
    shipping: bigint
    customs: bigint
    discount: bigint
    total: bigint
  } | null>(() => {
    try {
      const shipping = parseAmount(shippingInput, currency)
      const customs = parseAmount(customsInput, currency)
      const discount = parseAmount(discountInput, currency)
      const lineTotals = lines.map((line) => {
        const qty = BigInt(Math.max(1, Number.parseInt(line.quantity || '1', 10)))
        const unit = parseAmount(line.unitPrice, currency)
        return unit * qty
      })
      const weights = lineTotals
      const allocShip = allocate(shipping, weights)
      const allocCustoms = allocate(customs, weights)
      const allocDiscount = allocate(discount, weights)
      const previews = lines.map((line, index) => {
        const lineTotal = at(lineTotals, index)
        const allocatedShipping = at(allocShip, index)
        const allocatedCustoms = at(allocCustoms, index)
        const allocatedDiscount = at(allocDiscount, index)
        return {
          label:
            line.cardDisplayName ||
            line.manualCardName ||
            line.sealedProductDisplayName ||
            line.description ||
            LINE_TYPE_LABEL[line.lineType],
          lineTotal,
          allocatedShipping,
          allocatedCustoms,
          allocatedDiscount,
          attributable: lineTotal + allocatedShipping + allocatedCustoms - allocatedDiscount,
        }
      })
      const subtotal = lineTotals.reduce((a, b) => a + b, 0n)
      const total = subtotal + shipping + customs - discount
      return { lines: previews, shipping, customs, discount, total }
    } catch {
      return null
    }
  }, [lines, shippingInput, customsInput, discountInput, currency])

  const submitMutation = useMutation({
    mutationFn: async () => {
      const lineInputs: PurchaseLineInput[] = []
      for (const draft of lines) {
        const quantity = Number.parseInt(draft.quantity, 10)
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new Error('Every line needs a positive quantity.')
        }
        const unitPriceMinor = fromDecimalString(draft.unitPrice || '0', currency).minorUnits
        if (unitPriceMinor < 0n) throw new Error('Unit price cannot be negative.')

        let manualCardId: string | undefined
        if (draft.lineType === 'card' && draft.cardMode === 'manual') {
          const trimmedName = draft.manualCardName.trim()
          if (!trimmedName) throw new Error('Enter a name for the manual card.')
          const cacheKey = `${draft.id}:${trimmedName}`
          const cached = resolvedManualCards.current.get(cacheKey)
          if (cached) {
            manualCardId = cached
          } else {
            const created = await createManualCard({ name: trimmedName })
            manualCardId = created.id
            resolvedManualCards.current.set(cacheKey, manualCardId)
          }
        }
        if (draft.lineType === 'card' && draft.cardMode === 'catalog' && !draft.cardVariantId) {
          throw new Error('Choose a card from the catalog, or switch to manual entry.')
        }
        if (draft.lineType === 'sealed' && !draft.sealedProductId) {
          throw new Error('Choose a sealed product.')
        }

        lineInputs.push({
          lineType: draft.lineType,
          description: draft.description || undefined,
          cardVariantId:
            draft.cardMode === 'catalog' ? (draft.cardVariantId ?? undefined) : undefined,
          manualCardId,
          sealedProductId: draft.sealedProductId ?? undefined,
          sealedIntent: draft.lineType === 'sealed' ? draft.sealedIntent : undefined,
          condition:
            draft.lineType === 'card' && draft.gradingState === 'raw' ? draft.condition : undefined,
          gradingState: draft.lineType === 'card' ? draft.gradingState : undefined,
          grader:
            draft.lineType === 'card' && draft.gradingState === 'graded' ? draft.grader : undefined,
          grade:
            draft.lineType === 'card' && draft.gradingState === 'graded' && draft.grade
              ? Number(draft.grade)
              : undefined,
          certNumber:
            draft.lineType === 'card' && draft.gradingState === 'graded'
              ? draft.certNumber || undefined
              : undefined,
          quantity,
          unitPriceMinor,
          spendClass: draft.spendClassOverride || undefined,
          storageLocationId: draft.storageLocationId || undefined,
          isFavorite: draft.isFavorite,
          manualValueMinor:
            draft.lineType === 'card' && draft.gradingState === 'graded' && draft.manualValue
              ? fromDecimalString(draft.manualValue, 'NOK').minorUnits
              : undefined,
        })
      }

      let resolvedFxRate: string | undefined
      let resolvedFxDate: string | undefined
      if (currency !== 'NOK') {
        if (fxMode === 'manual') {
          if (!fxRate.trim()) throw new Error('Enter an exchange rate.')
          resolvedFxRate = fxRate.trim()
          resolvedFxDate = purchasedOn
        } else {
          if (!fxRate) {
            const result = await fetchFxRate(currency, purchasedOn)
            patch({ fxRate: result.rate, fxRateDate: result.rateDate })
            resolvedFxRate = result.rate
            resolvedFxDate = result.rateDate
          } else {
            resolvedFxRate = fxRate
            resolvedFxDate = fxRateDate
          }
        }
      }

      return createPurchase(
        {
          purchasedOn,
          currency,
          lines: lineInputs,
          retailerId: retailerId || undefined,
          shippingMinor: parseAmount(shippingInput, currency),
          customsMinor: parseAmount(customsInput, currency),
          discountMinor: parseAmount(discountInput, currency),
          fxRateToNok: resolvedFxRate,
          fxRateDate: resolvedFxDate,
          fxSource: currency === 'NOK' ? undefined : fxMode,
          notes: notes || undefined,
        },
        idempotencyKey,
      )
    },
    onSuccess: async (purchase) => {
      await queryClient.invalidateQueries({ queryKey: ['purchases'] })
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      // A purchase changes ownership and the ledger Home's live figures are derived from.
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      await navigate({
        to: '/purchases/$purchaseId',
        params: { purchaseId: purchase.id },
        search: { created: true },
      })
    },
    onError: (err: Error) => {
      patch({ error: err.message })
    },
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-4 pb-24">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Record purchase</h1>
        <p className="mt-1 text-sm text-slate-400">
          Record the items from one receipt. Shipping, customs and discounts are allocated
          automatically across every line.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Date"
          type="date"
          value={purchasedOn}
          max={today()}
          onChange={(event) => {
            patch({ purchasedOn: event.target.value, fxRate: '' })
          }}
        />
        <SelectField
          label="Currency"
          value={currency}
          onChange={(event) => {
            patch({ currency: event.target.value as CurrencyCode, fxRate: '' })
          }}
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="space-y-2">
        <SelectField
          label="Retailer"
          value={retailerId}
          onChange={(event) => {
            patch({ retailerId: event.target.value })
          }}
        >
          <option value="">No retailer</option>
          {(retailers.data ?? []).map((retailer) => (
            <option key={retailer.id} value={retailer.id}>
              {retailer.name}
            </option>
          ))}
        </SelectField>
        <div className="flex gap-2">
          <input
            value={newRetailerName}
            onChange={(event) => {
              patch({ newRetailerName: event.target.value })
            }}
            placeholder="Add a new retailer"
            aria-label="Add a new retailer"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
          />
          <button
            type="button"
            disabled={!newRetailerName.trim() || createRetailerMutation.isPending}
            onClick={() => {
              createRetailerMutation.mutate(newRetailerName.trim())
            }}
            className="shrink-0 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      {currency !== 'NOK' ? (
        <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Exchange rate</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                patch({ fxMode: 'norges_bank' })
                fxQuery.mutate()
              }}
              className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${fxMode === 'norges_bank' ? 'border-sky-500 bg-sky-600/20 text-slate-200' : 'border-slate-700 text-slate-300'}`}
            >
              Norges Bank
            </button>
            <button
              type="button"
              onClick={() => {
                patch({ fxMode: 'manual' })
              }}
              className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${fxMode === 'manual' ? 'border-sky-500 bg-sky-600/20 text-slate-200' : 'border-slate-700 text-slate-300'}`}
            >
              Manual rate
            </button>
          </div>
          {fxMode === 'norges_bank' ? (
            <p className="text-xs text-slate-400">
              {fxQuery.isPending
                ? 'Fetching…'
                : fxRate
                  ? `${fxRate} NOK/${currency} · Norges Bank · ${fxRateDate}`
                  : 'Rate will be fetched from Norges Bank when you save.'}
            </p>
          ) : (
            <TextField
              label={`NOK per 1 ${currency}`}
              inputMode="decimal"
              value={fxRate}
              onChange={(event) => {
                patch({ fxRate: event.target.value })
              }}
              placeholder="11.5400"
            />
          )}
          {fxError ? <FormMessage tone="error">{fxError}</FormMessage> : null}
        </div>
      ) : null}

      <div className="space-y-3">
        {lines.map((line, index) => (
          <LineEditorRow
            key={line.id}
            draft={line}
            index={index}
            canRemove={lines.length > 1}
            onChange={(linePatch) => {
              setFields((current) => updatePurchaseLine(current, line.id, linePatch))
            }}
            onRemove={() => {
              setFields((current) => removePurchaseLine(current, line.id))
            }}
          />
        ))}
        <button
          type="button"
          onClick={() => {
            setFields((current) => addPurchaseLine(current))
          }}
          className="min-h-11 w-full rounded-lg border border-dashed border-slate-700 text-sm font-medium text-slate-300 hover:bg-slate-800/40"
        >
          + Add line
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TextField
          label="Shipping"
          inputMode="decimal"
          value={shippingInput}
          onChange={(event) => {
            patch({ shippingInput: event.target.value })
          }}
          placeholder="0.00"
        />
        <TextField
          label="Customs"
          inputMode="decimal"
          value={customsInput}
          onChange={(event) => {
            patch({ customsInput: event.target.value })
          }}
          placeholder="0.00"
        />
        <TextField
          label="Discount"
          inputMode="decimal"
          value={discountInput}
          onChange={(event) => {
            patch({ discountInput: event.target.value })
          }}
          placeholder="0.00"
        />
      </div>

      {preview ? (
        <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Allocation preview</p>
          <ul className="space-y-1 text-xs text-slate-400">
            {preview.lines.map((line, index) => (
              <li key={index} className="flex justify-between gap-2">
                <span className="truncate">{line.label || `Line ${index + 1}`}</span>
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
        <label htmlFor="purchase-notes" className="block text-sm font-medium text-slate-300">
          Notes
        </label>
        <textarea
          id="purchase-notes"
          value={notes}
          onChange={(event) => {
            patch({ notes: event.target.value })
          }}
          rows={2}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
        />
      </div>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      <Button
        disabled={submitMutation.isPending}
        onClick={() => {
          patch({ error: null })
          submitMutation.mutate()
        }}
      >
        {submitMutation.isPending ? 'Saving…' : 'Save purchase'}
      </Button>
    </div>
  )
}
