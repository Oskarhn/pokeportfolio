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

/**
 * Confirms the identity of one search result and shows what is actually ownable about it — the
 * variant list is the M5-era proof that the finish/stamp/subtype model can represent a real card
 * (M5 prompt §54). No "Add to collection": that workflow belongs to M6 and a half-built version of
 * it here would be worse than not having one (M5 prompt §53).
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
      <div className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-lg bg-slate-800/60" />
    )
  }

  if (card.isError || !card.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
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
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to search
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row">
        <CardImage
          imageBaseUrl={c.imageBaseUrl}
          alt={c.name}
          quality="high"
          className="h-64 w-48 self-center sm:self-start"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{c.name}</h1>
          <p className="text-sm text-slate-300">
            {c.setName} · #{c.localId}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-sm">
            <dt className="text-slate-500">Language</dt>
            <dd className="text-slate-200">{c.language === 'ja' ? 'Japanese' : 'English'}</dd>
            <dt className="text-slate-500">Category</dt>
            <dd className="text-slate-200">{c.category ?? '—'}</dd>
            <dt className="text-slate-500">Rarity</dt>
            <dd className="text-slate-200">{c.rarity ?? '—'}</dd>
            <dt className="text-slate-500">Illustrator</dt>
            <dd className="text-slate-200">{c.illustrator ?? '—'}</dd>
          </dl>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Variants</h2>
        {variants.isPending ? (
          <div className="h-16 animate-pulse rounded-lg bg-slate-800/60" />
        ) : variants.isError ? (
          <p role="alert" className="text-sm text-rose-300">
            Variants could not be loaded.
          </p>
        ) : variants.data.length > 0 ? (
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {variants.data.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span className="text-slate-200">
                  {FINISH_LABEL[v.finish] ?? v.finish}
                  {v.subtype ? ` · ${v.subtype}` : ''}
                  {v.stamp ? ` · ${v.stamp}` : ''}
                  {v.size === 'oversized' ? ' · Oversized' : ''}
                </span>
                {!v.isActive ? (
                  <span className="text-xs text-slate-500">No longer listed</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No known variants for this printing.</p>
        )}
      </section>
    </div>
  )
}
