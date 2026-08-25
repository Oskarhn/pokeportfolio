import { useState } from 'react'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OpeningDetail } from './contract'
import { getOpeningController } from './controller'
import {
  INCOMPLETE_TRACKING_MARKER,
  OPENING_COST_LABEL,
  OPENING_RECORDED_ANNOUNCEMENT,
  PURCHASE_COST_NOT_RECORDED,
  RESULT_UNAVAILABLE_COPY,
  VOID_EXPLANATION,
  VOID_PURCHASE_NOTE,
  VOID_TITLE,
  formatNok,
  resultCopy,
} from './copy'
import { Button, FormMessage } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'

/**
 * Opening Detail (prompt §16): everything the act of opening produced, with the honesty rules of
 * FINANCIAL_MODEL.md §5 applied at the display layer — cost is a figure or "not recorded" (never
 * 0), the result is kroner-first and only carries a percentage when tracking is complete and the
 * cost is known (copy.ts enforces this centrally), and per-pull rows never imply an individual
 * ROI. Fields the backend adapter cannot provide yet (P53) are simply absent rather than faked.
 */
export function OpeningDetailPage() {
  const { openingId } = useParams({ from: '/openings/$openingId' })
  const search = useSearch({ from: '/openings/$openingId' })
  const queryClient = useQueryClient()
  const controller = getOpeningController()
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)

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
        {detail.costProvisional === true ? (
          <p className="text-xs text-slate-500">
            Cost entered manually — not linked to a purchase.
          </p>
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
                <span className="block text-xs text-amber-300">{result.incompleteMarker}</span>
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
            {detail.pulls.map((pull) => (
              <li key={pull.lotId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-100">{pull.displayName}</p>
                  <p className="truncate text-xs text-slate-500">
                    ×{pull.quantity}
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
            ))}
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
          <span className="block text-xs text-amber-300">{INCOMPLETE_TRACKING_MARKER}</span>
        ) : null}
      </span>
    </div>
  )
}

/** Retained/sold aggregates — rendered only when the adapter actually provides them; a missing
 *  field hides its row rather than inventing a zero (prompt §16's graceful optional states). */
function PullValueSection({ detail }: { detail: OpeningDetail }) {
  const retained = detail.retainedTrackedValueNokMinor
  const sold = detail.soldPullProceedsNokMinor
  if (retained === undefined && sold === undefined) return null
  return (
    <section className="space-y-2 rounded-2xl border border-slate-800 p-4 text-sm">
      {retained !== undefined ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-slate-500">Current value of retained pulls</span>
          <span className="tabular-nums text-slate-100">
            {retained === null ? RESULT_UNAVAILABLE_COPY : `${formatNok(retained)} kr`}
          </span>
        </div>
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
