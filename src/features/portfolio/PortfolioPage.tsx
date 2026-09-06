import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listPortfolio, getPortfolioCounts, type PortfolioFilters } from '../../data/portfolio'
import { getMyProfile, updateMyProfile, type CollectionView } from '../../data/profile'
import type { PortfolioSortOrder } from '../../data/portfolio'
import { CollectionsBar } from './CollectionsBar'
import { PortfolioToolbar } from './PortfolioToolbar'
import { PortfolioActionMenu } from './PortfolioActionMenu'
import { PortfolioActionShortcuts } from './PortfolioActionShortcuts'
import { BulkActionsBar } from './BulkActionsBar'
import { VirtualGrid } from './VirtualGrid'
import { PortfolioListView, PortfolioTableView } from './ListAndTableViews'
import { ScopeSelector } from '../../ui/ScopeSelector'
import { CurrencySelector } from '../../ui/CurrencySelector'
import { MoneyDisplay, ValuePrivacyToggle } from '../../ui/MoneyDisplay'
import { formatNokMinor } from '../../ui/money-format'
import { useDebouncedValue } from '../../ui/useDebouncedValue'
import { SearchIcon, XIcon, StarIcon } from '../../ui/icons'
import { useUnsavedWorkSource } from '../../platform/unsaved-work-registry'

/**
 * Portfolio: the user's owned-card browser (M7.1 prompt §37-46, owner feedback pass). No generic
 * "Portfolio" page-title chrome any more — identity comes from the content, starting with a search
 * bar the same way Search does. Scope selector, currency and value-privacy header match Home's
 * exactly (same components, same profile preferences — M7.1 prompt §74). Grid/List/Table, density
 * 1-4, sort, quick + full filters and custom collections still read one URL-backed state so back
 * navigation and shared links behave (M7); Sort/Density/View changes still persist to the profile.
 */
