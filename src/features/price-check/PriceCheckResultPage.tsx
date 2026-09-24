import { useState } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useQuery, useQueries } from '@tanstack/react-query'
import { getCard, getCardVariants } from '../../data/catalog'
import {
  FX_STALE_TIME_MS,
  PRICE_CHECK_GC_TIME_MS,
  PRICE_CHECK_STALE_TIME_MS,
  PriceCheckError,
  fetchCardPriceResponse,
  getLatestFxRate,
  priceCheckKeys,
} from '../../data/price-check'
import { isSupportedCurrencyCode } from '../../domain/currency'
import type { FxRateParse } from '../../domain/price-check/fx'
import { gradedSection } from '../../domain/price-check/graded'
import { resolveVariant } from '../../domain/price-check/identity'
import { buildRawSection } from '../../domain/price-check/raw-section'
import type {
  CardIdentity,
  UnavailableReason,
  VariantIdentity,
} from '../../domain/price-check/types'
import { ResultView, type RawLoadState } from './ResultView'

/**
 * Price Check result page: one confirmed card (and, for multi-variant cards, one explicitly chosen
 * variant) and what the price sources report for it. READ-ONLY — the only queries here are catalog
 * reads, the non-persisting `search-prices` lookup and the shared FX table. "Add to collection" is
 * a plain link into the existing add flow; following it is the only way anything gets created, and
 * that happens on the Add page under its own explicit confirmation, never from here.
 */

function errorReason(error: unknown): UnavailableReason {
  return error instanceof PriceCheckError ? error.reason : 'network'
}

const LINK_CLASS = 'text-sky-400 underline-offset-4 hover:underline'
/** Stand-alone navigation links are full-height touch targets (the set link stays inline in text). */
const BLOCK_LINK_CLASS = `${LINK_CLASS} inline-flex min-h-11 items-center`

