import { useState } from 'react'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OpeningDetail } from './contract'
import { getOpeningController } from './controller'
import {
  INCOMPLETE_TRACKING_MARKER,
  OPENING_COST_LABEL,
  OPENING_RECORDED_ANNOUNCEMENT,
  PROVISIONAL_COST_NOTE,
  PROVISIONAL_LINK_HINT,
  PURCHASE_COST_NOT_RECORDED,
  RECONCILED_STATE_LABEL,
  RECONCILE_EMPTY_COPY,
  RECONCILE_EMPTY_HINT,
  RECONCILE_EXPLANATION,
  RECONCILE_TITLE,
  RESULT_UNAVAILABLE_COPY,
  UNPRICED_RETAINED_MARKER,
  VOID_EXPLANATION,
  VOID_PURCHASE_NOTE,
  VOID_TITLE,
  formatNok,
  openingCostPreview,
  pullRemainingCopy,
  resultCopy,
} from './copy'
import { Button, FormMessage } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'

/**
 * Opening Detail (prompt §16): everything the act of opening produced, with the honesty rules of
 * FINANCIAL_MODEL.md §5 applied at the display layer — cost is a figure or "not recorded" (never
 * 0), the result is kroner-first and only carries a percentage when tracking is complete and the
 * cost is known (copy.ts enforces this centrally), and per-pull rows never imply an individual
 * ROI. A provisionally-costed opening states where its figure came from and offers the
 * Link-to-recorded-purchase action (P59); a fully-sold pull never reads like a held card.
 */
