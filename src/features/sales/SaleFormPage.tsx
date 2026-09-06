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
import { KeyedPrefillGuard } from './keyed-prefill-guard'
import {
  createInitialSaleFormFields,
  EntityKeyChangeTracker,
  type ItemDraft,
  type SaleFormFields,
} from './sale-form-state'
import { useUnsavedWorkSnapshot } from '../../platform/unsaved-work-registry'

const CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseAmount(raw: string, currency: CurrencyCode): bigint {
  const trimmed = raw.trim().replace(',', '.')
  if (trimmed === '') return 0n
  return fromDecimalString(trimmed, currency).minorUnits
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

  // P109: every submission-bound field lives in ONE state object, reset atomically by
  // `createInitialSaleFormFields()` on mount and on every genuine entity change (see the
  // `entityTrackerRef` effect below) — see `sale-form-state.ts`'s own doc for why this replaced
  // twelve separate `useState`s each only ever cleared for `items`.
  const [fields, setFields] = useState<SaleFormFields>(() => createInitialSaleFormFields())
  const [pickerOpen, setPickerOpen] = useState(false)

  /** Shallow-merges `patch` into the current fields. Never used for `items` (which needs the
   *  current array to filter/map) — those call `setFields` directly with a full updater. */
  function patchFields(patch: Partial<SaleFormFields>) {
    setFields((current) => ({ ...current, ...patch }))
  }

  const holdingIds = useMemo(() => {
    const ids = new Set<string>()
    if (search.holdingId) ids.add(search.holdingId)
    for (const id of (search.holdingIds ?? '').split(',')) {
      if (id) ids.add(id)
    }
    return [...ids]
  }, [search.holdingId, search.holdingIds])
  // P98 cross-holding fix: a stable identity for "which holdingIds set is this render for" —
  // used both to guard the prefill effect below against a same-instance navigation that changes
  // holdingIds (no `remountDeps` on `/sales/new`) and to derive `prefillReady` without a
  // synchronous setState in the effect body.
  const prefillKey = holdingIds.join(',')

  // N-14 (P94): the dirty-by-diff baseline must not be captured until the async holdingId(s)
  // prefill below has resolved (or there is none to wait for) — see useIsDirtyByDiff's own doc.
  // P98: `prefillCompletedKey` records which holdingIds set the LAST successfully-applied prefill
  // was for — `prefillReady` is derived from comparing it against the CURRENT `prefillKey`, so a
  // holdingIds change (same component instance) makes `prefillReady` false again immediately
  // (during render, no effect tick needed) until the NEW set's own prefill actually completes.
  // Nothing here is a synchronous setState call in an effect body (react-hooks/set-state-in-effect
  // stays satisfied) — every setter below fires only inside an async .then()/.finally().
  const [prefillCompletedKey, setPrefillCompletedKey] = useState<string | null>(null)
  const prefillReady = holdingIds.length === 0 || prefillCompletedKey === prefillKey

  // F-40 (P89): see PurchaseFormPage's identical registration for why.
  // D-110 residual fix: `resetKey=prefillKey` so a same-instance navigation to a DIFFERENT
  // holdingIds set discards the previous holding's dirty-diff baseline immediately (not just its
  // `prefillReady` gate) — without this, a holding whose prefill had already completed BEFORE the
  // navigation left its baseline locked in, and the next holding's own prefill would register as
  // a false "unsaved changes" against stale data the user never edited. See
  // useIsDirtyByDiff's own doc for the general mechanism.
  useUnsavedWorkSnapshot(
    'sale-form',
    {
      items: fields.items,
      soldOn: fields.soldOn,
      marketplace: fields.marketplace,
      currency: fields.currency,
      feesInput: fields.feesInput,
      shippingCostInput: fields.shippingCostInput,
      shippingChargedInput: fields.shippingChargedInput,
      notes: fields.notes,
      fxMode: fields.fxMode,
      fxRate: fields.fxRate,
    },
    prefillReady,
    prefillKey,
  )

  // P109: detects a genuine `prefillKey` transition (A -> B) independently of the prefill fetch
  // itself — see `EntityKeyChangeTracker`'s own doc for why this is a separate concern from
  // `KeyedPrefillGuard` below. `generation()` is also read at submit time (see `submitMutation`)
  // so a response for an entity the user has since navigated away from can be recognized as stale
  // and never mutate what is now on screen.
  const entityTrackerRef = useRef(new EntityKeyChangeTracker())

  // Prefill from the route's holdingId(s) — a bounded direct lookup, not a search. Runs once per
  // DISTINCT `prefillKey` (`KeyedPrefillGuard`, never a setState call in the effect body itself,
  // react-hooks/set-state-in-effect; every setter below fires only inside .then()/.finally()), and
  // re-runs for real when `prefillKey` genuinely changes.
  //
  // P94 (found via the new authenticated-E2E infrastructure, docs/TESTING.md §6b): this effect
  // used to ALSO track a per-instance `active` closure flag, set false by the effect's own
  // cleanup, and discarded the fetch's result entirely once `active` was false. Under React
  // StrictMode's real dev-mode double-invoke (mount, synthetic unmount, remount), that fought the
  // "already started" ref guard and left `prefillReady` stuck false forever. Fixed by removing
  // `active` — a fetch's result reaching an unmounted-for-real component is harmless in React 18+
  // (setState on an unmounted component is a silent no-op, not a warning).
  //
  // P98 (confirmed via adversarial audit, not test-discovered): the "already started" guard above
  // was a PERMANENT ref latch (`prefillStarted.current`, set once and never reset) keyed on
  // nothing — a same-component-instance navigation that changed `holdingIds` (no `remountDeps` on
  // `/sales/new`; e.g. browser back/forward landing on a different holding's sale-add URL)
  // re-fired this effect, which then silently no-opped forever (the OLD holding's fetch, if still
  // in flight, unconditionally appended its line items into whatever form was now on screen for
  // the NEW holding once it resolved — a genuine cross-entity data leak — while the NEW holding's
  // own prefill never ran at all). Fixed with explicit identity/generation semantics, matching the
  // pattern `ScannerPage.tsx`'s `analyzeCapture` already uses, extracted as `KeyedPrefillGuard`
  // (`./keyed-prefill-guard.ts`) so its semantics are directly unit-testable — no React
  // component-rendering infrastructure exists in this project. `begin(key)` guards per-KEY (so a
  // genuine `holdingIds` change starts a fresh fetch instead of no-opping forever, but the SAME
  // key — StrictMode's synthetic re-invoke — still only starts one real request); `isCurrent()` is
  // checked before every `.then()`/`.finally()` state update — a fetch whose generation no longer
  // matches the current one (a newer `holdingIds` change superseded it) touches neither `items`
  // nor `prefillCompletedKey`, so a late-arriving OLD holding's result can never leak into a NEW
  // holding's form, and the new holding's own baseline is captured only once ITS OWN prefill
  // actually completes (see `prefillReady`'s derivation above) rather than inheriting an earlier,
  // now-irrelevant "ready" state.
  const prefillGuardRef = useRef(new KeyedPrefillGuard())
  useEffect(() => {
    // P109: a genuine `prefillKey` transition means the user is now recording a sale for a
    // DIFFERENT holding set — every submission-bound field from the OLD target (fees, shipping,
    // currency, FX, date, marketplace, notes, validation state, the idempotency key — not just
    // `items`) is reset to fresh defaults SYNCHRONOUSLY here, before this same effect starts the
    // new key's own fetch below, so the old target's values are never on screen for the new one
    // even for a single tick.
    if (entityTrackerRef.current.observe(prefillKey)) {
      setFields(createInitialSaleFormFields())
    }
    if (holdingIds.length === 0) return // nothing to fetch; prefillReady already derives true
    const generation = prefillGuardRef.current.begin(prefillKey)
    if (generation === null) return // same key already started/completed
    listPortfolio({ sort: 'name_asc', limit: 100 })
      .then((page) => {
        if (!prefillGuardRef.current.isCurrent(generation)) return
        const byId = new Map(page.results.map((t) => [t.holdingId, t]))
        const found = holdingIds.map((id) => byId.get(id)).filter((t): t is PortfolioTile => !!t)
        setFields((current) => ({
          ...current,
          items: [
            ...current.items,
            ...found
              .filter((tile) => !current.items.some((i) => i.holdingId === tile.holdingId))
              .map((tile) => draftFromTile(tile)),
          ],
        }))
      })
      .catch(() => {
        // A failed prefill must not leave prefillReady stuck at false forever — that would mean
        // NO future edit is ever recognized as dirty either (N-14). Proceed with whatever items
        // exist right now (already cleared above if the key changed) as the real baseline.
      })
      .finally(() => {
        if (!prefillGuardRef.current.isCurrent(generation)) return
        setPrefillCompletedKey(prefillKey)
      })
  }, [holdingIds, prefillKey])

  const lotQueries = useQueries({
    queries: fields.items.map((item) => ({
      queryKey: ['holding-lots', item.holdingId],
      queryFn: () => getHoldingLots(item.holdingId),
    })),
  })

  function addItem(tile: PortfolioTile) {
    setFields((current) => ({ ...current, items: [...current.items, draftFromTile(tile)] }))
  }

  function removeItem(holdingId: string) {
    setFields((current) => ({
      ...current,
      items: current.items.filter((i) => i.holdingId !== holdingId),
    }))
  }

  function setLotQuantity(
    holdingId: string,
    lotId: string,
    quantity: number,
    defaultPrice: string,
  ) {
    setFields((current) => ({
      ...current,
      items: current.items.map((item) => {
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
    }))
  }

  function setItemPrice(holdingId: string, price: string) {
    setFields((current) => ({
      ...current,
      items: current.items.map((item) => {
        if (item.holdingId !== holdingId) return item
        const selections = Object.fromEntries(
          Object.entries(item.selections).map(([lotId, sel]) => [
            lotId,
            { ...sel, unitGrossInput: price },
          ]),
        )
        return { ...item, selections }
      }),
    }))
  }

  // Flattened, quantity > 0 selections only — the actual sale lines.
  const activeLines = useMemo(() => {
    const lines: { holdingId: string; lotId: string; quantity: number; unitGrossInput: string }[] =
      []
    for (const item of fields.items) {
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
  }, [fields.items])

  const preview = useMemo(() => {
    try {
      const fees = parseAmount(fields.feesInput, fields.currency)
      const shippingCost = parseAmount(fields.shippingCostInput, fields.currency)
      const shippingCharged = parseAmount(fields.shippingChargedInput, fields.currency)
      const lineGross = activeLines.map(
        (l) => parseAmount(l.unitGrossInput || '0', fields.currency) * BigInt(l.quantity),
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
  }, [
    activeLines,
    fields.feesInput,
    fields.shippingCostInput,
    fields.shippingChargedInput,
    fields.currency,
  ])

  // P109 (§11): a submission carries the entity generation it was started for. If the user
  // switches to a different holding set (same component instance) WHILE the submit is in flight,
  // the response — success or failure — must not mutate the DIFFERENT entity now on screen. The
  // server-side effect already happened (or didn't); this only guards the frontend's reaction to
  // it. Global cache invalidation still runs unconditionally on success — a real sale changing
  // Portfolio/Sales/Home figures is correct regardless of which local form is currently open.
  const submitMutation = useMutation({
    mutationFn: async (submissionGeneration: number) => {
      if (activeLines.length === 0) {
        throw new Error('Choose at least one card and quantity to sell.')
      }
      const lineInputs: SaleLineInput[] = activeLines.map((l) => ({
        lotId: l.lotId,
        quantity: l.quantity,
        unitGrossMinor: parseAmount(l.unitGrossInput || '0', fields.currency),
      }))

      let resolvedFxRate: string | undefined
      let resolvedFxDate: string | undefined
      if (fields.currency !== 'NOK') {
        if (fields.fxMode === 'manual') {
          if (!fields.fxRate.trim()) throw new Error('Enter an exchange rate.')
          resolvedFxRate = fields.fxRate.trim()
          resolvedFxDate = fields.soldOn
        } else if (!fields.fxRate) {
          const result = await fetchFxRate(fields.currency, fields.soldOn)
          resolvedFxRate = result.rate
          resolvedFxDate = result.rateDate
          // Only reflect the fetched rate back into the visible form if the user is still on the
          // SAME entity this fetch was started for — otherwise this would silently leak the OLD
          // entity's rate into whatever the user has since switched to.
          if (entityTrackerRef.current.generation() === submissionGeneration) {
            patchFields({ fxRate: result.rate, fxRateDate: result.rateDate })
          }
        } else {
          resolvedFxRate = fields.fxRate
          resolvedFxDate = fields.fxRateDate
        }
      }

      const sale = await createSale(
        lineInputs,
        {
          soldOn: fields.soldOn,
          currency: fields.currency,
          marketplace: fields.marketplace || undefined,
          feesMinor: parseAmount(fields.feesInput, fields.currency),
          shippingCostMinor: parseAmount(fields.shippingCostInput, fields.currency),
          shippingChargedMinor: parseAmount(fields.shippingChargedInput, fields.currency),
          fxRateToNok: resolvedFxRate,
          fxRateDate: resolvedFxDate,
          fxSource: fields.currency === 'NOK' ? undefined : fields.fxMode,
          notes: fields.notes || undefined,
        },
        fields.idempotencyKey,
      )
      return { sale, submissionGeneration }
    },
    onSuccess: async ({ sale, submissionGeneration }) => {
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      await queryClient.invalidateQueries({ queryKey: ['sales'] })
      await queryClient.invalidateQueries({ queryKey: ['sales-summary'] })
      // A sale changes ownership and proceeds behind Home's live figures.
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      // Stale: the user has since switched to a different entity — do not navigate them away
      // from what they are now doing because an earlier submission finally completed.
      if (entityTrackerRef.current.generation() !== submissionGeneration) return
      await navigate({
        to: '/sales/$saleId',
        params: { saleId: sale.id },
        search: { created: true },
      })
    },
    onError: (err: Error, submissionGeneration) => {
      // Stale: do not surface an old entity's error banner over whatever the user is now editing.
      if (entityTrackerRef.current.generation() !== submissionGeneration) return
      if (err instanceof FxRateNotFoundError) {
        patchFields({ fxError: err.message })
      } else {
        patchFields({ error: err.message })
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
          value={fields.soldOn}
          max={today()}
          onChange={(event) => {
            patchFields({ soldOn: event.target.value, fxRate: '' })
          }}
        />
        <SelectField
          label="Currency"
          value={fields.currency}
          onChange={(event) => {
            patchFields({ currency: event.target.value as CurrencyCode, fxRate: '' })
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
        value={fields.marketplace}
        onChange={(event) => {
          patchFields({ marketplace: event.target.value })
        }}
        placeholder="Finn, Cardmarket, eBay…"
      />

      {fields.currency !== 'NOK' ? (
        <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Exchange rate</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                patchFields({ fxMode: 'norges_bank' })
              }}
              className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${fields.fxMode === 'norges_bank' ? 'border-sky-500 bg-sky-600/20 text-slate-200' : 'border-slate-700 text-slate-300'}`}
            >
              Norges Bank
            </button>
            <button
              type="button"
              onClick={() => {
                patchFields({ fxMode: 'manual' })
              }}
              className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${fields.fxMode === 'manual' ? 'border-sky-500 bg-sky-600/20 text-slate-200' : 'border-slate-700 text-slate-300'}`}
            >
              Manual rate
            </button>
          </div>
          {fields.fxMode === 'manual' ? (
            <TextField
              label={`NOK per 1 ${fields.currency}`}
              inputMode="decimal"
              value={fields.fxRate}
              onChange={(event) => {
                patchFields({ fxRate: event.target.value })
              }}
              placeholder="11.5400"
            />
          ) : (
            <p className="text-xs text-slate-400">
              {fields.fxRate
                ? `${fields.fxRate} NOK/${fields.currency} · Norges Bank · ${fields.fxRateDate}`
                : 'Rate will be fetched from Norges Bank when you save.'}
            </p>
          )}
          {fields.fxError ? <FormMessage tone="error">{fields.fxError}</FormMessage> : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-200">Items</h2>
        {fields.items.map((item, index) => (
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
          value={fields.feesInput}
          onChange={(event) => {
            patchFields({ feesInput: event.target.value })
          }}
          placeholder="0.00"
        />
        <TextField
          label="Your shipping cost"
          inputMode="decimal"
          value={fields.shippingCostInput}
          onChange={(event) => {
            patchFields({ shippingCostInput: event.target.value })
          }}
          placeholder="0.00"
        />
        <TextField
          label="Shipping paid by buyer"
          inputMode="decimal"
          value={fields.shippingChargedInput}
          onChange={(event) => {
            patchFields({ shippingChargedInput: event.target.value })
          }}
          placeholder="0.00"
        />
      </div>

      {preview ? (
        <div className="space-y-1 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 text-sm">
          <Row label="Gross sale price" value={preview.gross} currency={fields.currency} />
          <Row label="Fees" value={-preview.fees} currency={fields.currency} />
          <Row
            label="Your shipping cost"
            value={-preview.shippingCost}
            currency={fields.currency}
          />
          <Row
            label="Shipping paid by buyer"
            value={preview.shippingCharged}
            currency={fields.currency}
          />
          <div className="flex justify-between border-t border-slate-800 pt-2 font-semibold text-slate-100">
            <span>Net proceeds</span>
            <span>
              {toDecimalString({ minorUnits: preview.net, currency: fields.currency })}{' '}
              {fields.currency}
            </span>
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="sale-notes" className="block text-sm font-medium text-slate-300">
          Notes
        </label>
        <textarea
          id="sale-notes"
          value={fields.notes}
          onChange={(event) => {
            patchFields({ notes: event.target.value })
          }}
          rows={2}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
        />
      </div>

      {fields.error ? <FormMessage tone="error">{fields.error}</FormMessage> : null}

      <Button
        disabled={submitMutation.isPending}
        onClick={() => {
          patchFields({ error: null })
          submitMutation.mutate(entityTrackerRef.current.generation())
        }}
      >
        {submitMutation.isPending ? 'Saving…' : 'Save sale'}
      </Button>

      <ItemPicker
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false)
        }}
        excludeHoldingIds={new Set(fields.items.map((i) => i.holdingId))}
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
                aria-label={`Quantity of ${item.displayName} from the lot acquired ${lot.acquiredOn}`}
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
