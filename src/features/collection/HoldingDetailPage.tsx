import { useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getActiveManualValuation,
  getHoldingLots,
  getHoldingSummary,
  setManualValuation,
  toggleFavorite,
  voidAcquisitionLot,
} from '../../data/collection'
import {
  addHoldingToCollection,
  getHoldingCollectionIds,
  listCustomCollections,
  removeHoldingFromCollection,
} from '../../data/customCollections'
import { CardImage } from '../catalog/CardImage'
import { Button, FormMessage, TextField } from '../../ui/form'
import { formatNokMinor, parseNokInput } from '../../ui/money-format'
import { CONDITION_LABEL, FINISH_LABEL, GRADER_LABEL, ORIGIN_LABEL } from './labels'

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
  const queryClient = useQueryClient()
  const [manualValueInput, setManualValueInput] = useState('')
  const [valueError, setValueError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const holding = useQuery({
    queryKey: ['holding-summary', holdingId],
    queryFn: () => getHoldingSummary(holdingId),
  })
  const lots = useQuery({
    queryKey: ['holding-lots', holdingId],
    queryFn: () => getHoldingLots(holdingId),
  })
  const manualValuation = useQuery({
    queryKey: ['holding-manual-valuation', holdingId],
    queryFn: () => getActiveManualValuation(holdingId),
    enabled: holding.data?.holdingKind === 'graded_card',
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

  const voidMutation = useMutation({
    mutationFn: (lotId: string) => voidAcquisitionLot(lotId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holding-lots', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
    },
  })

  const valuationMutation = useMutation({
    mutationFn: (valueMinor: bigint) => setManualValuation({ holdingId, valueMinor }),
    onSuccess: async () => {
      setManualValueInput('')
      await queryClient.invalidateQueries({ queryKey: ['holding-manual-valuation', holdingId] })
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
  const displayName = h.cardName ?? h.manualName ?? 'Unknown card'
  const setName = h.cardSetName ?? h.manualSetName
  const number = h.cardLocalId ?? h.manualCollectorNumber
  const storage = storageSummary(lots.data ?? [])
  const liveLotCount = (lots.data ?? []).filter((l) => !l.voidedAt).length

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <Link to="/portfolio" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to Portfolio
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row">
        <CardImage
          imageBaseUrl={h.cardImageBaseUrl}
          alt={displayName}
          quality="high"
          className="h-64 w-48 self-center sm:self-start"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{displayName}</h1>
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
            {[setName, number ? `#${number}` : null].filter(Boolean).join(' · ')}
          </p>
          {h.manualCardId ? (
            <p className="text-xs text-slate-500">Manual entry — not in the shared catalog</p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-sm">
            {h.holdingKind === 'graded_card' ? (
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
        </div>
      </div>

      {h.holdingKind === 'graded_card' ? (
        <section className="space-y-2 rounded-lg border border-slate-800 p-3">
          <h2 className="text-sm font-semibold text-slate-300">Manual value</h2>
          {manualValuation.data ? (
            <p className="text-sm text-slate-200">
              {formatNokMinor(manualValuation.data.valueMinor)} NOK
              <span className="ml-2 text-xs text-slate-500">
                as of {manualValuation.data.effectiveFrom} · your own estimate, not a market price
              </span>
            </p>
          ) : (
            <p className="text-sm text-slate-500">No manual value set.</p>
          )}
          <div className="flex items-end gap-2">
            <TextField
              label="Set value (NOK)"
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
              Save
            </Button>
          </div>
          {valueError ? <FormMessage tone="error">{valueError}</FormMessage> : null}
        </section>
      ) : null}

      {/* Acquisition cost summary first, lot-by-lot history behind an expandable section
          (M7 prompt §47-48) — the detail page leads with identity/quantity/condition/storage/cost
          summary, not an accounting ledger. */}
      <section className="space-y-2 rounded-lg border border-slate-800 p-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-300">Acquisition cost</h2>
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
                            confirm('Void this acquisition? It stays visible but no longer counts.')
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
    </div>
  )
}
