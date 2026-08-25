import { useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createManualCard } from '../../data/collection'
import { searchSealedProducts } from '../../data/sealedProducts'
import { CardImage } from '../catalog/CardImage'
import { SealedProductImage } from '../catalog/SealedProductImage'
import { Button, ChoiceGroup, FormMessage, TextField } from '../../ui/form'
import { parseNokInput } from '../../ui/money-format'
import { CONDITION_LABEL } from '../collection/labels'
import { SEALED_PRODUCT_TYPE_LABEL } from '../../data/sealedProducts'
import { getOpeningController } from './controller'
import {
  COMPLETENESS_OPTIONS,
  COMPLETENESS_QUESTION,
  OPENING_COST_LABEL,
  PURCHASE_COST_NOT_RECORDED,
  THE_SEALED_NOTICE,
  completenessNote,
  formatNok,
} from './copy'
import {
  STEPS,
  buildBoughtAndOpenedInput,
  buildCreateOpeningInput,
  draftCostPreview,
  draftStore,
  initialDraft,
  reduceDraft,
  reviewError,
  singleSourceAutoSelect,
  sourcesForHolding,
  stepError,
  type DraftAction,
  type OpeningDraft,
  type OpeningMode,
  type OpeningStep,
} from './draft'
import type { OpeningSource, TrackingCompleteness } from './contract'
import { PullPickerSheet } from './PullPickerSheet'

const STEP_LABELS: Record<OpeningStep, string> = {
  source: 'Product',
  quantity: 'Quantity & date',
  pulls: 'Pulls',
  review: 'Review',
}

const MODE_OPTIONS: readonly { value: OpeningMode; label: string; note: string }[] = [
  {
    value: 'existing_lot',
    label: 'Open something I own',
    note: 'Pick the sealed product already in your Portfolio and open units of it.',
  },
  {
    value: 'bought_now',
    label: 'Bought and opened now',
    note: 'You just bought it and opened it right away. Records the purchase and the opening together.',
  },
]

/**
 * The M16 opening wizard (prompt §6): four focused steps — product/lot, quantity & date, pulls,
 * review — instead of one giant form. iPhone-first; every control clears 44 px touch targets and
 * works with a keyboard on desktop.
 *
 * The whole flow talks ONLY to the OpeningController seam; nothing here knows Supabase exists.
 * The draft lives in session memory (`draftStore`), so leaving mid-flow and coming back keeps
 * every entered card (prompt §23 — memory/session state is enough for V1; nothing persists a
 * financial draft to storage).
 */
