import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getCard, getCardVariants } from '../../data/catalog'
import { getCardVariantPriceHistory, searchPrices } from '../../data/pricing'
import { getMyProfile } from '../../data/profile'
import { CardImage } from './CardImage'
import { MoneyDisplay } from '../../ui/MoneyDisplay'
import { PriceHistoryChart } from '../../ui/PriceHistoryChart'

const FINISH_LABEL: Record<string, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse: 'Reverse holo',
  other: 'Other',
}

function variantLabel(v: { finish: string; stamp: string; subtype: string }) {
  return [FINISH_LABEL[v.finish] ?? v.finish, v.subtype, v.stamp].filter(Boolean).join(' · ')
}

function sourceValueText(sourceCurrency: string | null, sourceValueMinor: bigint | null): string {
  if (sourceCurrency === null || sourceValueMinor === null) return '—'
  const symbol =
    sourceCurrency === 'EUR' ? '€' : sourceCurrency === 'USD' ? '$' : `${sourceCurrency} `
  return `${symbol}${(Number(sourceValueMinor) / 100).toFixed(2)}`
}

const PROVIDER_LABEL: Record<string, string> = {
  tcgdex_cardmarket: 'Cardmarket via TCGdex',
  tcgdex_tcgplayer: 'TCGplayer via TCGdex',
}

/**
 * Card detail (M7.1 prompt §32-35): a large image at top, then one rounded information surface
 * holding everything else — identity, a clickable set link, variants, and price history. A
 * multi-variant card has an explicit SELECTED variant (M9.1 prompt §13-17, fixing the M9 defect
 * where history always used `variants[0]` regardless of which variant a viewer actually cared
 * about) — current price, provenance and the history chart all change together with it. The
 * selection lives in the URL (`?variantId=`), never a global store, so refresh/back-navigation/a
 * shared link land on the same variant. Each variant still links straight into the M6 add flow.
 */
