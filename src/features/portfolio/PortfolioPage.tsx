import { useCallback, useMemo } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { listPortfolio, getPortfolioCounts, type PortfolioFilters } from '../../data/portfolio'
import { getMyProfile, updateMyProfile, type CollectionView } from '../../data/profile'
import type { PortfolioSortOrder } from '../../data/portfolio'
import { CollectionsBar } from './CollectionsBar'
import { PortfolioToolbar } from './PortfolioToolbar'
import { VirtualGrid } from './VirtualGrid'
import { PortfolioListView, PortfolioTableView } from './ListAndTableViews'

/**
 * Portfolio: the user's owned-card browser (M7 prompt §22-46). "Portfolio" is the user-facing
 * name for what the domain still calls a collection (DECISIONS/PRODUCT_SPEC — internal naming is
 * unchanged, only the surface). Grid/List/Table, density 1-4, sort, quick + full filters and
 * custom collections all read one URL-backed state so back navigation and shared links behave
 * (M7 prompt §38); Sort/Density/View changes also persist to the profile so they survive a
 * session (M7 prompt §66/§118).
 */
export function PortfolioPage() {
  const search = useSearch({ from: '/portfolio' })
  const navigate = useNavigate({ from: '/portfolio' })
  const queryClient = useQueryClient()

  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const counts = useQuery({ queryKey: ['portfolio-counts'], queryFn: getPortfolioCounts })

  const sort: PortfolioSortOrder =
    search.sort ?? profile.data?.collectionDefaultSort ?? 'value_desc'
  const view: CollectionView = search.view ?? profile.data?.collectionDefaultView ?? 'grid'
  const density = search.density ?? profile.data?.collectionGridDensity ?? 2

  const filters: PortfolioFilters = useMemo(
    () => ({
      query: search.q,
      setId: search.setId,
      condition: search.condition,
      graded: search.graded,
      grader: search.grader,
      favorite: search.favorite,
      language: search.language,
      manualOnly: search.manualOnly,
      customCollectionId: search.collectionId,
      storageLocationId: search.storageLocationId,
      tagId: search.tagId,
      lowValue: search.lowValue,
      missingValue: search.missingValue,
    }),
    [search],
  )

  const portfolio = useInfiniteQuery({
    queryKey: ['portfolio', sort, filters],
    queryFn: ({ pageParam }) => listPortfolio({ sort, filters, cursor: pageParam }),
    initialPageParam: null as Awaited<ReturnType<typeof listPortfolio>>['nextCursor'],
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  })

  const tiles = portfolio.data?.pages.flatMap((p) => p.results) ?? []
  const hasMore = portfolio.hasNextPage

  const fetchNext = useCallback(() => {
    if (!portfolio.isFetchingNextPage && portfolio.hasNextPage) {
      void portfolio.fetchNextPage()
    }
  }, [portfolio])

  const updateSearch = useCallback(
    (patch: Partial<typeof search>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
    },
    [navigate],
  )

  const filterCount = Object.values(filters).filter((v) => v !== undefined && v !== '').length
  const hasAnyFilter = filterCount > 0 || search.collectionId !== undefined

  const resultLabel =
    counts.data && !hasAnyFilter
      ? `${counts.data.uniqueHoldingCount.toLocaleString('nb-NO')} holdings · ${counts.data.physicalCardCount.toLocaleString('nb-NO')} cards`
      : `${tiles.length.toLocaleString('nb-NO')}${hasMore ? '+' : ''} matching`

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 py-2">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Portfolio</h1>
        <Link
          to="/catalog"
          className="min-h-11 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500"
        >
          Add card
        </Link>
      </header>

      <CollectionsBar
        activeId={search.collectionId}
        onSelect={(id) => {
          updateSearch({ collectionId: id })
        }}
      />

      <PortfolioToolbar
        resultLabel={resultLabel}
        sort={sort}
        onSortChange={(next) => {
          updateSearch({ sort: next })
          void updateMyProfile({ collectionDefaultSort: next })
          void queryClient.invalidateQueries({ queryKey: ['my-profile'] })
        }}
        density={density}
        onDensityChange={(next) => {
          updateSearch({ density: next })
          void updateMyProfile({ collectionGridDensity: next })
          void queryClient.invalidateQueries({ queryKey: ['my-profile'] })
        }}
        view={view}
        onViewChange={(next) => {
          updateSearch({ view: next })
          void updateMyProfile({ collectionDefaultView: next })
          void queryClient.invalidateQueries({ queryKey: ['my-profile'] })
        }}
        filters={filters}
        onFiltersChange={(next) => {
          updateSearch({
            q: next.query,
            setId: next.setId,
            condition: next.condition,
            graded: next.graded,
            grader: next.grader,
            favorite: next.favorite,
            language: next.language,
            manualOnly: next.manualOnly,
            storageLocationId: next.storageLocationId,
            tagId: next.tagId,
            lowValue: next.lowValue,
            missingValue: next.missingValue,
          })
        }}
      />

      {portfolio.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="aspect-[5/7] animate-pulse rounded-lg bg-slate-800/60" />
          ))}
        </div>
      ) : portfolio.isError ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          The Portfolio could not be loaded. Try again.
        </p>
      ) : tiles.length === 0 ? (
        <EmptyState hasFilters={hasAnyFilter} inCollection={search.collectionId !== undefined} />
      ) : view === 'grid' ? (
        <VirtualGrid tiles={tiles} density={density} onEndReached={fetchNext} hasMore={hasMore} />
      ) : view === 'list' ? (
        <PortfolioListView tiles={tiles} onEndReached={fetchNext} hasMore={hasMore} />
      ) : (
        <PortfolioTableView tiles={tiles} onEndReached={fetchNext} hasMore={hasMore} />
      )}
    </div>
  )
}

/** Three honest, distinct empty states (M7 prompt §87) — never one generic "Nothing here". */
function EmptyState({ hasFilters, inCollection }: { hasFilters: boolean; inCollection: boolean }) {
  if (hasFilters) {
    return (
      <div className="space-y-2 py-12 text-center">
        <p className="text-sm text-slate-400">No cards match the current filters.</p>
        <Link
          to="/portfolio"
          className="inline-block min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Clear filters
        </Link>
      </div>
    )
  }
  if (inCollection) {
    return (
      <div className="space-y-3 py-12 text-center">
        <p className="text-sm text-slate-400">This collection has no cards yet.</p>
        <Link
          to="/catalog"
          className="inline-block min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Search the catalog to add one
        </Link>
      </div>
    )
  }
  return (
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
  )
}