export function OpeningsWizardPage() {
  const search = useSearch({ from: '/openings/new' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const controller = getOpeningController()

  // One client-generated key per wizard visit: a retried submission cannot record the same
  // opening twice even if the backend answer was lost mid-flight.
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [gateError, setGateError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const gateErrorRef = useRef<HTMLParagraphElement | null>(null)

  const [draft, setDraft] = useState<OpeningDraft>(() => {
    const stored = draftStore.load()
    const reusable =
      stored &&
      stored.phase !== 'submitted' &&
      (stored.holdingId === null ||
        search.holdingId === undefined ||
        stored.holdingId === search.holdingId)
    if (reusable) return stored
    return initialDraft({ holdingId: search.holdingId, lotId: search.lotId })
  })

  function dispatch(action: DraftAction) {
    setDraft((current) => {
      const next = reduceDraft(current, action)
      draftStore.save(next)
      return next
    })
  }

  const sourcesQuery = useQuery({
    queryKey: ['opening-sources', search.holdingId ?? null],
    queryFn: () =>
      controller.getEligibleSealedSources(
        search.holdingId ? { holdingId: search.holdingId } : undefined,
      ),
    retry: false,
  })

  const availableSources = sourcesForHolding(sourcesQuery.data ?? [], draft.holdingId)
  // Arriving from a holding with exactly one open lot confirms it without asking (there is
  // nothing else it could be — prompt §7); several lots stay unchosen until the user picks one.
  // Derived, not an effect: no state is written during render, and the effective selection
  // follows the loaded source list immediately.
  const autoSelected = draft.lotId === null ? singleSourceAutoSelect(availableSources) : null
  const selectedSource =
    draft.lotId !== null
      ? (availableSources.find((s) => s.lotId === draft.lotId) ?? null)
      : autoSelected

  /** Advance/back with the step gates applied; a blocked message takes focus so it is announced,
   *  not merely coloured (DESIGN_SYSTEM.md §9). Backwards navigation never re-validates forward
   *  gates beyond what the target step itself needs. */
  function goToStep(step: OpeningStep) {
    const error = stepError(step, draft, {
      availableSources,
      selectedLotId: selectedSource?.lotId ?? null,
    })
    if (error && step !== 'source') {
      setGateError(error)
      setAnnouncement(error)
      requestAnimationFrame(() => gateErrorRef.current?.focus())
      return
    }
    setGateError(null)
    dispatch({ type: 'GO_TO_STEP', step })
  }

  // Manual-card identities are resolved exactly once per unique identity and cached across
  // retries, so a failed submission never duplicates catalog definitions when the user taps Retry.
  const resolvedManualCards = useRef(new Map<string, string>())

  const submitMutation = useMutation({
    mutationFn: async () => {
      const error = reviewError(draft)
      if (error) throw new Error(error)

      const manualPulls = draft.pulls.filter(
        (pull) => pull.cardVariantId === null && pull.manualCardId === null && pull.manualIdentity,
      )
      const idByKey = new Map<string, string>()
      for (const pull of manualPulls) {
        const identity = pull.manualIdentity
        if (!identity) continue
        const key = `${identity.name}|${identity.setName ?? ''}|${identity.collectorNumber ?? ''}`
        const cached = resolvedManualCards.current.get(key)
        const manualCardId =
          cached ??
          (
            await createManualCard({
              name: identity.name,
              setName: identity.setName,
              collectorNumber: identity.collectorNumber,
            })
          ).id
        resolvedManualCards.current.set(key, manualCardId)
        idByKey.set(pull.key, manualCardId)
      }

      const resolvedDraft: OpeningDraft = {
        ...draft,
        pulls: draft.pulls.map((pull) =>
          idByKey.has(pull.key) ? { ...pull, manualCardId: idByKey.get(pull.key) ?? null } : pull,
        ),
      }
      if (draft.mode === 'bought_now') {
        return controller.createBoughtAndOpened(
          buildBoughtAndOpenedInput(resolvedDraft, idempotencyKey, parseNokInput),
        )
      }
      if (!selectedSource) throw new Error('Choose which acquisition lot you opened from.')
      const input = buildCreateOpeningInput(
        resolvedDraft,
        selectedSource.lotId,
        idempotencyKey,
        parseNokInput,
      )
      return controller.createOpening(input)
    },
    onMutate: () => {
      dispatch({ type: 'BEGIN_SUBMIT' })
    },
    onSuccess: async (created) => {
      dispatch({ type: 'SUBMIT_SUCCEEDED', openingId: created.openingId })
      draftStore.clear()
      // Current Portfolio value updates immediately after refetch (D-086); history catches up
      // behind the ordinary recompute worker and Home's own status communicates that — no custom
      // polling here (prompt §21).
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['history-events'] })
      await queryClient.invalidateQueries({ queryKey: ['holding-lots'] })
      await queryClient.invalidateQueries({ queryKey: ['opening-sources'] })
      await navigate({
        to: '/openings/$openingId',
        params: { openingId: created.openingId },
        search: { created: true },
      })
    },
    onError: (mutationError: Error) => {
      // The entire draft survives untouched — pulls, quantities, dates (prompt §23).
      dispatch({ type: 'SUBMIT_FAILED', message: mutationError.message })
      setAnnouncement(mutationError.message)
    },
  })

  if (sourcesQuery.isPending) {
    return (
      <div className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-lg bg-slate-800/60" />
    )
  }
  if (sourcesQuery.isError) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <Link to="/portfolio" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Back to Portfolio
        </Link>
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          {sourcesQuery.error instanceof Error
            ? sourcesQuery.error.message
            : 'Openings could not be loaded.'}
        </p>
      </div>
    )
  }

  const activeStepIndex = STEPS.indexOf(draft.step)
  const reviewGateError = draft.step === 'review' ? reviewError(draft) : null

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-2 pb-24">
      <div>
        <Link to="/portfolio" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Back to Portfolio
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-slate-100">
          Record an opening
        </h1>
        <p className="text-sm text-slate-400">
          Opened sealed product? Record what you opened and what you pulled.
        </p>
      </div>

      {/* Step indicator — text-first; aria-current carries progress so colour is never the only
          signal (DESIGN_SYSTEM.md §9 / prompt §22). */}
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {STEPS.map((step, index) => (
          <li key={step} aria-current={step === draft.step ? 'step' : undefined}>
            {index + 1}. {STEP_LABELS[step]}
          </li>
        ))}
      </ol>

      <p role="status" className="sr-only">
        {announcement}
      </p>

      {draft.step === 'source' ? (
        <SourceStep
          draft={draft}
          sources={availableSources}
          onMode={(mode) => {
            setGateError(null)
            dispatch({ type: 'SET_MODE', mode })
          }}
          onSelect={(source) => {
            setGateError(null)
            dispatch({ type: 'SELECT_SOURCE', source })
          }}
          onSelectProduct={(productId, productName) => {
            setGateError(null)
            dispatch({ type: 'SELECT_PRODUCT', productId, productName })
          }}
        />
      ) : null}

      {draft.step === 'quantity' && draft.mode === 'bought_now' ? (
        <BoughtNowQuantityDateStep
          draft={draft}
          onQuantity={(value) => {
            dispatch({ type: 'SET_QUANTITY_INPUT', value })
          }}
          onTotalPaid={(value) => {
            dispatch({ type: 'SET_TOTAL_PAID_INPUT', value })
          }}
          onPurchasedOn={(value) => {
            dispatch({ type: 'SET_PURCHASED_ON', value })
          }}
          onOpenedOn={(value) => {
            dispatch({ type: 'SET_OPENED_ON', value })
          }}
        />
      ) : null}

      {draft.step === 'quantity' && draft.mode === 'existing_lot' && selectedSource ? (
        <QuantityDateStep
          draft={draft}
          source={selectedSource}
          onQuantity={(value) => {
            dispatch({ type: 'SET_QUANTITY_INPUT', value })
          }}
          onOpenedOn={(value) => {
            dispatch({ type: 'SET_OPENED_ON', value })
          }}
        />
      ) : null}

      {draft.step === 'pulls' ? (
        <PullsStep
          draft={draft}
          onSetPullQuantity={(key, quantity) => {
            dispatch({ type: 'SET_PULL_QUANTITY', key, quantity })
          }}
          onRemovePull={(key) => {
            dispatch({ type: 'REMOVE_PULL', key })
          }}
          onOpenPicker={() => {
            setPickerOpen(true)
          }}
        />
      ) : null}

      {draft.step === 'review' && draft.mode === 'bought_now' && draft.productName ? (
        <ReviewStep
          draft={draft}
          productName={draft.productName}
          productTypeName={null}
          boughtNow
          onCompleteness={(value) => {
            dispatch({ type: 'SET_COMPLETENESS', value })
          }}
          onBulkEstimate={(value) => {
            dispatch({ type: 'SET_BULK_ESTIMATE_INPUT', value })
          }}
          onBulkCount={(value) => {
            dispatch({ type: 'SET_BULK_COUNT_INPUT', value })
          }}
          onNotes={(value) => {
            dispatch({ type: 'SET_NOTES', value })
          }}
        />
      ) : null}

      {draft.step === 'review' && draft.mode === 'existing_lot' && selectedSource ? (
        <ReviewStep
          draft={draft}
          productName={selectedSource.productName}
          productTypeName={selectedSource.productTypeName}
          onCompleteness={(value) => {
            dispatch({ type: 'SET_COMPLETENESS', value })
          }}
          onBulkEstimate={(value) => {
            dispatch({ type: 'SET_BULK_ESTIMATE_INPUT', value })
          }}
          onBulkCount={(value) => {
            dispatch({ type: 'SET_BULK_COUNT_INPUT', value })
          }}
          onNotes={(value) => {
            dispatch({ type: 'SET_NOTES', value })
          }}
        />
      ) : null}

      {gateError ? (
        <p
          ref={gateErrorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200 focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          {gateError}
        </p>
      ) : null}
      {reviewGateError ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-200"
        >
          {reviewGateError}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        {activeStepIndex > 0 ? (
          <Button
            type="button"
            variant="quiet"
            className="w-auto"
            disabled={draft.phase === 'submitting'}
            onClick={() => {
              goToStep(STEPS[activeStepIndex - 1] ?? 'source')
            }}
          >
            Back
          </Button>
        ) : (
          <span />
        )}
        {activeStepIndex < STEPS.length - 1 ? (
          <Button
            type="button"
            className="w-auto"
            disabled={draft.mode === 'existing_lot' && availableSources.length === 0}
            onClick={() => {
              goToStep(STEPS[activeStepIndex + 1] ?? 'review')
            }}
          >
            Continue
          </Button>
        ) : (
          <Button
            type="button"
            disabled={
              draft.phase !== 'editing' ||
              submitMutation.isPending ||
              (draft.mode === 'existing_lot' && !selectedSource) ||
              (draft.mode === 'bought_now' && !draft.productId)
            }
            onClick={() => {
              setGateError(null)
              submitMutation.mutate()
            }}
          >
            {draft.phase === 'submitting' ? 'Recording…' : 'Finish opening'}
          </Button>
        )}
      </div>

      {draft.submitError ? (
        <FormMessage tone="error">
          {`${draft.submitError} Your entries are still here — try again.`}
        </FormMessage>
      ) : null}

      <PullPickerSheet
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false)
        }}
        onAdd={(pull, quantity) => {
          dispatch({ type: 'ADD_PULL', pull, quantity, makeKey: () => crypto.randomUUID() })
        }}
      />
    </div>
  )
}

