import { useCallback } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { listHistoryEvents, type HistoryEvent, type HistoryEventKind } from '../../data/history'
import { toDecimalString } from '../../domain/money'

/**
 * Unified History (P43; M16 adds the opening event kind). One feed over the canonical event
 * sources — purchases, sales, openings, non-purchase additions and active manual valuations —
 * with a voided/corrections toggle that is presentation-only (hiding an entry never alters
 * accounting; corrections themselves go through each event's own edit/void lifecycle,
 * DECISIONS.md D-084/D-085). The opening chip is the P50 data-contract minimum; Opening Detail
 * navigation/presentation belongs to the M16 UI slice.
 */
const KIND_FILTERS: { value: HistoryEventKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'purchase', label: 'Purchases' },
  { value: 'sale', label: 'Sales' },
  { value: 'opening', label: 'Openings' },
  { value: 'acquisition', label: 'Added' },
  { value: 'valuation', label: 'Values' },
]

const KIND_BADGE: Record<HistoryEventKind, string> = {
  purchase: 'Purchase',
  sale: 'Sale',
  opening: 'Opening',
  acquisition: 'Added',
  valuation: 'Value',
}

const PAGE_SIZE = 50

export function HistoryPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/history' })
  const kind = search.kind ?? 'all'
  const showVoided = search.voided ?? false

  const events = useInfiniteQuery({
    queryKey: ['history-events', kind, showVoided],
    queryFn: ({ pageParam }) =>
      listHistoryEvents({
        kind: kind === 'all' ? undefined : kind,
        includeVoided: showVoided,
        limit: PAGE_SIZE,
        before: pageParam ?? undefined,
      }),
    initialPageParam: null as { recordedAt: string; primaryId: string } | null,
    getNextPageParam: (lastPage): { recordedAt: string; primaryId: string } | undefined => {
      const last = lastPage.at(-1)
      return last ? { recordedAt: last.recordedAt, primaryId: last.primaryId } : undefined
    },
  })

  const list = events.data?.pages.flat() ?? []
  const fetchNext = useCallback(() => {
    if (!events.isFetchingNextPage && events.hasNextPage) {
      void events.fetchNextPage()
    }
  }, [events])

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 py-2 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">History</h1>
        <Link
          to="/sales/new"
          className="min-h-9 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Record sale
        </Link>
      </div>

      <div
        className="flex gap-1 overflow-x-auto rounded-lg border border-slate-800 p-1"
        role="tablist"
      >
        {KIND_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            role="tab"
            aria-selected={kind === filter.value}
            onClick={() => {
              void navigate({
                to: '/history',
                search: {
                  kind: filter.value === 'all' ? undefined : filter.value,
                  voided: showVoided || undefined,
                },
              })
            }}
            className={`min-h-9 flex-1 whitespace-nowrap rounded-md text-sm font-medium transition-colors ${
              kind === filter.value
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <label className="flex min-h-9 cursor-pointer items-center justify-end gap-2 text-xs text-slate-400">
        Show corrections / voided
        <input
          type="checkbox"
          checked={showVoided}
          onChange={(event) => {
            void navigate({
              to: '/history',
              search: {
                kind: kind === 'all' ? undefined : kind,
                voided: event.target.checked || undefined,
              },
            })
          }}
          className="size-4 accent-sky-600"
        />
      </label>

      {events.isPending ? (
        <div className="space-y-2">
          <div className="h-20 animate-pulse rounded-lg bg-slate-800/60" />
          <div className="h-20 animate-pulse rounded-lg bg-slate-800/60" />
        </div>
      ) : events.isError ? (
        <p role="alert" className="text-sm text-rose-300">
          History could not be loaded.
        </p>
      ) : list.length > 0 ? (
        <>
          <ul className="space-y-2">
            {list.map((event) => (
              <HistoryEventRow key={`${event.kind}-${event.primaryId}`} event={event} />
            ))}
          </ul>
          {events.hasNextPage ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={fetchNext}
                disabled={events.isFetchingNextPage}
                className="min-h-9 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                {events.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState kind={kind} showVoided={showVoided} />
      )}
    </div>
  )
}

function HistoryEventRow({ event }: { event: HistoryEvent }) {
  // The RPC's href names the canonical destination; the router's typed route map resolves it
  // per kind so back-navigation, params and prefetching all behave like any internal link.
  const target =
    event.kind === 'purchase'
      ? { to: '/purchases/$purchaseId', params: { purchaseId: event.primaryId } }
      : event.kind === 'sale'
        ? { to: '/sales/$saleId', params: { saleId: event.primaryId } }
        : {
            to: '/portfolio/$holdingId',
            params: { holdingId: event.secondaryId ?? event.primaryId },
          }
  return (
    <li>
      <Link
        {...target}
        className={`block rounded-lg border p-3 hover:bg-slate-800/40 ${
          event.status === 'voided'
            ? 'border-dashed border-slate-800 opacity-70'
            : 'border-slate-800'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            {KIND_BADGE[event.kind]}
          </span>
          <p className="truncate text-sm font-medium text-slate-100">{event.title}</p>
          {event.status === 'voided' ? (
            <span className="ml-auto shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-500">
              Voided
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
          <span className="truncate">
            {event.subtitle} · {event.occurredOn}
          </span>
          <span className="shrink-0 tabular-nums text-slate-400">
            {event.amountNokMinor !== null
              ? `${toDecimalString({ minorUnits: event.amountNokMinor, currency: 'NOK' })} kr`
              : '—'}
          </span>
        </div>
      </Link>
    </li>
  )
}

function EmptyState({ kind, showVoided }: { kind: HistoryEventKind | 'all'; showVoided: boolean }) {
  if (showVoided) {
    return (
      <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
        Nothing here yet — corrected or voided entries will appear in this view once they exist.
      </p>
    )
  }
  const copy: Record<HistoryEventKind | 'all', string> = {
    all: 'Purchases, sales, openings, added cards and valuations will appear here as they happen.',
    purchase: 'No purchases recorded yet.',
    sale: 'No sales recorded yet — selling a card preserves its cost basis and reduces your Portfolio.',
    opening: 'No openings recorded yet.',
    acquisition: 'No cards or sealed products added outside a purchase yet.',
    valuation: 'No manual valuations set yet.',
  }
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-slate-800 p-6 text-center">
      <p className="text-sm font-medium text-slate-200">Nothing here yet</p>
      <p className="text-xs text-slate-500">{copy[kind]}</p>
      {kind === 'all' || kind === 'purchase' ? (
        <Link
          to="/purchases/new"
          className="inline-flex min-h-9 items-center rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Record purchase
        </Link>
      ) : null}
      {kind === 'sale' ? (
        <Link
          to="/sales/new"
          className="ml-2 inline-flex min-h-9 items-center rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Record sale
        </Link>
      ) : null}
    </div>
  )
}
