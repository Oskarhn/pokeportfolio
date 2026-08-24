import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { reduceHoldingQuantity, type AcquisitionLot } from '../../data/collection'
import { ORIGIN_LABEL } from './labels'
import { Sheet } from '../../ui/Sheet'
import { Button, FormMessage, TextField } from '../../ui/form'

/** Short per-lot cost wording for the adjustment sheet — the same semantics as the acquisition
 *  history's labels, condensed for a row. Unknown cost stays unknown; it never reads as zero. */
function lotCostLabel(lot: AcquisitionLot): string {
  if (lot.costBasisState === 'known' && lot.unitCostBasisMinor !== null) return 'Recorded cost'
  if (lot.costBasisState === 'unallocated_opening') return 'From opening — no individual cost'
  if (lot.costBasisState === 'not_paid') return 'No cost — not paid'
  if (lot.costBasisState === 'trade_in') return 'Received in trade — no cost basis'
  return 'Cost unknown'
}

/**
 * Holding Detail's "Adjust quantity" sheet (P28). Asks how many copies to REMOVE per lot — the
 * direction that matches the action being taken — and shows current → new → removed before the
 * user confirms. Per-lot provenance is always visible so a multi-lot holding is corrected
 * deliberately rather than against an arbitrary economic lot.
 *
 * Purchased lots are not adjustable here by design: their quantity is part of their receipt, and
 * correcting it in place would desync inventory from CS/GPO. They render as a link to the receipt
 * editor instead. Partially-sold lots are blocked outright (their remaining copies still reconcile
 * against frozen sale history). Both mirror reduce_holding_quantity's own server-side guards
 * (20260831120000) — this UI never offers what the database will refuse.
 */
export function AdjustQuantitySheet({
  open,
  onClose,
  holdingId,
  holdingName,
  currentQuantity,
  lots,
}: {
  open: boolean
  onClose: () => void
  holdingId: string
  holdingName: string
  currentQuantity: number
  lots: AcquisitionLot[]
}) {
  const queryClient = useQueryClient()
  const [removals, setRemovals] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  const liveLots = lots.filter((l) => !l.voidedAt)

  const removeTotal = useMemo(
    () => liveLots.reduce((sum, l) => sum + (removals[l.id] ?? 0), 0),
    [liveLots, removals],
  )
  const newQuantity = currentQuantity - removeTotal

  const mutation = useMutation({
    mutationFn: () =>
      reduceHoldingQuantity({
        holdingId,
        reductions: liveLots
          .filter((l) => (removals[l.id] ?? 0) > 0)
          .map((l) => ({ lotId: l.id, removeQuantity: removals[l.id] ?? 0 })),
      }),
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['holding-lots', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-value-provenance', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      onClose()
    },
    onError: (mutationError: Error) => {
      setError(mutationError.message)
    },
  })

  return (
    <Sheet open={open} onClose={onClose} title="Adjust quantity">
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          Correct how many copies of {holdingName} you own. This corrects your tracking — it is not
          recorded as a sale, and nothing is deleted.
        </p>

        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {liveLots.map((lot) => {
            const purchased = lot.purchaseLineId !== null
            const partiallyDisposed = lot.quantityRemaining !== lot.quantity
            const adjustable = !purchased && !partiallyDisposed
            return (
              <li key={lot.id} className="space-y-1 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 text-sm text-slate-200">
                    ×{lot.quantityRemaining}
                    {partiallyDisposed ? ` of ${lot.quantity}` : ''} · {ORIGIN_LABEL[lot.origin]} ·{' '}
                    {lot.acquiredOn}
                  </span>
                  {adjustable && lot.quantityRemaining > 0 ? (
                    <div className="w-24 shrink-0">
                      <TextField
                        label="Remove"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={lot.quantityRemaining}
                        value={String(removals[lot.id] ?? 0)}
                        onChange={(event) => {
                          setError(null)
                          const parsed = Number.parseInt(event.target.value, 10)
                          const next =
                            Number.isFinite(parsed) && parsed > 0
                              ? Math.min(parsed, lot.quantityRemaining)
                              : 0
                          setRemovals((prev) => ({ ...prev, [lot.id]: next }))
                        }}
                      />
                    </div>
                  ) : purchased && !partiallyDisposed ? (
                    lot.purchaseId ? (
                      <Link
                        to="/purchases/$purchaseId/edit"
                        params={{ purchaseId: lot.purchaseId }}
                        className="shrink-0 text-xs text-sky-400 underline-offset-4 hover:underline"
                      >
                        Correct via receipt →
                      </Link>
                    ) : (
                      <span className="shrink-0 text-xs text-slate-500">Correct via receipt</span>
                    )
                  ) : (
                    <span className="shrink-0 text-xs text-slate-500">Can’t adjust</span>
                  )}
                </div>
                <p className="text-xs text-slate-400">{lotCostLabel(lot)}</p>
                {purchased && !partiallyDisposed ? (
                  <p className="text-xs text-slate-500">
                    Bought copies belong to a receipt — adjust them there so the spending record
                    stays consistent.
                  </p>
                ) : partiallyDisposed ? (
                  <p className="text-xs text-slate-500">
                    Some copies were sold earlier — that history is frozen, so this lot can’t be
                    corrected here.
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>

        <div
          className={
            'rounded-lg border p-3 text-sm ' +
            (removeTotal > 0 ? 'border-slate-700 bg-slate-900/60' : 'border-slate-800')
          }
          aria-live="polite"
        >
          Owned now ×{currentQuantity} → after ×{Math.max(newQuantity, 0)} · removing {removeTotal}
        </div>

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}

        <Button
          variant="primary"
          disabled={removeTotal === 0 || newQuantity < 1 || mutation.isPending}
          onClick={() => {
            setError(null)
            mutation.mutate()
          }}
        >
          {mutation.isPending ? 'Saving…' : `Correct to ×${Math.max(newQuantity, 0)}`}
        </Button>
      </div>
    </Sheet>
  )
}
