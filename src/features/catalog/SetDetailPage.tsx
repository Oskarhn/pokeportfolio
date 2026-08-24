import { useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getSet, listCardsInSet } from '../../data/catalog'
import { CardResultCard } from './CardResultCard'

/**
 * The set header's logo (P27): URLs arrive already normalized by `getSet`, and an asset that
 * still fails to load disappears quietly — the set name identifies the row, never a browser
 * broken-image icon. The failed URL is never retried.
 */
function SetHeaderLogo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <img
      src={src}
      alt=""
      className="h-12 max-w-40 object-contain"
      loading="lazy"
      onError={() => {
        setFailed(true)
      }}
    />
  )
}

/** Browsing a set's cards from Search (M7 prompt §14): real set metadata — name, language,
 *  symbol, release date, card count — then every card in it with the same quick-add + as card
 *  search results. */
export function SetDetailPage() {
  const { setId } = useParams({ from: '/catalog/sets/$setId' })

  const set = useQuery({ queryKey: ['catalog-set', setId], queryFn: () => getSet(setId) })
  const cards = useQuery({
    queryKey: ['catalog-set-cards', setId],
    queryFn: () => listCardsInSet(setId),
  })

  if (set.isPending) {
    return (
      <div className="mx-auto h-32 w-full max-w-2xl animate-pulse rounded-lg bg-slate-800/60" />
    )
  }
  if (set.isError || !set.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          That set could not be found.
        </p>
        <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          Back to search
        </Link>
      </div>
    )
  }

  const s = set.data

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to search
      </Link>

      <div className="flex items-center gap-4">
        {s.logoUrl ? <SetHeaderLogo src={s.logoUrl} /> : null}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{s.name}</h1>
          <p className="text-sm text-slate-400">
            {s.language === 'ja' ? 'Japanese' : 'English'}
            {s.releasedOn ? ` · Released ${s.releasedOn}` : ''}
            {s.cardCountOfficial ? ` · ${s.cardCountOfficial} cards` : ''}
          </p>
        </div>
      </div>

      <section className="space-y-3">
        {cards.isPending ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="aspect-[5/7] animate-pulse rounded-xl bg-slate-800/60" />
            ))}
          </div>
        ) : cards.isError ? (
          <p role="alert" className="text-sm text-rose-300">
            Cards could not be loaded.
          </p>
        ) : cards.data.length === 0 ? (
          <p className="text-sm text-slate-500">No cards ingested for this set yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {cards.data.map((card) => (
              <CardResultCard key={card.cardId} card={card} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
