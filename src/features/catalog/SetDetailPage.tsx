import { Link, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getSet, listCardsInSet } from '../../data/catalog'
import { CardImage } from './CardImage'
import { AddQuickButton } from './AddQuickButton'

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
        {s.logoUrl ? (
          <img src={s.logoUrl} alt="" className="h-12 max-w-40 object-contain" loading="lazy" />
        ) : null}
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
          <ul className="space-y-2" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="h-20 animate-pulse rounded-lg bg-slate-800/60" />
            ))}
          </ul>
        ) : cards.isError ? (
          <p role="alert" className="text-sm text-rose-300">
            Cards could not be loaded.
          </p>
        ) : cards.data.length === 0 ? (
          <p className="text-sm text-slate-500">No cards ingested for this set yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {cards.data.map((card) => (
              <li key={card.cardId} className="flex items-center gap-2 p-3">
                <Link
                  to="/catalog/$cardId"
                  params={{ cardId: card.cardId }}
                  className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none"
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
                      #{card.localId}
                      {card.rarity ? ` · ${card.rarity}` : ''}
                    </p>
                  </div>
                </Link>
                <AddQuickButton cardId={card.cardId} cardName={card.name} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
