import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import {
  searchCards,
  searchSets,
  type CatalogLanguage,
  type CatalogSearchResult,
  type CatalogSet,
} from '../../data/catalog'
import { getFavoritedCardIds } from '../../data/collection'
import { searchPrices, summarizeCardPricing, SEARCH_PRICES_MAX_CARD_IDS } from '../../data/pricing'
import { getMyProfile } from '../../data/profile'
import { CardResultCard } from './CardResultCard'
import { SetCarousel } from './SetCarousel'
import { Sheet } from '../../ui/Sheet'
import { naturalCompare } from '../../ui/naturalSort'
import { useDebouncedValue } from '../../ui/useDebouncedValue'
import { SearchIcon, XIcon, CameraIcon, StarIcon, SortIcon, CheckIcon } from '../../ui/icons'

const PAGE_SIZE = 40
const DEBOUNCE_MS = 250

type LanguageFilter = CatalogLanguage | 'all'
type SearchMode = 'cards' | 'sets'
type CardSort = 'relevance' | 'name_asc' | 'name_desc' | 'number_asc' | 'number_desc'

const SORT_LABEL: Record<CardSort, string> = {
  relevance: 'Best match',
  name_asc: 'Product name A to Z',
  name_desc: 'Product name Z to A',
  number_asc: 'Card number low to high',
  number_desc: 'Card number high to low',
}