export function PriceCheckResultPage() {
  const { cardId } = useParams({ from: '/price-check/$cardId' })
  const { variantId } = useSearch({ from: '/price-check/$cardId' })
  const navigate = useNavigate({ from: '/price-check/$cardId' })
  // Wall-clock reference for freshness labels, captured once per mount — never read during render
  // after that, so re-renders are stable.
  const [mountedAtMs] = useState(() => Date.now())

  // Same query keys as Card Detail so a card already viewed there is served from the shared cache.
  const cardQuery = useQuery({
    queryKey: ['catalog-card', cardId],
    queryFn: () => getCard(cardId),
  })
  const variantsQuery = useQuery({
    queryKey: ['catalog-card-variants', cardId],
    queryFn: () => getCardVariants(cardId),
    enabled: cardQuery.isSuccess && cardQuery.data !== null,
  })

  const rawQuery = useQuery({
    queryKey: priceCheckKeys.raw(cardId),
    queryFn: ({ signal }) => fetchCardPriceResponse(cardId, { signal }),
    enabled: cardQuery.isSuccess && cardQuery.data !== null,
    staleTime: PRICE_CHECK_STALE_TIME_MS,
    gcTime: PRICE_CHECK_GC_TIME_MS,
    // A failed lookup is shown as a failure with a manual retry — never silently retried against a
    // rate-limited provider, never refetched just because the tab regained focus.
    retry: false,
    refetchOnWindowFocus: false,
  })

  const card: CardIdentity | null =
    cardQuery.data === null || cardQuery.data === undefined
      ? null
      : {
          cardId: cardQuery.data.id,
          name: cardQuery.data.name,
          setId: cardQuery.data.setId,
          setName: cardQuery.data.setName,
          collectorNumber: cardQuery.data.localId,
          language: cardQuery.data.language,
          imageBaseUrl: cardQuery.data.imageBaseUrl,
          rarity: cardQuery.data.rarity,
          illustrator: cardQuery.data.illustrator,
        }
  const variants: VariantIdentity[] = (variantsQuery.data ?? []).map((v) => ({
    variantId: v.id,
    finish: v.finish,
    stamp: v.stamp,
    subtype: v.subtype,
    size: v.size,
    isActive: v.isActive,
  }))
  const resolution = resolveVariant(variants, variantId)

  const raw: RawLoadState = rawQuery.isError
    ? { state: 'error', reason: errorReason(rawQuery.error) }
    : rawQuery.data === undefined
      ? { state: 'loading' }
      : {
          state: 'ready',
          response: rawQuery.data,
          origin: Date.parse(rawQuery.data.fetchedAt) < mountedAtMs ? 'cache' : 'network',
        }

  // Currencies actually present on the chosen variant's observations — one FX read per currency.
  const currencies: string[] = []
  if (resolution.status === 'confirmed' && raw.state === 'ready') {
    const { section } = buildRawSection(raw.response, resolution.variant)
    for (const observation of section.observations) {
      const currency = observation.price.currency
      if (currency !== 'NOK' && !currencies.includes(currency)) currencies.push(currency)
    }
  }
  const fxQueries = useQueries({
    queries: currencies.map((currency) => ({
      queryKey: priceCheckKeys.fx(currency),
      queryFn: () => getLatestFxRate(isSupportedCurrencyCode(currency) ? currency : 'NOK'),
      staleTime: FX_STALE_TIME_MS,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  })
  const fxByCurrency: Record<string, FxRateParse | undefined> = {}
  currencies.forEach((currency, index) => {
    const result = fxQueries[index]
    // A failed FX read stays `undefined` here → "NOK reference unavailable"; the source-currency
    // price is unaffected.
    if (result?.data !== undefined) fxByCurrency[currency] = result.data
  })

  if (cardQuery.isPending) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-xl bg-slate-800/60"
      >
        <span className="sr-only">Loading card…</span>
      </div>
    )
  }

  if (cardQuery.isError || card === null) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          {cardQuery.isError
            ? 'The card could not be loaded. Check your connection and try again.'
            : 'That card could not be found.'}
        </p>
        <Link to="/price-check" className={`text-sm ${LINK_CLASS}`}>
          Back to price check
        </Link>
      </div>
    )
  }

  if (variantsQuery.isPending) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-xl bg-slate-800/60"
      >
        <span className="sr-only">Loading variants…</span>
      </div>
    )
  }

  if (variantsQuery.isError) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          The variants of this card could not be loaded, so an exact price cannot be shown.
        </p>
        <button
          type="button"
          onClick={() => {
            void variantsQuery.refetch()
          }}
          className="min-h-11 rounded-full border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <ResultView
      card={card}
      variants={variants}
      resolution={resolution}
      raw={raw}
      // No authorized graded price source is configured (docs/API_SOURCES.md), so there is nothing
      // to consult: the section reports exactly that instead of showing a number.
      graded={gradedSection({ sources: [], observations: [], dropped: [] })}
      fxByCurrency={fxByCurrency}
      nowMs={mountedAtMs}
      onSelectVariant={(id) => {
        void navigate({ search: { variantId: id }, replace: true })
      }}
      onRetry={() => {
        void rawQuery.refetch()
      }}
      slots={{
        setLink: (
          <Link to="/catalog/sets/$setId" params={{ setId: card.setId }} className={LINK_CLASS}>
            {card.setName}
          </Link>
        ),
        searchAgain: (
          <Link to="/price-check" className={BLOCK_LINK_CLASS}>
            ← Search again
          </Link>
        ),
        scanAgain: (
          <Link to="/price-check/scan" className={BLOCK_LINK_CLASS}>
            Scan a card
          </Link>
        ),
        addToCollection:
          resolution.status === 'confirmed' ? (
            <Link
              to="/add"
              search={{ variantId: resolution.variant.variantId }}
              className="inline-flex min-h-11 items-center rounded-full border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              Add to collection…
            </Link>
          ) : null,
      }}
    />
  )
}