export function CardDetailPage() {
  const { cardId } = useParams({ from: '/catalog/$cardId' })
  const search = useSearch({ from: '/catalog/$cardId' })
  const navigate = useNavigate({ from: '/catalog/$cardId' })

  const card = useQuery({
    queryKey: ['catalog-card', cardId],
    queryFn: () => getCard(cardId),
  })
  const variants = useQuery({
    queryKey: ['catalog-card-variants', cardId],
    queryFn: () => getCardVariants(cardId),
    enabled: card.isSuccess && card.data !== null,
  })
  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const useEuPricing = profile.data?.useEuPricing ?? true
  // On-demand, non-persisted current references (prompt §48) — one bounded request for this one
  // card, never per-variant. A pricing failure never blocks the catalog page itself (prompt §80).
  const prices = useQuery({
    queryKey: ['card-search-prices', cardId, useEuPricing],
    queryFn: () => searchPrices([cardId], useEuPricing),
    enabled: card.isSuccess && card.data !== null,
  })

  // Deterministic default: the first variant in catalog ordering (§15) — never auto-switched once
  // async pricing arrives, and never silently jumping to "the cheapest" or "the priced one", which
  // would be a moving target every time a price refreshes.
  const defaultVariantId = variants.data?.[0]?.id
  const requestedVariantId = search.variantId
  const selectedVariantId =
    requestedVariantId !== undefined &&
    variants.data?.some((v) => v.id === requestedVariantId) === true
      ? requestedVariantId
      : defaultVariantId

  function selectVariant(variantId: string) {
    void navigate({ search: { variantId }, replace: true })
  }

  const history = useQuery({
    queryKey: ['card-variant-price-history', selectedVariantId],
    queryFn: () => getCardVariantPriceHistory(selectedVariantId as string),
    enabled: selectedVariantId !== undefined,
  })
  const selectedPrice = selectedVariantId ? prices.data?.get(selectedVariantId) : undefined

  if (card.isPending) {
    return (
      <div className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-xl bg-slate-800/60" />
    )
  }

  if (card.isError || !card.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          That card could not be found.
        </p>
        <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          Back to search
        </Link>
      </div>
    )
  }

  const c = card.data

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
      <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to search
      </Link>

      <CardImage
        imageBaseUrl={c.imageBaseUrl}
        alt={c.name}
        quality="high"
        className="mx-auto h-72 w-52"
      />

      <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">{c.name}</h1>
          <Link
            to="/catalog/sets/$setId"
            params={{ setId: c.setId }}
            className="text-sm text-sky-400 underline-offset-4 hover:underline"
          >
            {c.setName}
          </Link>
          <span className="text-sm text-slate-400"> · #{c.localId}</span>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-slate-500">Language</dt>
          <dd className="text-slate-200">{c.language === 'ja' ? 'Japanese' : 'English'}</dd>
          <dt className="text-slate-500">Category</dt>
          <dd className="text-slate-200">{c.category ?? '—'}</dd>
          <dt className="text-slate-500">Rarity</dt>
          <dd className="text-slate-200">{c.rarity ?? '—'}</dd>
          <dt className="text-slate-500">Illustrator</dt>
          <dd className="text-slate-200">{c.illustrator ?? '—'}</dd>
        </dl>

        <div className="space-y-2 border-t border-slate-800 pt-4">
          <h2 className="text-sm font-semibold text-slate-300">Variants</h2>
          {variants.isPending ? (
            <div className="h-16 animate-pulse rounded-xl bg-slate-800/60" />
          ) : variants.isError ? (
            <p role="alert" className="text-sm text-rose-300">
              Variants could not be loaded.
            </p>
          ) : variants.data.length > 0 ? (
            <>
              {/* Selector chips (M9.1 prompt §14): current price, provenance and the history chart
                  below all change together with the selection — never Holo metadata paired with a
                  Normal price graph. */}
              {variants.data.length > 1 ? (
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Card variant">
                  {variants.data.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      role="tab"
                      aria-selected={v.id === selectedVariantId}
                      onClick={() => {
                        selectVariant(v.id)
                      }}
                      className={`min-h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
                        v.id === selectedVariantId
                          ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                          : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {variantLabel(v) || 'Standard'}
                    </button>
                  ))}
                </div>
              ) : null}
              <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
                {variants.data.map((v) => {
                  const price = prices.data?.get(v.id)
                  return (
                    <li key={v.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                      <span className="text-slate-200">
                        {variantLabel(v) || 'Standard'}
                        {v.size === 'oversized' ? ' · Oversized' : ''}
                        <span className="ml-2 text-xs text-slate-500">
                          {prices.isPending
                            ? '…'
                            : price?.priceState === 'available'
                              ? sourceValueText(price.sourceCurrency, price.sourceValueMinor)
                              : '—'}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        {!v.isActive ? (
                          <span className="text-xs text-slate-500">No longer listed</span>
                        ) : null}
                        <Link
                          to="/add"
                          search={{ variantId: v.id }}
                          className="min-h-9 rounded-full bg-sky-600 px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-sky-500"
                        >
                          Add to collection
                        </Link>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <p className="text-sm text-slate-500">No known variants for this printing.</p>
          )}
        </div>

        {/* Current value for the SELECTED variant only (M9.1 prompt §9-11): display value normalized
            to NOK (MoneyDisplay), with real source-currency provenance never erased by that
            normalization — Cardmarket/TCGplayer via TCGdex, the price kind and the observation date. */}
        <div className="space-y-2 border-t border-slate-800 pt-4">
          <h2 className="text-sm font-semibold text-slate-300">Current value</h2>
          {prices.isPending ? (
            <div className="h-10 animate-pulse rounded-xl bg-slate-800/60" />
          ) : (
            <div className="space-y-1">
              <MoneyDisplay
                state={
                  selectedPrice?.priceState === 'available' && selectedPrice.valueNokMinor !== null
                    ? 'known'
                    : 'missing'
                }
                minorUnits={selectedPrice?.valueNokMinor ?? undefined}
                displayCurrency={profile.data?.displayCurrency}
                size="sm"
              />
              {selectedPrice?.priceState === 'available' ? (
                <p className="text-xs text-slate-500">
                  {PROVIDER_LABEL[selectedPrice.provider ?? ''] ?? 'Unknown provider'} ·{' '}
                  {sourceValueText(selectedPrice.sourceCurrency, selectedPrice.sourceValueMinor)}
                  {selectedPrice.providerUpdatedAt
                    ? ` · Updated ${selectedPrice.providerUpdatedAt.slice(0, 10)}`
                    : ''}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {/* Real snapshots only (D-008) — never an avg7/avg30 rolling statistic mistaken for a
            historical point, never a fabricated line (prompt §52/§95-96). Only variants this app
            has actually tracked (owned at some point) have any history at all, and only for the
            SELECTED variant (M9.1 prompt §17) — switching variants never leaves the previous
            variant's chart on screen. */}
        <div className="space-y-2 border-t border-slate-800 pt-4">
          <h2 className="text-sm font-semibold text-slate-300">Price history</h2>
          {history.isPending && selectedVariantId ? (
            <div className="h-20 animate-pulse rounded-xl bg-slate-800/60" />
          ) : (
            <PriceHistoryChart key={selectedVariantId} points={history.data ?? []} />
          )}
        </div>
      </div>
    </div>
  )
}