export function OpeningDetailPage() {
  const { openingId } = useParams({ from: '/openings/$openingId' })
  const search = useSearch({ from: '/openings/$openingId' })
  const queryClient = useQueryClient()
  const controller = getOpeningController()
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [reconcileError, setReconcileError] = useState<string | null>(null)

  const opening = useQuery({
    queryKey: ['opening', openingId],
    queryFn: () => controller.getOpening(openingId),
    retry: false,
  })

  function invalidateAfterChange() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ['portfolio'] }),
      queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['spending-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['history-events'] }),
      queryClient.invalidateQueries({ queryKey: ['holding-lots'] }),
      queryClient.invalidateQueries({ queryKey: ['opening-sources'] }),
      // Recent activity carries the opening row; its amount follows the reconciled cost (P59).
      queryClient.invalidateQueries({ queryKey: ['recent-activity'] }),
    ])
  }

  // The backend owns every blocking rule (a pull already sold names its sale); this client shows
  // that reason verbatim and offers no workaround — there is deliberately no hard delete here.
  const voidMutation = useMutation({
    mutationFn: () => controller.voidOpening(openingId),
    onSuccess: async (outcome) => {
      if (outcome.blocked) {
        setVoidError(outcome.blockedReason ?? 'This opening cannot be corrected right now.')
        return
      }
      setVoidError(null)
      await invalidateAfterChange()
      await queryClient.invalidateQueries({ queryKey: ['opening', openingId] })
      setVoidOpen(false)
    },
    onError: (error: Error) => {
      setVoidError(error.message)
    },
  })

  // Linking a provisional opening to its real receipt (P59 §9). Hooks stay above every early
  // return so the component's hook order is stable while the query loads.
  const reconcileMutation = useMutation({
    mutationFn: (realSourceLotId: string) =>
      controller.reconcileOpeningCost(openingId, realSourceLotId),
    onSuccess: async () => {
      setReconcileError(null)
      await invalidateAfterChange()
      await queryClient.invalidateQueries({ queryKey: ['opening', openingId] })
      setReconcileOpen(false)
    },
    onError: (error: Error) => {
      setReconcileError(error.message)
    },
  })

  if (opening.isPending) {
    return (
      <div className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-lg bg-slate-800/60" />
    )
  }
  if (opening.isError) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <Link to="/history" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Back to History
        </Link>
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          {opening.error instanceof Error
            ? opening.error.message
            : 'That opening could not be found.'}
        </p>
      </div>
    )
  }

  const detail: OpeningDetail = opening.data
  const result = resultCopy(detail)
  const isVoided = detail.voidedAt != null && detail.voidedAt !== ''
  const trackedCount = detail.pulls.reduce((sum, pull) => sum + pull.quantity, 0)

  // The link action exists exactly while the opening still cites its own entered total: active,
  // provisionally purchased, and not yet reconciled (FINANCIAL_MODEL §5.5 / prompt P59 §9).
  const canReconcile = detail.costProvisional === true && !isVoided

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2 pb-24">
      <Link to="/history" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to History
      </Link>

      {search.created ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-lg border border-emerald-900/60 bg-emerald-950/40 p-3 text-sm text-emerald-200"
        >
          {OPENING_RECORDED_ANNOUNCEMENT}
        </p>
      ) : null}

      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">
          {detail.productName}
        </h1>
        <p className="text-sm text-slate-400">
          Opened {detail.quantityOpened === 1 ? '×1 unit' : `×${detail.quantityOpened} units`} ·{' '}
          {detail.openedOn}
        </p>
        {isVoided ? (
          <p className="mt-2 inline-block rounded-full border border-dashed border-slate-700 px-2 py-0.5 text-xs text-slate-500">
            Voided — sealed quantity restored, pull records corrected
          </p>
        ) : null}
      </header>

      <section className="space-y-2 rounded-2xl border border-slate-800 p-4 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-slate-500">{OPENING_COST_LABEL}</span>
          {detail.costKnown && detail.costNokMinor !== null ? (
            <span className="tabular-nums text-slate-100">{formatNok(detail.costNokMinor)} kr</span>
          ) : (
            <span className="text-slate-400">{PURCHASE_COST_NOT_RECORDED}</span>
          )}
        </div>
        {/* Provenance stated honestly (P59 §13): before reconciliation the figure came from the
            total the user typed — which IS a real spend-counted purchase (FINANCIAL_MODEL §5.5);
            after reconciliation it cites the actual recorded receipt. Internal purchase ids are
            never shown. */}
        {detail.costProvisional === true ? (
          <div className="space-y-1 text-xs text-slate-500">
            <p>{PROVISIONAL_COST_NOTE}</p>
            <p>{PROVISIONAL_LINK_HINT}</p>
          </div>
        ) : detail.reconciledAt != null && detail.reconciledAt !== '' ? (
          <p className="inline-block rounded-full border border-emerald-900/60 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-300">
            {RECONCILED_STATE_LABEL} · {detail.reconciledAt.slice(0, 10)}
          </p>
        ) : null}
        {canReconcile ? (
          <Button
            type="button"
            variant="quiet"
            className="w-auto border border-slate-700 text-slate-200 hover:bg-slate-800"
            onClick={() => {
              setReconcileError(null)
              setReconcileOpen(true)
            }}
          >
            Link to purchase
          </Button>
        ) : null}
        <CompletenessLine completeness={detail.trackingCompleteness} />

        {/* Optional result fields: absent while the adapter lacks them; "—" when genuinely
            unavailable (unknown cost). The incomplete marker rides along wherever it applies. */}
        {result ? (
          <div className="flex items-baseline justify-between gap-3 border-t border-slate-800 pt-2">
            <span className="text-slate-500">Opening result</span>
            <span className="text-right">
              <span className="tabular-nums text-slate-100">{result.headline}</span>
              {result.percentage ? (
                <span className="block text-xs tabular-nums text-slate-400">
                  {result.percentage}
                </span>
              ) : null}
              {result.incompleteMarker ? (
                <span className="block text-xs text-slate-400">{result.incompleteMarker}</span>
              ) : null}
            </span>
          </div>
        ) : null}
      </section>

      <PullValueSection detail={detail} />
      <BulkEstimateLine detail={detail} />

      <section className="space-y-2 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-200">Tracked pulls ({trackedCount})</h2>
        <p className="text-xs text-slate-500">
          Pulled cards carry no individual purchase cost and no per-card ROI — results belong to the
          whole opening.
        </p>
        {detail.pulls.length > 0 ? (
          <ul className="divide-y divide-slate-800">
            {detail.pulls.map((pull) => {
              const heldState = pullRemainingCopy(pull.quantity, pull.quantityRemaining)
              return (
                <li key={pull.lotId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-slate-100">{pull.displayName}</p>
                    <p className="truncate text-xs text-slate-500">
                      ×{pull.quantity}
                      {heldState ? ` · ${heldState}` : ''}
                      {pull.subtitle ? ` · ${pull.subtitle}` : ''}
                      {typeof pull.soldProceedsNokMinor === 'bigint'
                        ? ` · sold for ${formatNok(pull.soldProceedsNokMinor)} kr`
                        : ''}
                    </p>
                  </div>
                  <span className="shrink-0 tabular-nums text-sm text-slate-400">
                    {pull.currentValueNokMinor === undefined
                      ? null
                      : pull.currentValueNokMinor === null
                        ? RESULT_UNAVAILABLE_COPY
                        : `${formatNok(pull.currentValueNokMinor)} kr`}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">
            No cards were recorded individually for this opening.
          </p>
        )}
      </section>

      {!isVoided ? (
        <Button
          type="button"
          variant="quiet"
          className="border border-rose-900/60 text-rose-300 hover:bg-rose-950/40"
          disabled={voidMutation.isPending}
          onClick={() => {
            setVoidError(null)
            setVoidOpen(true)
          }}
        >
          Void / correct opening
        </Button>
      ) : null}

      {voidError ? <FormMessage tone="error">{voidError}</FormMessage> : null}
      {reconcileError ? <FormMessage tone="error">{reconcileError}</FormMessage> : null}

      <Sheet
        open={voidOpen}
        onClose={() => {
          setVoidOpen(false)
        }}
        title={VOID_TITLE}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">{VOID_EXPLANATION}</p>
          <p className="text-xs text-slate-500">{VOID_PURCHASE_NOTE}</p>
          <p className="text-xs text-slate-500">
            This corrects your records. It is not a sale — no proceeds and no result are created,
            and nothing is deleted.
          </p>
          {voidError ? <FormMessage tone="error">{voidError}</FormMessage> : null}
          <Button
            variant="primary"
            className="border border-rose-900/60 bg-rose-900/80 hover:bg-rose-800"
            disabled={voidMutation.isPending}
            onClick={() => {
              voidMutation.mutate()
            }}
          >
            {voidMutation.isPending ? 'Correcting…' : 'Yes, correct this opening'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setVoidOpen(false)
            }}
            className="min-h-11 w-full rounded-lg text-sm text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
        </div>
      </Sheet>

      {canReconcile ? (
        <ReconcileSheet
          open={reconcileOpen}
          detail={detail}
          pending={reconcileMutation.isPending}
          error={reconcileError}
          onPick={(lotId) => {
            reconcileMutation.mutate(lotId)
          }}
          onClose={() => {
            setReconcileOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function CompletenessLine({
  completeness,
}: {
  completeness: OpeningDetail['trackingCompleteness']
}) {
  const label =
    completeness === 'all_cards'
      ? 'Tracking complete — every pulled card was recorded.'
      : completeness === 'selected_pulls'
        ? 'Tracked pulls only'
        : 'Tracking uncertain'
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">Recorded</span>
      <span className="text-right">
        <span className="text-slate-300">{label}</span>
        {completeness !== 'all_cards' ? (
          <span className="block text-xs text-slate-400">{INCOMPLETE_TRACKING_MARKER}</span>
        ) : null}
      </span>
    </div>
  )
}

/**
 * Retained/sold aggregates — rendered only when the adapter actually provides them; a missing
 * field hides its row rather than inventing a zero (prompt §16's graceful optional states).
 *
 * Coverage honesty (P59 §16): when any retained pull has no current price, a restrained marker
 * says so beside the figure; when NO retained pull is priced, the aggregate renders "—", never a
 * fabricated complete-looking 0 kr.
 */
function PullValueSection({ detail }: { detail: OpeningDetail }) {
  const retained = detail.retainedTrackedValueNokMinor
  const sold = detail.soldPullProceedsNokMinor
  const pricedCount = detail.pricedPullLotCount
  const unpricedCount = detail.unpricedPullLotCount
  const hasCoverageInfo = pricedCount !== undefined && unpricedCount !== undefined
  const allRetainedUnpriced = hasCoverageInfo && pricedCount === 0 && unpricedCount > 0
  if (retained === undefined && sold === undefined) return null

  const retainedDisplay =
    retained !== undefined && retained !== null && !allRetainedUnpriced
      ? `${formatNok(retained)} kr`
      : RESULT_UNAVAILABLE_COPY

  return (
    <section className="space-y-2 rounded-2xl border border-slate-800 p-4 text-sm">
      {retained !== undefined ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-slate-500">Current value of retained pulls</span>
            <span className="tabular-nums text-slate-100">{retainedDisplay}</span>
          </div>
          {hasCoverageInfo && unpricedCount > 0 ? (
            <p className="text-xs text-slate-400">{UNPRICED_RETAINED_MARKER}</p>
          ) : null}
        </>
      ) : null}
      {sold !== undefined ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-slate-500">Sold-pull proceeds</span>
          <span className="tabular-nums text-slate-100">
            {sold === null ? RESULT_UNAVAILABLE_COPY : `${formatNok(sold)} kr`}
          </span>
        </div>
      ) : null}
    </section>
  )
}

/**
 * The Link-to-recorded-purchase picker (P59 §9–§11). A simple sheet over the owner's own
 * openable lots (the existing bounded INVOKER read, one request — no N+1), client-filtered to
 * mirror the server's own target rule for usability: same sealed product, live lot with enough
 * remaining quantity, known basis, parent purchase present/live and NOT itself provisional, and
 * never the opening's current source lot. `reconcile_opening_cost` stays authoritative — anything
 * this filter misses fails there behind a safe mapped message. Rows show date, available
 * quantity and the exact cost this opening would freeze; no UUIDs anywhere.
 */
function ReconcileSheet({
  open,
  detail,
  pending,
  error,
  onPick,
  onClose,
}: {
  open: boolean
  detail: OpeningDetail
  pending: boolean
  error: string | null
  onPick: (realSourceLotId: string) => void
  onClose: () => void
}) {
  const controller = getOpeningController()
  const sourcesQuery = useQuery({
    queryKey: ['opening-sources', null],
    queryFn: () => controller.getEligibleSealedSources(),
    enabled: open,
    retry: false,
  })

  const eligible = (sourcesQuery.data ?? []).filter(
    (source) =>
      source.productId === detail.sealedProductId &&
      source.lotId !== detail.sourceLotId &&
      source.costKnown &&
      source.quantityAvailable >= detail.quantityOpened &&
      source.purchaseOrigin !== 'provisional_opening',
  )

  return (
    <Sheet open={open} onClose={onClose} title={RECONCILE_TITLE}>
      <div className="space-y-3">
        <p className="text-sm text-slate-300">{RECONCILE_EXPLANATION}</p>
        {sourcesQuery.isPending ? (
          <div className="h-20 animate-pulse rounded-lg bg-slate-800/60" />
        ) : sourcesQuery.isError ? (
          <p role="alert" className="text-sm text-rose-300">
            Recorded purchases could not be loaded.
          </p>
        ) : eligible.length === 0 ? (
          <div className="space-y-2 rounded-lg border border-dashed border-slate-800 p-4 text-sm">
            <p className="text-slate-300">{RECONCILE_EMPTY_COPY}</p>
            <p className="text-xs text-slate-500">{RECONCILE_EMPTY_HINT}</p>
          </div>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {eligible.map((source) => {
              const preview = openingCostPreview(source, detail.quantityOpened)
              return (
                <li key={source.lotId}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      onPick(source.lotId)
                    }}
                    className="min-h-14 w-full rounded-xl border border-slate-800 px-3 py-2 text-left hover:bg-slate-800/40 disabled:opacity-60"
                  >
                    <span className="block truncate text-sm font-medium text-slate-100">
                      {source.productName}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      Purchased {source.purchasedOn ?? source.acquiredOn} ·{' '}
                      {source.quantityAvailable} unopened
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {preview.kind === 'known'
                        ? `Cost for this opening: ${formatNok(preview.minorUnits)} kr`
                        : PURCHASE_COST_NOT_RECORDED}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 w-full rounded-lg text-sm text-slate-400 hover:text-slate-200"
        >
          Cancel
        </button>
      </div>
    </Sheet>
  )
}

function BulkEstimateLine({ detail }: { detail: OpeningDetail }) {
  if (detail.bulkRemainderEstimateMinor === null) return null
  return (
    <p className="rounded-lg border border-dashed border-slate-800 p-3 text-sm text-slate-400">
      ≈ {formatNok(detail.bulkRemainderEstimateMinor)} kr
      {detail.bulkRemainderCount !== null ? ` · ~${detail.bulkRemainderCount} cards` : ''} · your
      own estimate of untracked cards, not a recorded value.
    </p>
  )
}
