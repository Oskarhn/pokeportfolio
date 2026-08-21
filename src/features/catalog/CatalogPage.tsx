import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { searchCards, type CatalogLanguage, type CatalogSearchResult } from '../../data/catalog'
import { CardImage } from './CardImage'
import { TextField } from '../../ui/form'

const PAGE_SIZE = 40
const DEBOUNCE_MS = 250

type LanguageFilter = CatalogLanguage | 'all'

/** Small local hook — this is the only place in the app that needs a debounced value today, so a
 *  dependency for it would be one function's worth of justification short of proportionate. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value)
    }, delayMs)
    return () => {
      clearTimeout(timer)
    }
  }, [value, delayMs])
  return debounced
}

export function CatalogPage() {
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState<LanguageFilter>('all')
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS)
  const trimmed = debouncedQuery.trim()

  const search = useInfiniteQuery({
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
    enabled: trimmed.length > 0,
  })

  const results: CatalogSearchResult[] = search.data?.pages.flatMap((p) => p.results) ?? []
  const hasMore = search.hasNextPage

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Catalog</h1>
        <p className="text-sm text-slate-400">
          Search the local card catalog by name, set or collector number.
        </p>
      </header>

      <div className="space-y-3">
        <TextField
          label="Search"
          type="search"
          placeholder="Pikachu, Base Set 4, Charizard 4/102…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          autoComplete="off"
          autoCapitalize="none"
        />
        <div className="flex gap-2" role="group" aria-label="Language">
          {(
            [
              ['all', 'All'],
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
              className={`min-h-9 rounded-lg border px-3 text-sm font-medium transition-colors ${
                language === value
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {trimmed.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          Start typing to search the catalog.
        </p>
      ) : search.isPending ? (
        <ul className="space-y-2" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="h-20 animate-pulse rounded-lg bg-slate-800/60" />
          ))}
        </ul>
      ) : search.isError ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          The catalog could not be searched. Try again.
        </p>
      ) : results.length === 0 ? (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-slate-500">No cards match "{trimmed}".</p>
          <Link
            to="/collection/manual/new"
            className="text-sm text-sky-400 underline-offset-4 hover:underline"
          >
            Card not listed? Add it manually
          </Link>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {results.map((card) => (
              <li key={card.cardId}>
                <Link
                  to="/catalog/$cardId"
                  params={{ cardId: card.cardId }}
                  className="flex items-center gap-3 p-3 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
                >
                  <CardImage
                    imageBaseUrl={card.imageBaseUrl}
                    alt={card.name}
                    quality="low"
                    className="h-16 w-12 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-100">{card.name}</p>
                    <p className="truncate text-xs text-slate-400">
                      {card.setName} · #{card.localId}
                      {card.rarity ? ` · ${card.rarity}` : ''}
                    </p>
                    <p className="text-xs text-slate-500">
                      {card.language === 'ja' ? 'Japanese' : 'English'}
                      {card.category ? ` · ${card.category}` : ''}
                      {card.variantCount > 1 ? ` · ${card.variantCount} variants` : ''}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <button
              type="button"
              onClick={() => {
                void search.fetchNextPage()
              }}
              disabled={search.isFetchingNextPage}
              className="min-h-11 w-full rounded-lg border border-slate-700 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60"
            >
              {search.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