function sealedTypeLabel(typeName: string | null | undefined): string | null {
  if (!typeName) return null
  // Widened on purpose: the adapter may hand back an enum value this build does not know, and a
  // missing label falls through to the raw value rather than hiding the row.
  const labels: Record<string, string | undefined> = SEALED_PRODUCT_TYPE_LABEL
  return labels[typeName] ?? typeName
}

function SourceStep({
  draft,
  sources,
  onMode,
  onSelect,
  onSelectProduct,
}: {
  draft: OpeningDraft
  sources: OpeningSource[]
  onMode: (mode: OpeningMode) => void
  onSelect: (source: OpeningSource) => void
  onSelectProduct: (productId: string, productName: string) => void
}) {
  const activeMode = MODE_OPTIONS.find((option) => option.value === draft.mode)

  return (
    <div className="space-y-4">
      <ChoiceGroup
        label="What are you recording?"
        value={draft.mode}
        onChange={onMode}
        options={MODE_OPTIONS.map((option) => [option.value, option.label] as const)}
      />
      {activeMode ? <p className="text-xs text-slate-500">{activeMode.note}</p> : null}

      {draft.mode === 'bought_now' ? (
        <BoughtNowProductPicker
          selectedProductId={draft.productId}
          onSelectProduct={onSelectProduct}
        />
      ) : (
        <ExistingLotPicker draft={draft} sources={sources} onSelect={onSelect} />
      )}
    </div>
  )
}

