import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearManualValuation,
  getHoldingLots,
  getHoldingSummary,
  getHoldingValueProvenance,
  removeHoldingsFromPortfolio,
  sealedIntentBreakdown,
  setManualValuation,
  toggleFavorite,
  voidAcquisitionLot,
  SEALED_INTENT_LABEL,
  type AcquisitionLot,
} from '../../data/collection'
import { SEALED_PRODUCT_TYPE_LABEL } from '../../data/sealedProducts'
import { MoneyDisplay } from '../../ui/MoneyDisplay'
import {
  addHoldingToCollection,
  getHoldingCollectionIds,
  listCustomCollections,
  removeHoldingFromCollection,
} from '../../data/customCollections'
import { CardImage } from '../catalog/CardImage'
import { SealedProductImage } from '../catalog/SealedProductImage'
import { AdjustQuantitySheet } from './AdjustQuantitySheet'
import { SealedIntentSheet } from './SealedIntentSheet'
import { Sheet } from '../../ui/Sheet'
import { Button, FormMessage, TextField } from '../../ui/form'
import { formatNokMinor, parseNokInput } from '../../ui/money-format'
import {
  CONDITION_LABEL,
  FINISH_LABEL,
  GRADER_LABEL,
  ORIGIN_LABEL,
  PRICE_KIND_LABEL,
  PROVIDER_LABEL,
} from './labels'

/** Storage is a lot-level fact (D-036) — a holding's lots may legitimately sit in different
 *  places. Never pick one arbitrarily (M7 prompt §62): show the shared location when every open
 *  lot agrees, and say so plainly when they don't. */
function storageSummary(
  lots: { storageLocationName: string | null; voidedAt: string | null }[],
): string | null {
  const names = new Set(
    lots
      .filter((l) => !l.voidedAt && l.storageLocationName)
      .map((l) => l.storageLocationName as string),
  )
  if (names.size === 0) return null
  if (names.size > 1) return 'Multiple locations'
  return [...names][0] ?? null
}