export function PortfolioPage() {
  const search = useSearch({ from: '/portfolio' })
  const navigate = useNavigate({ from: '/portfolio' })
  const queryClient = useQueryClient()

  const [queryInput, setQueryInput] = useState(search.q ?? '')
  const debouncedQuery = useDebouncedValue(queryInput, 250)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // F-40 (P89): a live multi-select would otherwise be silently cleared by an app-wide automatic
  // reload exactly like unsubmitted form input — only while there is an actual selection to lose,
  // not merely while select mode is toggled on with nothing picked yet.
  useUnsavedWorkSource('portfolio-bulk-selection', selectMode && selectedIds.size > 0)

  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const counts = useQuery({
    queryKey: ['portfolio-counts'],
    queryFn: () => getPortfolioCounts(),
  })

  const sort: PortfolioSortOrder =
    search.sort ?? profile.data?.collectionDefaultSort ?? 'value_desc'
  const view: CollectionView = search.view ?? profile.data?.collectionDefaultView ?? 'grid'
  const density = search.density ?? profile.data?.collectionGridDensity ?? 2

  const updateSearch = useCallback(
    (patch: Partial<typeof search>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
    },
    [navigate],
  )

  // The search box debounces locally, then pushes into the URL — the URL stays the single source
  // of truth for every filter (PRODUCT_SPEC.md §4.11: "filter state lives in the URL and is
  // shareable"), same as every other Portfolio filter; this only decides *when* that write happens.
  useEffect(() => {
    const trimmed = debouncedQuery.trim()
    if (trimmed !== (search.q ?? '')) {
      updateSearch({ q: trimmed || undefined })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes search.q/updateSearch: this effect only reacts to the debounced input value, not to external URL changes.
  }, [debouncedQuery])

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
      holdingKind: search.holdingKind,
      sealedProductType: search.sealedProductType,
      sealedIntent: search.sealedIntent,
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

  const hideValues = profile.data?.hideValues ?? false
  const toggleHideValues = useMutation({
    mutationFn: (next: boolean) => updateMyProfile({ hideValues: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
  })
  const setCurrency = useMutation({
    mutationFn: (currency: string) => updateMyProfile({ displayCurrency: currency }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
  })

  const filterCount = Object.values(filters).filter((v) => v !== undefined && v !== '').length
  const hasAnyFilter = filterCount > 0 || search.collectionId !== undefined

  const resultLabel =
    counts.data && !hasAnyFilter
      ? `${counts.data.uniqueHoldingCount.toLocaleString('nb-NO')} holdings · ${counts.data.physicalCardCount.toLocaleString('nb-NO')} cards`
      : `${tiles.length.toLocaleString('nb-NO')}${hasMore ? '+' : ''} matching`

  function toggleSelected(holdingId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(holdingId)) next.delete(holdingId)
      else next.add(holdingId)
      return next
    })
  }

  function enterSelectMode() {
    setSelectMode(true)
    setSelectedIds(new Set())
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 py-2">
      <h1 className="sr-only">Portfolio</h1>

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={queryInput}
            onChange={(event) => {
              setQueryInput(event.target.value)
            }}
            placeholder="Search in your portfolio"
            autoComplete="off"
            autoCapitalize="none"
            aria-label="Search in your portfolio"
            className="min-h-11 w-full rounded-full border border-slate-700 bg-slate-900 py-2 pl-9 pr-9 text-base text-slate-100 placeholder:text-slate-500 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
          />
          {queryInput ? (
            <button
              type="button"
              onClick={() => {
                setQueryInput('')
              }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            updateSearch({ favorite: search.favorite ? undefined : true })
          }}
          aria-pressed={search.favorite === true}
          aria-label="Show only favourite holdings"
          className={`flex size-11 shrink-0 items-center justify-center rounded-full border ${
            search.favorite
              ? 'border-sky-500 bg-sky-600/20 text-slate-200'
              : 'border-slate-700 text-slate-400 hover:bg-slate-800'
          }`}
        >
          <StarIcon filled={search.favorite === true} className="size-5" />
        </button>
        <PortfolioActionMenu
          sort={sort}
          onSortChange={(next) => {
            updateSearch({ sort: next })
            void updateMyProfile({ collectionDefaultSort: next })
            void queryClient.invalidateQueries({ queryKey: ['my-profile'] })
          }}
          onEnterSelectMode={enterSelectMode}
        />
        <Link
          to="/catalog"
          className="hidden min-h-11 items-center rounded-full bg-sky-600 px-4 text-sm font-semibold text-accent-foreground hover:bg-sky-500 sm:flex"
        >
          Add card
        </Link>
      </div>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <ScopeSelector
            value={search.collectionId ?? null}
            onChange={(id) => {
              updateSearch({ collectionId: id ?? undefined })
            }}
          />
          <CurrencySelector
            value={profile.data?.displayCurrency ?? 'NOK'}
            onChange={(currency) => {
              setCurrency.mutate(currency)
            }}
          />
        </div>
        <div className="flex items-end justify-between">
          <MoneyDisplay
            state={counts.data && counts.data.pricedHoldingCount > 0 ? 'known' : 'missing'}
            minorUnits={counts.data?.portfolioValueMinor}
            size="lg"
            hidden={hideValues}
            displayCurrency={profile.data?.displayCurrency}
          />
          <ValuePrivacyToggle
            hidden={hideValues}
            onToggle={() => {
              toggleHideValues.mutate(!hideValues)
            }}
          />
        </div>
        {counts.data ? (
          <div className="space-y-0.5">
            <p className="text-xs text-slate-500">
              {counts.data.pricedHoldingCount} priced
              {counts.data.unpricedHoldingCount > 0
                ? ` · ${counts.data.unpricedHoldingCount} without a price`
                : ''}
            </p>
            {counts.data.sealedHoldingCount > 0 ? (
              <p className="text-xs text-slate-500">
                {hideValues ? (
                  <span aria-label="Value hidden">Cards •••• · Sealed ••••</span>
                ) : (
                  <>
                    Cards {formatNokMinor(counts.data.cardsValueMinor)} NOK · Sealed{' '}
                    {formatNokMinor(counts.data.sealedValueMinor)} NOK
                  </>
                )}
              </p>
            ) : null}
            {counts.data.sealedUnitCount > 0 ? (
              <p className="text-xs text-slate-500">
                {counts.data.sealedUnitCount} sealed unit
                {counts.data.sealedUnitCount === 1 ? '' : 's'}
                {counts.data.sealedUnpricedHoldingCount > 0
                  ? ` · ${counts.data.sealedUnpricedHoldingCount} without a valuation`
                  : ''}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <PortfolioActionShortcuts filters={filters} onEnterSelectMode={enterSelectMode} />

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
            holdingKind: next.holdingKind,
            sealedProductType: next.sealedProductType,
            sealedIntent: next.sealedIntent,
          })
        }}
      />

      {portfolio.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="aspect-[5/7] animate-pulse rounded-xl bg-slate-800/60" />
          ))}
        </div>
      ) : portfolio.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          The Portfolio could not be loaded. Try again.
        </p>
      ) : tiles.length === 0 ? (
        <EmptyState hasFilters={hasAnyFilter} inCollection={search.collectionId !== undefined} />
      ) : view === 'grid' ? (
        <VirtualGrid
          tiles={tiles}
          density={density}
          onEndReached={fetchNext}
          hasMore={hasMore}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelected}
        />
      ) : view === 'list' ? (
        <PortfolioListView
          tiles={tiles}
          onEndReached={fetchNext}
          hasMore={hasMore}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelected}
        />
      ) : (
        <PortfolioTableView
          tiles={tiles}
          onEndReached={fetchNext}
          hasMore={hasMore}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelected}
        />
      )}

      {selectMode ? (
        <BulkActionsBar
          selectedIds={selectedIds}
          tiles={tiles}
          activeCollectionId={search.collectionId}
          onClear={exitSelectMode}
        />
      ) : null}
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
          className="inline-block min-h-11 rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
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
          className="inline-block min-h-11 rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
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
        className="inline-block min-h-11 rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
      >
        Search the catalog
      </Link>
    </div>
  )
}