function SetRow({ set }: { set: CatalogSet }) {
  return (
    <Link
      to="/catalog/sets/$setId"
      params={{ setId: set.id }}
      className="flex items-center gap-3 p-3 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
    >
      {set.symbolUrl || set.logoUrl ? (
        <img
          src={set.symbolUrl ?? set.logoUrl ?? undefined}
          alt=""
          className="size-8 shrink-0 object-contain"
          loading="lazy"
        />
      ) : (
        <div className="size-8 shrink-0 rounded bg-slate-800" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-100">{set.name}</p>
        <p className="truncate text-xs text-slate-400">
          {set.language === 'ja' ? 'Japanese' : 'English'}
          {set.releasedOn ? ` · ${set.releasedOn}` : ''}
          {set.cardCountOfficial ? ` · ${set.cardCountOfficial} cards` : ''}
        </p>
      </div>
    </Link>
  )
}

export function CatalogPage() {
  const [mode, setMode] = useState<SearchMode>('cards')
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState<LanguageFilter>('all')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [sort, setSort] = useState<CardSort>('relevance')
  const [sortOpen, setSortOpen] = useState(false)
  const [scanNotice, setScanNotice] = useState(false)
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS)
  const trimmed = debouncedQuery.trim()

  const cardSearch = useInfiniteQuery({
    queryKey: ['catalog-search', trimmed, language],
    queryFn: ({ pageParam }) =>
      searchCards({
        query: trimmed,
        language: language === 'all' ? null : language,
        offset: pageParam * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      allPages.length * PAGE_SIZE < lastPage.totalCount ? allPages.length : undefined,
    enabled: mode === 'cards' && trimmed.length > 0,
  })

  const setSearch = useQuery({
    queryKey: ['catalog-set-search', trimmed, language],
    queryFn: () => searchSets({ query: trimmed, language: language === 'all' ? null : language }),
    enabled: mode === 'sets' && trimmed.length > 0,
  })

  // Search's favourite star (M7.1 prompt §25): filters results to catalog cards behind a
  // Favourite holding — direct reuse of the existing favourite state, not a second wishlist.
  const favorites = useQuery({
    queryKey: ['favorited-card-ids'],
    queryFn: getFavoritedCardIds,
    enabled: favoriteOnly,
  })

  const rawResults: CatalogSearchResult[] = cardSearch.data?.pages.flatMap((p) => p.results) ?? []
  const favoriteFiltered = favoriteOnly
    ? rawResults.filter((card) => favorites.data?.has(card.cardId))
    : rawResults
  const cardResults = useMemo(() => {
    if (sort === 'relevance') return favoriteFiltered
    const copy = [...favoriteFiltered]
    copy.sort((a, b) => {
      if (sort === 'name_asc') return a.name.localeCompare(b.name)
      if (sort === 'name_desc') return b.name.localeCompare(a.name)
      if (sort === 'number_asc') return naturalCompare(a.localId, b.localId)
      return naturalCompare(b.localId, a.localId)
    })
    return copy
  }, [favoriteFiltered, sort])
  const hasMoreCards = cardSearch.hasNextPage

  // Batched real prices on result tiles (M9.1 prompt §5-11): one bounded search-prices request per
  // <=20-card page, never one per tile — chunked by the endpoint's own contract
  // (SEARCH_PRICES_MAX_CARD_IDS) and cached by TanStack Query per exact chunk of ids, so paging
  // forward never re-requests a batch already fetched. A pricing failure degrades to "—" per card
  // (searchPrices already swallows its own errors) and never blocks the catalog grid itself.
  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const useEuPricing = profile.data?.useEuPricing ?? true
  const cardIdChunks = useMemo(() => {
    const ids = cardResults.map((c) => c.cardId)
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += SEARCH_PRICES_MAX_CARD_IDS) {
      chunks.push(ids.slice(i, i + SEARCH_PRICES_MAX_CARD_IDS))
    }
    return chunks
  }, [cardResults])
  const priceBatches = useQueries({
    queries: cardIdChunks.map((chunk) => ({
      queryKey: ['catalog-search-prices', chunk, useEuPricing],
      queryFn: () => searchPrices(chunk, useEuPricing),
      staleTime: 5 * 60 * 1000,
    })),
  })
  const priceSummaryByCard = useMemo(() => {
    const flat = priceBatches.flatMap((batch) => (batch.data ? [...batch.data.values()] : []))
    return summarizeCardPricing(flat)
  }, [priceBatches])

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 py-2">
      <h1 className="sr-only">Search</h1>

      {/* Top search bar (M7.1 prompt §22-23): the field is the primary control, no page title
          above it. Camera establishes the scanner's future position without faking capture. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setScanNotice(true)
          }}
          aria-label="Scan a card"
          title="Card scanner is not available yet"
          className="flex size-11 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-400 hover:bg-slate-800"
        >
          <CameraIcon className="size-5" />
        </button>
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            placeholder="Search for cards"
            autoComplete="off"
            autoCapitalize="none"
            aria-label="Search for cards"
            className="min-h-11 w-full rounded-full border border-slate-700 bg-slate-900 py-2 pl-9 pr-9 text-base text-slate-100 placeholder:text-slate-500 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
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
            setFavoriteOnly((v) => !v)
          }}
          aria-pressed={favoriteOnly}
          aria-label="Show only cards you have favourited"
          className={`flex size-11 shrink-0 items-center justify-center rounded-full border ${
            favoriteOnly
              ? 'border-amber-400/60 bg-amber-400/10 text-amber-400'
              : 'border-slate-700 text-slate-400 hover:bg-slate-800'
          }`}
        >
          <StarIcon filled={favoriteOnly} className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setSortOpen(true)
          }}
          aria-label="Sort results"
          className="flex size-11 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-400 hover:bg-slate-800"
        >
          <SortIcon className="size-5" />
        </button>
      </div>

      {/* Quick filters: mode and language. */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['cards', 'Cards'],
            ['sets', 'Sets'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value)
            }}
            className={`min-h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
              mode === value
                ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="mx-1 w-px self-stretch bg-slate-800" aria-hidden />
        {(
          [
            ['all', 'All languages'],
            ['en', 'English'],
            ['ja', 'Japanese'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={language === value}
            onClick={() => {
              setLanguage(value)
            }}
            className={`min-h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
              language === value
                ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {trimmed.length === 0 && mode === 'cards' ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-300">Browse sets</h2>
          <SetCarousel language={language} />
        </div>
      ) : null}

      {trimmed.length === 0 ? (
        mode === 'cards' ? null : (
          <p className="py-8 text-center text-sm text-slate-500">Start typing to search sets.</p>
        )
      ) : mode === 'sets' ? (
        setSearch.isPending ? (
          <ul className="space-y-2" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="h-14 animate-pulse rounded-xl bg-slate-800/60" />
            ))}
          </ul>
        ) : setSearch.isError ? (
          <p
            role="alert"
            className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
          >
            Sets could not be searched. Try again.
          </p>
        ) : setSearch.data.length > 0 ? (
          <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
            {setSearch.data.map((set) => (
              <li key={set.id}>
                <SetRow set={set} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-sm text-slate-500">No sets match "{trimmed}".</p>
        )
      ) : cardSearch.isPending ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="aspect-[5/7] animate-pulse rounded-xl bg-slate-800/60" />
          ))}
        </div>
      ) : cardSearch.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          The catalog could not be searched. Try again.
        </p>
      ) : cardResults.length === 0 ? (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-slate-500">
            {favoriteOnly && rawResults.length > 0
              ? `No favourited cards match "${trimmed}".`
              : `No cards match "${trimmed}".`}
          </p>
          <Link
            to="/portfolio/manual/new"
            className="text-sm text-sky-400 underline-offset-4 hover:underline"
          >
            Card not listed? Add it manually
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {cardResults.map((card) => (
              <CardResultCard
                key={card.cardId}
                card={card}
                priceSummary={priceSummaryByCard.get(card.cardId)}
              />
            ))}
          </div>
          {hasMoreCards ? (
            <button
              type="button"
              onClick={() => {
                void cardSearch.fetchNextPage()
              }}
              disabled={cardSearch.isFetchingNextPage}
              className="min-h-11 w-full rounded-xl border border-slate-700 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60"
            >
              {cardSearch.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </>
      )}

      <Sheet
        open={sortOpen}
        onClose={() => {
          setSortOpen(false)
        }}
        title="Sort"
      >
        <div className="flex flex-col gap-1">
          {(Object.keys(SORT_LABEL) as CardSort[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setSort(value)
                setSortOpen(false)
              }}
              className="flex min-h-11 items-center justify-between rounded-lg px-3 text-left text-sm text-slate-200 hover:bg-slate-800/60"
            >
              {SORT_LABEL[value]}
              {sort === value ? <CheckIcon className="size-4 text-sky-400" /> : null}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={scanNotice}
        onClose={() => {
          setScanNotice(false)
        }}
        title="Scan card"
      >
        <p className="text-sm text-slate-300">Card scanner is not available yet.</p>
      </Sheet>
    </div>
  )
}