export function HoldingDetailPage() {
  const { holdingId } = useParams({ from: '/portfolio/$holdingId' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [manualValueInput, setManualValueInput] = useState('')
  const [valueError, setValueError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [intentLot, setIntentLot] = useState<AcquisitionLot | null>(null)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const holding = useQuery({
    queryKey: ['holding-summary', holdingId],
    queryFn: () => getHoldingSummary(holdingId),
  })
  const lots = useQuery({
    queryKey: ['holding-lots', holdingId],
    queryFn: () => getHoldingLots(holdingId),
  })
  const provenance = useQuery({
    queryKey: ['holding-value-provenance', holdingId],
    queryFn: () => getHoldingValueProvenance(holdingId),
  })
  const collections = useQuery({ queryKey: ['custom-collections'], queryFn: listCustomCollections })
  const membership = useQuery({
    queryKey: ['holding-collections', holdingId],
    queryFn: () => getHoldingCollectionIds(holdingId),
  })

  const favoriteMutation = useMutation({
    mutationFn: (next: boolean) => toggleFavorite(holdingId, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    },
  })

  const [voidError, setVoidError] = useState<string | null>(null)
  const voidMutation = useMutation({
    mutationFn: (lotId: string) => voidAcquisitionLot(lotId),
    onSuccess: async () => {
      setVoidError(null)
      await queryClient.invalidateQueries({ queryKey: ['holding-lots', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
    },
    onError: (error: Error) => {
      setVoidError(error.message)
    },
  })

  // P28 — "Remove from Portfolio" / "Remove all" straight from Holding Detail (no Select mode
  // needed). Reuses the M8.1 correction lifecycle unchanged: remove_holdings_from_portfolio voids
  // every live lot via void_acquisition_lot itself, so the same parent-purchase and
  // partially-disposed guards apply here as everywhere else.
  const removeAllMutation = useMutation({
    mutationFn: () => removeHoldingsFromPortfolio([holdingId]),
    onSuccess: async (results) => {
      const blocked = results.find((r) => r.blocked)
      if (blocked) {
        setRemoveError(blocked.blockedReason ?? 'This holding cannot be removed right now.')
        return
      }
      setRemoveError(null)
      await queryClient.invalidateQueries({ queryKey: ['holding-lots', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-value-provenance', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      setRemoveConfirmOpen(false)
      // Nothing owned remains — a detail page claiming ownership would be stale. Back to Portfolio.
      await navigate({ to: '/portfolio' })
    },
    onError: (error: Error) => {
      setRemoveError(error.message)
    },
  })

  const valuationMutation = useMutation({
    mutationFn: (valueMinor: bigint) => setManualValuation({ holdingId, valueMinor }),
    onSuccess: async () => {
      setManualValueInput('')
      await queryClient.invalidateQueries({ queryKey: ['holding-value-provenance', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
    },
  })

  const clearValuationMutation = useMutation({
    mutationFn: () => clearManualValuation(holdingId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holding-value-provenance', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
    },
  })

  const membershipMutation = useMutation({
    mutationFn: (input: { collectionId: string; member: boolean }) =>
      input.member
        ? removeHoldingFromCollection(input.collectionId, holdingId)
        : addHoldingToCollection(input.collectionId, holdingId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holding-collections', holdingId] })
    },
  })

  const costSummary = useMemo(() => {
    const live = (lots.data ?? []).filter((l) => !l.voidedAt)
    if (live.length === 0) return null
    const known = live.filter((l) => l.costBasisState === 'known' && l.unitCostBasisMinor !== null)
    if (known.length === 0) return { text: 'No recorded cost for any lot', qualified: false }
    const total = known.reduce(
      (sum, l) => sum + (l.unitCostBasisMinor as bigint) * BigInt(l.quantityRemaining),
      0n,
    )
    if (known.length === live.length) {
      return { text: `Total paid: ${formatNokMinor(total)} NOK`, qualified: false }
    }
    return {
      text: `${formatNokMinor(total)} NOK known across ${known.length} of ${live.length} lots — the rest have no recorded cost`,
      qualified: true,
    }
  }, [lots.data])

  if (holding.isPending) {
    return (
      <div className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-lg bg-slate-800/60" />
    )
  }
  if (holding.isError || !holding.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          That holding could not be found.
        </p>
        <Link to="/portfolio" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Back to Portfolio
        </Link>
      </div>
    )
  }

  const h = holding.data
  const isSealed = h.holdingKind === 'sealed'
  const displayName = isSealed
    ? (h.sealedProductName ?? 'Unknown sealed product')
    : (h.cardName ?? h.manualName ?? 'Unknown card')
  const setName = isSealed ? h.sealedSetName : (h.cardSetName ?? h.manualSetName)
  const number = h.cardLocalId ?? h.manualCollectorNumber
  const storage = storageSummary(lots.data ?? [])
  const liveLotCount = (lots.data ?? []).filter((l) => !l.voidedAt).length

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <Link to="/portfolio" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to Portfolio
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row">
        {isSealed ? (
          <SealedProductImage
            imageUrl={h.sealedImageUrl}
            productType={h.sealedProductType ?? 'other'}
            alt={displayName}
            className="h-64 w-48 self-center sm:self-start"
          />
        ) : (
          <CardImage
            imageBaseUrl={h.cardImageBaseUrl}
            alt={displayName}
            quality="high"
            className="h-64 w-48 self-center sm:self-start"
          />
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{displayName}</h1>
            {isSealed && h.sealedIsCustom ? (
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                Custom
              </span>
            ) : null}
            <button
              type="button"
              aria-pressed={h.isFavorite}
              aria-label={h.isFavorite ? 'Remove from favourites' : 'Mark as favourite'}
              onClick={() => {
                favoriteMutation.mutate(!h.isFavorite)
              }}
              className="text-xl text-amber-400 focus-visible:outline-2 focus-visible:outline-sky-500"
            >
              {h.isFavorite ? '★' : '☆'}
            </button>
          </div>
          <p className="text-sm text-slate-300">
            {isSealed
              ? [
                  SEALED_PRODUCT_TYPE_LABEL[h.sealedProductType ?? 'other'],
                  setName,
                  h.sealedProductLanguage,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : [setName, number ? `#${number}` : null].filter(Boolean).join(' · ')}
          </p>
          {isSealed && h.sealedIsCustom ? (
            <p className="text-xs text-slate-500">Custom product — not in the shared catalog</p>
          ) : null}
          {h.manualCardId ? (
            <p className="text-xs text-slate-500">Manual entry — not in the shared catalog</p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-sm">
            {isSealed ? (
              <>
                {h.sealedPackCount ? (
                  <>
                    <dt className="text-slate-500">Pack count</dt>
                    <dd className="text-slate-200">{h.sealedPackCount}</dd>
                  </>
                ) : null}
                <dt className="text-slate-500">Intent</dt>
                <dd className="text-slate-200">{sealedIntentBreakdown(h) || '—'}</dd>
              </>
            ) : h.holdingKind === 'graded_card' ? (
              <>
                <dt className="text-slate-500">Grade</dt>
                <dd className="text-slate-200">
                  {h.grader ? GRADER_LABEL[h.grader] : '—'} {h.grade ?? ''}
                </dd>
                <dt className="text-slate-500">Certification</dt>
                <dd className="text-slate-200">{h.certNumber ?? '—'}</dd>
              </>
            ) : (
              <>
                <dt className="text-slate-500">Condition</dt>
                <dd className="text-slate-200">
                  {h.condition ? CONDITION_LABEL[h.condition] : '—'}
                </dd>
              </>
            )}
            {h.variantFinish ? (
              <>
                <dt className="text-slate-500">Variant</dt>
                <dd className="text-slate-200">
                  {FINISH_LABEL[h.variantFinish] ?? h.variantFinish}
                  {h.variantSubtype ? ` · ${h.variantSubtype}` : ''}
                  {h.variantStamp ? ` · ${h.variantStamp}` : ''}
                </dd>
              </>
            ) : null}
            <dt className="text-slate-500">Owned</dt>
            <dd className="text-slate-200">×{h.quantity}</dd>
            <dt className="text-slate-500">Storage</dt>
            <dd className="text-slate-200">{storage ?? '—'}</dd>
          </dl>
          {h.quantity > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link
                to="/sales/new"
                search={{ holdingIds: holdingId }}
                className="flex min-h-10 w-fit items-center rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200 hover:bg-slate-800"
              >
                Sell
              </Link>
              {h.quantity > 1 ? (
                <button
                  type="button"
                  onClick={() => {
                    setRemoveError(null)
                    setAdjustOpen(true)
                  }}
                  className="flex min-h-10 w-fit items-center rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                >
                  Adjust quantity
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setRemoveError(null)
                  setRemoveConfirmOpen(true)
                }}
                className="flex min-h-10 w-fit items-center rounded-lg border border-rose-900/60 px-4 text-sm font-semibold text-rose-300 hover:bg-rose-950/40"
              >
                {h.quantity > 1 ? 'Remove all' : 'Remove from Portfolio'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <section className="space-y-3 rounded-lg border border-slate-800 p-3">
        <h2 className="text-sm font-semibold text-slate-300">Current value</h2>

        {provenance.isPending ? (
          <div className="h-10 animate-pulse rounded-lg bg-slate-800/60" />
        ) : (
          <>
            <div className="flex items-center justify-between">
              <MoneyDisplay
                state={
                  provenance.data?.holdingValueMinor !== undefined &&
                  provenance.data.holdingValueMinor !== null
                    ? 'known'
                    : 'missing'
                }
                minorUnits={provenance.data?.holdingValueMinor ?? undefined}
                stale={provenance.data?.priceState === 'stale'}
              />
              {h.quantity > 1 && provenance.data?.unitValueMinor !== null ? (
                <span className="text-xs text-slate-500">
                  {formatNokMinor(provenance.data?.unitValueMinor ?? 0n)} NOK / card × {h.quantity}
                </span>
              ) : null}
            </div>

            {provenance.data?.priceState === 'manual' ? (
              <p className="text-xs text-slate-500">
                Your own estimate, not a market price.{' '}
                <button
                  type="button"
                  className="text-sky-400 underline-offset-4 hover:underline disabled:opacity-50"
                  disabled={clearValuationMutation.isPending}
                  onClick={() => {
                    clearValuationMutation.mutate()
                  }}
                >
                  Return to market value
                </button>
              </p>
            ) : provenance.data?.priceState === 'fresh' ||
              provenance.data?.priceState === 'stale' ? (
              <p className="text-xs text-slate-500">
                {provenance.data.provider ? PROVIDER_LABEL[provenance.data.provider] : ''} ·{' '}
                {provenance.data.priceKind ? PRICE_KIND_LABEL[provenance.data.priceKind] : ''}
                {provenance.data.sourceValueMinor !== null && provenance.data.sourceCurrency
                  ? ` · ${(Number(provenance.data.sourceValueMinor) / 100).toFixed(2)} ${provenance.data.sourceCurrency}`
                  : ''}
                {provenance.data.snapshotDate ? ` · as of ${provenance.data.snapshotDate}` : ''}
                {provenance.data.priceState === 'stale' ? ' · price hasn’t refreshed recently' : ''}
              </p>
            ) : h.holdingKind === 'graded_card' ? (
              <p className="text-xs text-slate-500">
                Graded cards need a manual value — raw market prices never value a graded copy.
              </p>
            ) : isSealed ? (
              <p className="text-xs text-slate-500">
                Sealed products need a manual value — there is no automatic sealed pricing.
              </p>
            ) : (
              <p className="text-xs text-slate-500">No market value available yet for this card.</p>
            )}

            <div className="flex items-end gap-2 pt-1">
              <TextField
                label="Set manual value (NOK)"
                inputMode="decimal"
                placeholder="2500"
                value={manualValueInput}
                onChange={(event) => {
                  setManualValueInput(event.target.value)
                }}
              />
              <Button
                type="button"
                variant="quiet"
                className="w-auto shrink-0"
                disabled={valuationMutation.isPending}
                onClick={() => {
                  setValueError(null)
                  try {
                    valuationMutation.mutate(parseNokInput(manualValueInput))
                  } catch {
                    setValueError('Enter a valid amount.')
                  }
                }}
              >
                {provenance.data?.priceState === 'manual' ? 'Update' : 'Set'}
              </Button>
            </div>
            {valueError ? <FormMessage tone="error">{valueError}</FormMessage> : null}
          </>
        )}
      </section>

      {/* Acquisition cost summary first, lot-by-lot history behind an expandable section
          (M7 prompt §47-48) — the detail page leads with identity/quantity/condition/storage/cost
          summary, not an accounting ledger. */}
      <section className="space-y-2 rounded-lg border border-slate-800 p-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-300">Acquisition cost</h2>
          {isSealed && h.sealedProductId ? (
            <Link
              to="/portfolio/sealed/new"
              search={{ sealedProductId: h.sealedProductId }}
              className="text-sm text-sky-400 underline-offset-4 hover:underline"
            >
              Add another copy
            </Link>
          ) : (
            <Link
              to="/add"
              search={
                h.manualCardId
                  ? { manualCardId: h.manualCardId }
                  : { variantId: h.cardVariantId ?? undefined }
              }
              className="text-sm text-sky-400 underline-offset-4 hover:underline"
            >
              Add another copy
            </Link>
          )}
        </div>
        <p className="text-sm text-slate-300">
          {lots.isPending ? '…' : (costSummary?.text ?? 'No lots recorded')}
        </p>
        <button
          type="button"
          onClick={() => {
            setHistoryOpen((v) => !v)
          }}
          className="text-xs text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
        >
          {historyOpen ? 'Hide' : 'Show'} acquisition history ({liveLotCount} lot
          {liveLotCount === 1 ? '' : 's'})
        </button>

        {historyOpen ? (
          lots.isPending ? (
            <div className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
          ) : lots.isError ? (
            <p role="alert" className="text-sm text-rose-300">
              Lots could not be loaded.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
              {lots.data.map((lot) => (
                <li key={lot.id} className="space-y-1 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-200">
                      ×{lot.quantityRemaining}
                      {lot.quantityRemaining !== lot.quantity ? ` of ${lot.quantity}` : ''} ·{' '}
                      {ORIGIN_LABEL[lot.origin]} · {lot.acquiredOn}
                    </span>
                    {lot.voidedAt ? (
                      <span className="text-xs text-slate-500">Voided</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            confirm(
                              'Remove this acquisition from your Portfolio? Use this only to correct an entry — selling or trading a card will have separate workflows. It stays visible in history but no longer counts.',
                            )
                          ) {
                            voidMutation.mutate(lot.id)
                          }
                        }}
                        className="text-xs text-rose-400 underline-offset-4 hover:underline"
                      >
                        Void
                      </button>
                    )}
                  </div>
                  {voidError && voidMutation.variables === lot.id ? (
                    <p role="alert" className="text-xs text-rose-300">
                      {voidError}
                    </p>
                  ) : null}
                  <p className="text-xs text-slate-400">
                    {lot.costBasisState === 'known' && lot.unitCostBasisMinor !== null
                      ? `${formatNokMinor(lot.unitCostBasisMinor)} NOK / card`
                      : lot.costBasisState === 'unallocated_opening'
                        ? 'From opening — no individual purchase cost'
                        : lot.costBasisState === 'not_paid'
                          ? 'No cost — not paid'
                          : lot.costBasisState === 'trade_in'
                            ? 'Received in trade — no cost basis recorded'
                            : 'Cost unknown'}
                    {lot.storageLocationName ? ` · ${lot.storageLocationName}` : ''}
                  </p>
                  {isSealed && lot.sealedIntent && !lot.voidedAt ? (
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                      <span>{SEALED_INTENT_LABEL[lot.sealedIntent]}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setIntentLot(lot)
                        }}
                        className="text-sky-400 underline-offset-4 hover:underline"
                      >
                        Change intent
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      <section className="space-y-2 rounded-lg border border-slate-800 p-3">
        <h2 className="text-sm font-semibold text-slate-300">Collections</h2>
        {collections.data && collections.data.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {collections.data.map((c) => {
              const isMember = membership.data?.includes(c.id) ?? false
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={membershipMutation.isPending}
                  onClick={() => {
                    membershipMutation.mutate({ collectionId: c.id, member: isMember })
                  }}
                  aria-pressed={isMember}
                  className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${
                    isMember
                      ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No custom collections yet — create one from the Portfolio toolbar.
          </p>
        )}
      </section>

      {intentLot ? (
        <SealedIntentSheet
          open
          onClose={() => {
            setIntentLot(null)
          }}
          holdingId={holdingId}
          lot={intentLot}
        />
      ) : null}

      {adjustOpen && h.quantity > 1 ? (
        <AdjustQuantitySheet
          open
          onClose={() => {
            setAdjustOpen(false)
          }}
          holdingId={holdingId}
          holdingName={displayName}
          currentQuantity={h.quantity}
          lots={lots.data ?? []}
        />
      ) : null}

      <Sheet
        open={removeConfirmOpen}
        onClose={() => {
          setRemoveConfirmOpen(false)
        }}
        title={
          h.quantity > 1
            ? `Remove all ${h.quantity} copies from Portfolio?`
            : 'Remove from Portfolio?'
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            All {h.quantity} cop{h.quantity === 1 ? 'y' : 'ies'} of {displayName} will no longer be
            tracked.
          </p>
          <p className="text-xs text-slate-500">
            This corrects your collection. It is not recorded as a sale — no proceeds and no result
            are created. Nothing is deleted: your acquisition history is kept, just excluded going
            forward.
          </p>
          {removeError ? <FormMessage tone="error">{removeError}</FormMessage> : null}
          <Button
            variant="primary"
            className="border border-rose-900/60 bg-rose-900/80 hover:bg-rose-800"
            disabled={removeAllMutation.isPending}
            onClick={() => {
              setRemoveError(null)
              removeAllMutation.mutate()
            }}
          >
            {removeAllMutation.isPending ? 'Removing…' : 'Remove from Portfolio'}
          </Button>
        </div>
      </Sheet>
    </div>
  )
}
