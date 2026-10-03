import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { searchCards, type CatalogLanguage, type CatalogSearchResult } from '../../data/catalog'
import { cardsSharingAName, languageLabel } from '../../domain/price-check/identity'
import { CardImage } from '../catalog/CardImage'
import { SelectField, TextField } from '../../ui/form'
import { useDebouncedValue } from '../../ui/useDebouncedValue'
import { CameraIcon } from '../../ui/icons'

const DEBOUNCE_MS = 250
const RESULT_LIMIT = 40

type LanguageFilter = CatalogLanguage | 'all'

function ResultRow({ card, sharesName }: { card: CatalogSearchResult; sharesName: boolean }) {
  return (
    <li>
      <Link
        to="/price-check/$cardId"
        params={{ cardId: card.cardId }}
        data-testid="price-check-result"
        className="flex min-h-16 items-center gap-3 rounded-xl border border-slate-800 p-2 hover:bg-slate-800/60 focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <CardImage
          imageBaseUrl={card.imageBaseUrl}
          alt=""
          quality="low"
          className="h-20 w-14 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-slate-100">{card.name}</p>
          <p className="break-words text-xs text-slate-300">
            {card.setName} · #{card.localId}
          </p>
          <p className="break-words text-xs text-slate-400">
            {languageLabel(card.language)}
            {card.rarity ? ` · ${card.rarity}` : ''}
            {card.illustrator ? ` · ${card.illustrator}` : ''}
            {card.variantCount > 1 ? ` · ${String(card.variantCount)} variants` : ''}
          </p>
          {sharesName ? (
            <p data-testid="shares-name" className="text-xs font-medium text-slate-200">
              Same name as another result — check the set and number.
            </p>
          ) : null}
        </div>
        <span className="shrink-0 text-xs font-medium text-sky-400">Check price</span>
      </Link>
    </li>
  )
}

/**
 * Price Check entry (P153). A lookup tool, not an add flow: choosing a result opens its price page
 * and creates nothing. Search reuses the shared catalog search (name, set and collector-number
 * combinations). The query and language live in the URL so Back from a result returns to the same
 * search.
 */
export function PriceCheckPage() {
  const search = useSearch({ from: '/price-check' })
  const navigate = useNavigate({ from: '/price-check' })
  const [query, setQuery] = useState(search.q ?? '')
  const [language, setLanguage] = useState<LanguageFilter>(search.language ?? 'all')
  const debounced = useDebouncedValue(query, DEBOUNCE_MS)
  const trimmed = debounced.trim()

  useEffect(() => {
    void navigate({
      search: {
        q: trimmed === '' ? undefined : trimmed,
        language: language === 'all' ? undefined : language,
      },
      replace: true,
    })
  }, [trimmed, language, navigate])

  // Keyed on the exact query + language: a slow response for an earlier query lands in ITS OWN
  // cache entry and can never replace the results shown for the current one.
  const results = useQuery({
    queryKey: ['price-check-search', trimmed, language],
    queryFn: () =>
      searchCards({
        query: trimmed,
        language: language === 'all' ? null : language,
        limit: RESULT_LIMIT,
      }),
    enabled: trimmed.length > 0,
    retry: false,
  })

  const cards = useMemo(() => results.data?.results ?? [], [results.data])
  const totalCount = results.data?.totalCount ?? 0
  const shared = useMemo(() => cardsSharingAName(cards), [cards])
  const typing = query.trim() !== trimmed

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Price check</h1>
        <p className="text-sm text-slate-400">
          Look up what a card is priced at. Nothing you do here is added to your collection.
        </p>
      </header>

      <Link
        to="/price-check/scan"
        className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-700 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60 focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <CameraIcon className="size-5 text-slate-400" />
        <span>
          Scan a card
          <span className="block text-xs font-normal text-slate-400">
            Photograph it, then confirm which card it is
          </span>
        </span>
      </Link>

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
        }}
        className="space-y-3"
      >
        <TextField
          label="Card name, set or number"
          hint='For example "Charizard 4/102" or "Pikachu Base Set"'
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <SelectField
          label="Language"
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value as LanguageFilter)
          }}
        >
          <option value="all">All languages</option>
          <option value="en">English</option>
          <option value="ja">Japanese</option>
        </SelectField>
      </form>

      <div aria-busy={results.isFetching || typing} className="space-y-3">
        {trimmed === '' ? (
          <p className="text-sm text-slate-400">Type a card name to begin.</p>
        ) : typing || results.isPending ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="search-loading"
            className="text-sm text-slate-400"
          >
            Searching…
          </p>
        ) : results.isError ? (
          <div className="space-y-2">
            <p
              role="alert"
              className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
            >
              Search failed. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={() => {
                void results.refetch()
              }}
              className="min-h-11 rounded-full border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              Try again
            </button>
          </div>
        ) : cards.length === 0 ? (
          <p role="status" data-testid="search-empty" className="text-sm text-slate-300">
            No cards match “{trimmed}”. Check the spelling, or try the set name or number.
          </p>
        ) : (
          <>
            <p role="status" aria-live="polite" className="text-sm text-slate-400">
              {cards.length < totalCount
                ? `Showing ${String(cards.length)} of ${String(totalCount)} matches — refine the search to narrow it.`
                : `${String(cards.length)} ${cards.length === 1 ? 'match' : 'matches'}`}
            </p>
            <ul className="space-y-2">
              {cards.map((card) => (
                <ResultRow key={card.cardId} card={card} sharesName={shared.has(card.cardId)} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
