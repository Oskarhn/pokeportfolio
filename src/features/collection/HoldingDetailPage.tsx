import { useState } from 'react'
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
import { CardImage } from '../catalog/CardImage'
import { Button, FormMessage, TextField } from '../../ui/form'
import { formatNokMinor, parseNokInput } from '../../ui/money-format'
import { CONDITION_LABEL, FINISH_LABEL, GRADER_LABEL, ORIGIN_LABEL } from './labels'

export function HoldingDetailPage() {
  const { holdingId } = useParams({ from: '/collection/$holdingId' })
  const queryClient = useQueryClient()
  const [manualValueInput, setManualValueInput] = useState('')
  const [valueError, setValueError] = useState<string | null>(null)

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

  const favoriteMutation = useMutation({
    mutationFn: (next: boolean) => toggleFavorite(holdingId, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['collection-holdings'] })
    },
  })

  const voidMutation = useMutation({
    mutationFn: (lotId: string) => voidAcquisitionLot(lotId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holding-lots', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['collection-holdings'] })
      await queryClient.invalidateQueries({ queryKey: ['collection-counts'] })
    },
  })

  const valuationMutation = useMutation({
    mutationFn: (valueMinor: bigint) => setManualValuation({ holdingId, valueMinor }),
    onSuccess: async () => {
      setManualValueInput('')
      await queryClient.invalidateQueries({ queryKey: ['holding-manual-valuation', holdingId] })
    },
  })

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
        <Link to="/collection" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Back to collection
        </Link>
      </div>
    )
  }

  const h = holding.data
  const displayName = h.cardName ?? h.manualName ?? 'Unknown card'
  const setName = h.cardSetName ?? h.manualSetName
  const number = h.cardLocalId ?? h.manualCollectorNumber

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <Link to="/collection" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to collection
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

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">Acquisition lots</h2>
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

        {lots.isPending ? (
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
        )}
      </section>
    </div>
  )
}