/** Bought-and-open step 1 (P53 §11): pick the sealed product from the same shared catalog the
 *  Search page uses — curated rows plus the user's own custom entries. */
function BoughtNowProductPicker({
  selectedProductId,
  onSelectProduct,
}: {
  selectedProductId: string | null
  onSelectProduct: (productId: string, productName: string) => void
}) {
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const productsQuery = useQuery({
    queryKey: ['opening-sealed-products', query],
    queryFn: () => searchSealedProducts({ query }),
    retry: false,
  })
  const results = productsQuery.data ?? []

  return (
    <fieldset className="space-y-2">
      <legend className="pb-1 text-sm font-medium text-slate-300">
        Which sealed product did you buy and open?
      </legend>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(queryInput.trim())
        }}
      >
        <label className="sr-only" htmlFor="bought-now-product-search">
          Search sealed products
        </label>
        <input
          id="bought-now-product-search"
          type="search"
          value={queryInput}
          onChange={(event) => {
            setQueryInput(event.target.value)
          }}
          placeholder="e.g. Booster bundle"
          className="min-h-11 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
        />
        <Button type="submit" variant="quiet" className="w-auto">
          Search
        </Button>
      </form>

      {productsQuery.isPending ? (
        <div className="h-20 animate-pulse rounded-lg bg-slate-800/60" />
      ) : productsQuery.isError ? (
        <p role="alert" className="text-sm text-rose-300">
          Sealed products could not be loaded.
        </p>
      ) : results.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-800 p-4 text-sm text-slate-500">
          No sealed products matched{query ? ` “${query}”` : ''}. You can add a custom one from the
          + menu first.
        </p>
      ) : (
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {results.slice(0, 20).map((product) => {
            const selected = selectedProductId === product.id
            return (
              <button
                key={product.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onSelectProduct(product.id, product.name)
                }}
                className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left ${
                  selected
                    ? 'border-sky-500 bg-sky-600/10'
                    : 'border-slate-800 hover:bg-slate-800/40'
                }`}
              >
                <SealedProductImage
                  imageUrl={product.imageUrl}
                  productType="other"
                  alt={product.name}
                  className="h-12 w-9 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-100">
                    {product.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {[sealedTypeLabel(product.productType), product.setName ?? null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

function ExistingLotPicker({
  draft,
  sources,
  onSelect,
}: {
  draft: OpeningDraft
  sources: OpeningSource[]
  onSelect: (source: OpeningSource) => void
}) {
  if (sources.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed border-slate-800 p-6 text-center">
        <p className="text-sm font-medium text-slate-200">Nothing to open yet</p>
        <p className="text-xs text-slate-500">
          You have no sealed products with unopened units. Add one from Search or the + menu — or
          switch to “Bought and opened now” if you opened it right after buying.
        </p>
        <Link
          to="/catalog"
          className="inline-flex min-h-11 items-center rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Browse the catalog
        </Link>
      </div>
    )
  }

  return (
    <fieldset className="space-y-2">
      <legend className="pb-1 text-sm font-medium text-slate-300">
        Which sealed product did you open?
      </legend>
      <div className="space-y-2">
        {sources.map((source) => {
          const selected = draft.lotId === source.lotId
          return (
            <button
              key={source.lotId}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                onSelect(source)
              }}
              className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left ${
                selected ? 'border-sky-500 bg-sky-600/10' : 'border-slate-800 hover:bg-slate-800/40'
              }`}
            >
              <SealedProductImage
                imageUrl={source.imageUrl ?? null}
                productType="other"
                alt={source.productName}
                className="h-12 w-9 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-100">
                  {source.productName}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {[sealedTypeLabel(source.productTypeName), source.setName ?? null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  Acquired {source.acquiredOn} · {source.quantityAvailable} unopened ·{' '}
                  {source.costKnown ? 'Purchase cost recorded' : PURCHASE_COST_NOT_RECORDED}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {sources.length > 1 ? (
        <p className="text-xs text-slate-500">
          These are separate acquisitions with their own dates and costs — pick the one you actually
          opened.
        </p>
      ) : null}
    </fieldset>
  )
}

function QuantityDateStep({
  draft,
  source,
  onQuantity,
  onOpenedOn,
}: {
  draft: OpeningDraft
  source: OpeningSource
  onQuantity: (value: string) => void
  onOpenedOn: (value: string) => void
}) {
  const parsed = Number.parseInt(draft.quantityInput, 10)
  const shown = Number.isFinite(parsed) && parsed >= 1 ? parsed : null
  return (
    <div className="space-y-5">
      <TextField
        label="How many are you opening?"
        type="number"
        inputMode="numeric"
        min={1}
        max={source.quantityAvailable}
        value={draft.quantityInput}
        onChange={(event) => {
          onQuantity(event.target.value)
        }}
        hint={
          shown
            ? `Open ${shown} of ${source.quantityAvailable}.`
            : `Between 1 and ${source.quantityAvailable}.`
        }
      />

      <TextField
        label="When did you open it?"
        type="date"
        value={draft.openedOn}
        onChange={(event) => {
          onOpenedOn(event.target.value)
        }}
        hint="Defaults to today — you can backdate. This decides when these packs stop counting as sealed inventory in your Portfolio history."
      />

      <div className="space-y-1 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 text-sm">
        <p className="font-medium text-slate-300">{OPENING_COST_LABEL}</p>
        <CostPreviewLine draft={draft} source={source} />
        <p className="pt-1 text-xs text-slate-500">
          The purchase already sits in your spending history and stays there unchanged.
        </p>
      </div>

      <p className="rounded-lg border border-slate-800 p-3 text-sm text-slate-300">
        {THE_SEALED_NOTICE}
      </p>
    </div>
  )
}

function CostPreviewLine({ draft, source }: { draft: OpeningDraft; source: OpeningSource }) {
  const preview = draftCostPreview(draft, source)
  if (preview.kind === 'unknown') {
    return <p className="text-slate-400">{PURCHASE_COST_NOT_RECORDED}</p>
  }
  const unitLine =
    source.costKnown && source.effectiveUnitBasisNokMinor
      ? ` · ${formatNok(source.effectiveUnitBasisNokMinor)} kr each, from the original purchase`
      : ''
  return (
    <p className="tabular-nums text-slate-100">
      {formatNok(preview.minorUnits)} kr
      {unitLine ? <span className="text-xs text-slate-500">{unitLine}</span> : null}
    </p>
  )
}

/** Buy-and-open quantity/date/total step (P53 §11): the user states what they PAID IN TOTAL —
 *  never a per-unit price (nobody computes 299.95 ÷ 3 in their head). The backend splits it
 *  exactly (D-090). */
function BoughtNowQuantityDateStep({
  draft,
  onQuantity,
  onTotalPaid,
  onPurchasedOn,
  onOpenedOn,
}: {
  draft: OpeningDraft
  onQuantity: (value: string) => void
  onTotalPaid: (value: string) => void
  onPurchasedOn: (value: string) => void
  onOpenedOn: (value: string) => void
}) {
  const parsed = Number.parseInt(draft.quantityInput, 10)
  const shown = Number.isFinite(parsed) && parsed >= 1 ? parsed : null
  return (
    <div className="space-y-5">
      <TextField
        label={`How many ${draft.productName ?? 'units'} did you open?`}
        type="number"
        inputMode="numeric"
        min={1}
        value={draft.quantityInput}
        onChange={(event) => {
          onQuantity(event.target.value)
        }}
        hint={shown ? `Opening ${shown}.` : 'At least 1.'}
      />

      <TextField
        label="What did you pay in total? (NOK)"
        inputMode="decimal"
        placeholder="299,95"
        value={draft.totalPaidInput}
        onChange={(event) => {
          onTotalPaid(event.target.value)
        }}
        hint="The receipt total for all of them — no need to work out a per-pack price."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label="When did you buy it?"
          type="date"
          value={draft.purchasedOn}
          onChange={(event) => {
            onPurchasedOn(event.target.value)
          }}
          hint="Defaults to today. This decides when the spending lands in your history."
        />
        <TextField
          label="When did you open it?"
          type="date"
          value={draft.openedOn}
          onChange={(event) => {
            onOpenedOn(event.target.value)
          }}
          hint="Defaults to today too — backdating is fine."
        />
      </div>

      <p className="rounded-lg border border-slate-800 p-3 text-sm text-slate-300">
        {THE_SEALED_NOTICE} The whole total is recorded once as a purchase — opening it does not add
        any extra cost.
      </p>
    </div>
  )
}

function PullsStep({
  draft,
  onSetPullQuantity,
  onRemovePull,
  onOpenPicker,
}: {
  draft: OpeningDraft
  onSetPullQuantity: (key: string, quantity: number) => void
  onRemovePull: (key: string) => void
  onOpenPicker: () => void
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-200">Pulled cards</h2>
      {draft.pulls.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-800 p-4 text-sm text-slate-500">
          Nothing added yet. Every card you record keeps its provenance — commons, energies and
          unpriced cards included.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
          {draft.pulls.map((pull) => (
            <li key={pull.key} className="flex items-center gap-3 p-3">
              <CardImage
                imageBaseUrl={pull.imageBaseUrl}
                alt={pull.displayName}
                quality="low"
                className="h-12 w-9 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-100">{pull.displayName}</p>
                <p className="truncate text-xs text-slate-500">
                  {[pull.subtitle, pull.finishLabel, CONDITION_LABEL[pull.condition]]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <label className="shrink-0 whitespace-nowrap text-xs text-slate-500">
                Qty
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  aria-label={`Quantity for ${pull.displayName}`}
                  value={pull.quantity}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10)
                    onSetPullQuantity(pull.key, Number.isFinite(parsed) ? parsed : 1)
                  }}
                  className="ml-2 w-14 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center text-sm text-slate-100 outline-none focus-visible:border-sky-500"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  onRemovePull(pull.key)
                }}
                className="shrink-0 text-xs text-rose-300 underline-offset-4 hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onOpenPicker}
        className="min-h-11 w-full rounded-lg border border-dashed border-slate-700 text-sm font-medium text-slate-300 hover:bg-slate-800/40"
      >
        + Add pulled card
      </button>
    </div>
  )
}

function ReviewStep({
  draft,
  productName,
  productTypeName,
  boughtNow = false,
  onCompleteness,
  onBulkEstimate,
  onBulkCount,
  onNotes,
}: {
  draft: OpeningDraft
  productName: string
  productTypeName: string | null | undefined
  boughtNow?: boolean
  onCompleteness: (value: TrackingCompleteness) => void
  onBulkEstimate: (value: string) => void
  onBulkCount: (value: string) => void
  onNotes: (value: string) => void
}) {
  const totalRecorded = draft.pulls.reduce((sum, pull) => sum + pull.quantity, 0)
  const showEstimate = draft.completeness !== 'all_cards'

  return (
    <div className="space-y-5">
      <section className="space-y-2 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-200">Before you finish</h2>
        <dl className="space-y-1.5 text-sm">
          <ReviewRow label="Product" value={productName} />
          {sealedTypeLabel(productTypeName) ? (
            <ReviewRow label="Type" value={sealedTypeLabel(productTypeName) ?? ''} />
          ) : null}
          {boughtNow && draft.totalPaidInput.trim() !== '' ? (
            <ReviewRow
              label="Total paid"
              value={`${formatNok(parseNokInput(draft.totalPaidInput))} kr`}
            />
          ) : null}
          <ReviewRow
            label="Quantity opened"
            value={String(Math.max(1, Number.parseInt(draft.quantityInput, 10) || 1))}
          />
          {boughtNow ? <ReviewRow label="Purchased" value={draft.purchasedOn} /> : null}
          <ReviewRow label="Date" value={draft.openedOn} />
        </dl>
        {boughtNow ? (
          <p className="text-xs text-slate-500">
            Records one purchase for the total above plus this opening — the money enters your
            spending history exactly once.
          </p>
        ) : null}
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-800 p-4">
        <ChoiceGroup
          label={COMPLETENESS_QUESTION}
          value={draft.completeness}
          onChange={onCompleteness}
          options={COMPLETENESS_OPTIONS.map((option) => [option.value, option.label] as const)}
        />
        <p className="text-xs text-slate-500">{completenessNote(draft.completeness)}</p>

        {showEstimate ? (
          <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
            <TextField
              label="Estimated value of untracked cards (NOK)"
              inputMode="decimal"
              placeholder="240"
              value={draft.bulkEstimateInput}
              onChange={(event) => {
                onBulkEstimate(event.target.value)
              }}
              hint="Optional estimate — leave empty if you don't know."
            />
            <TextField
              label="Roughly how many cards"
              inputMode="numeric"
              placeholder="60"
              value={draft.bulkCountInput}
              onChange={(event) => {
                onBulkCount(event.target.value)
              }}
              hint="Optional."
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-2 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-200">Tracked pulls ({totalRecorded})</h2>
        <p className="text-xs text-slate-500">
          Pulled cards carry no individual purchase cost — the cost belongs to the opening.
        </p>
        {draft.pulls.length > 0 ? (
          <ul className="divide-y divide-slate-800">
            {draft.pulls.map((pull) => (
              <li key={pull.key} className="flex items-center gap-3 py-2">
                <CardImage
                  imageBaseUrl={pull.imageBaseUrl}
                  alt={pull.displayName}
                  quality="low"
                  className="h-10 w-7 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-100">{pull.displayName}</p>
                  <p className="truncate text-xs text-slate-500">
                    ×{pull.quantity}
                    {pull.finishLabel ? ` · ${pull.finishLabel}` : ''}
                    {` · ${CONDITION_LABEL[pull.condition]}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No individual cards recorded.</p>
        )}
      </section>

      <TextField
        label="Notes"
        hint="Optional"
        value={draft.notes}
        onChange={(event) => {
          onNotes(event.target.value)
        }}
      />
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-100">{value}</dd>
    </div>
  )
}
