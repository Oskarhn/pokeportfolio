import { Link, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getCard, getCardVariants } from '../../data/catalog'
import { CardImage } from './CardImage'

const FINISH_LABEL: Record<string, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse: 'Reverse holo',
  other: 'Other',
}

const PERIODS = ['1M', '3M', '6M', '1Y', 'MAX'] as const

/**
 * Card detail (M7.1 prompt §32-35): a large image at top, then one rounded information surface
 * holding everything else — identity, a clickable set link, variants, and the future price-history
 * slot. The variant list is the M5-era proof that the finish/stamp/subtype model can represent a
 * real card (M5 prompt §54); each variant links straight into the M6 add flow.
 */
export function CardDetailPage() {
  const { cardId } = useParams({ from: '/catalog/$cardId' })

  const card = useQuery({
    queryKey: ['catalog-card', cardId],
    queryFn: () => getCard(cardId),
  })
  const variants = useQuery({
    queryKey: ['catalog-card-variants', cardId],
    queryFn: () => getCardVariants(cardId),
    enabled: card.isSuccess && card.data !== null,
  })

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
            <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
              {variants.data.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span className="text-slate-200">
                    {FINISH_LABEL[v.finish] ?? v.finish}
                    {v.subtype ? ` · ${v.subtype}` : ''}
                    {v.stamp ? ` · ${v.stamp}` : ''}
                    {v.size === 'oversized' ? ' · Oversized' : ''}
                  </span>
                  <span className="flex items-center gap-3">
                    {!v.isActive ? (
                      <span className="text-xs text-slate-500">No longer listed</span>
                    ) : null}
                    <Link
                      to="/add"
                      search={{ variantId: v.id }}
                      className="min-h-9 rounded-full bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
                    >
                      Add to collection
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No known variants for this printing.</p>
          )}
        </div>

        {/* Reserved for the real price-history chart (M9's snapshots, M12's chart-library spike).
            Honestly unavailable — never a fabricated line or percentage (M7.1 prompt §34-35). */}
        <div className="space-y-2 border-t border-slate-800 pt-4">
          <h2 className="text-sm font-semibold text-slate-300">Price history</h2>
          <div className="flex h-20 items-center justify-center rounded-xl border border-dashed border-slate-800 text-xs text-slate-500">
            Not available yet
          </div>
          <div className="flex justify-between text-[11px] font-medium text-slate-600">
            {PERIODS.map((period) => (
              <span key={period}>{period}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
