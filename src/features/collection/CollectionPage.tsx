import { Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getCollectionCounts, listHoldings, type HoldingSummary } from '../../data/collection'
import { CardImage } from '../catalog/CardImage'
import { CONDITION_LABEL } from './labels'

const PAGE_SIZE = 30

function holdingDisplayName(h: HoldingSummary): string {
  return h.cardName ?? h.manualName ?? 'Unknown card'
}

function holdingSubtitle(h: HoldingSummary): string {
  const setName = h.cardSetName ?? h.manualSetName
  const number = h.cardLocalId ?? h.manualCollectorNumber
  if (setName && number) return `${setName} · #${number}`
  return setName ?? (number ? `#${number}` : '')
}

/** Mobile density is fixed at 2 columns for M6 — the configurable 1/2/3/4 setting is M7's
 *  (DESIGN_SYSTEM.md §4.1, ROADMAP.md M7 entry). Desktop naturally gets more columns from the
 *  same grid via a wider breakpoint. */
function CollectionTile({ holding }: { holding: HoldingSummary }) {
  return (
    <Link
      to="/collection/$holdingId"
      params={{ holdingId: holding.holdingId }}
      className="group flex flex-col gap-2 rounded-lg p-2 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
    >
      <div className="relative">
        <CardImage
          imageBaseUrl={holding.cardImageBaseUrl}
          alt={holdingDisplayName(holding)}
          quality="low"
          className="aspect-[5/7] w-full"
        />
        <span className="absolute right-1 top-1 rounded-full bg-slate-950/80 px-2 py-0.5 text-xs font-semibold text-slate-100">
          ×{holding.quantity}
        </span>
        {holding.isFavorite ? (
          <span aria-hidden className="absolute left-1 top-1 text-sm text-amber-400">
            ★
          </span>
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-100">{holdingDisplayName(holding)}</p>
        <p className="truncate text-xs text-slate-400">{holdingSubtitle(holding)}</p>
        <p className="truncate text-xs text-slate-500">
          {holding.holdingKind === 'graded_card'
            ? `${holding.grader?.toUpperCase() ?? ''} ${holding.grade ?? ''}`.trim()
            : holding.condition
              ? CONDITION_LABEL[holding.condition]
              : null}
          {holding.manualCardId ? ' · Manual entry' : ''}
        </p>
      </div>
    </Link>
  )
}

export function CollectionPage() {
  const counts = useQuery({ queryKey: ['collection-counts'], queryFn: getCollectionCounts })

  const holdings = useInfiniteQuery({
    queryKey: ['collection-holdings'],
    queryFn: ({ pageParam }) => listHoldings({ offset: pageParam * PAGE_SIZE, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.hasMore ? allPages.length : undefined),
  })

  const results = holdings.data?.pages.flatMap((p) => p.results) ?? []

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 py-2">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Collection</h1>
          {counts.data ? (
            <p className="text-sm text-slate-400">
              {counts.data.physicalCardCount.toLocaleString('nb-NO')} cards ·{' '}
              {counts.data.uniqueHoldingCount.toLocaleString('nb-NO')} unique
            </p>
          ) : null}
        </div>
        <Link
          to="/catalog"
          className="min-h-11 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500"
        >
          Add card
        </Link>
      </header>

      {holdings.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-busy="true">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="aspect-[5/7] animate-pulse rounded-lg bg-slate-800/60" />
          ))}
        </div>
      ) : holdings.isError ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          The collection could not be loaded. Try again.
        </p>
      ) : results.length === 0 ? (
        <div className="space-y-3 py-12 text-center">
          <p className="text-sm text-slate-400">
            No cards yet. Search the catalog to add your first card.
          </p>
          <Link
            to="/catalog"
            className="inline-block min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
          >
            Search the catalog
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {results.map((holding) => (
              <CollectionTile key={holding.holdingId} holding={holding} />
            ))}
          </div>
          {holdings.hasNextPage ? (
            <button
              type="button"
              onClick={() => {
                void holdings.fetchNextPage()
              }}
              disabled={holdings.isFetchingNextPage}
              className="min-h-11 w-full rounded-lg border border-slate-700 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60"
            >
              {holdings.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
