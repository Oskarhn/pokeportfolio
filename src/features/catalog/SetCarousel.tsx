import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listRecentSets, type CatalogLanguage } from '../../data/catalog'

/**
 * Search's horizontally-scrollable set strip (M7.1 prompt §28): real Pokémon TCG sets, newest
 * first, filtered by the active language — not user custom collections, and not a text-only
 * `<select>`. Real set logo/symbol art with a neutral fallback for the sets that have none.
 */
export function SetCarousel({ language }: { language: CatalogLanguage | 'all' }) {
  const sets = useQuery({
    queryKey: ['catalog-recent-sets', language],
    queryFn: () => listRecentSets({ language: language === 'all' ? null : language, limit: 20 }),
  })

  if (sets.isPending) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 w-20 shrink-0 animate-pulse rounded-xl bg-slate-800/60" />
        ))}
      </div>
    )
  }
  if (sets.isError || sets.data.length === 0) return null

  return (
    <div className="flex gap-3 overflow-x-auto pb-1" role="list" aria-label="Browse sets">
      {sets.data.map((set) => (
        <Link
          key={set.id}
          to="/catalog/sets/$setId"
          params={{ setId: set.id }}
          role="listitem"
          className="flex w-20 shrink-0 flex-col items-center gap-1.5 rounded-xl p-2 text-center hover:bg-slate-800/60"
        >
          {set.logoUrl || set.symbolUrl ? (
            <img
              src={set.logoUrl ?? set.symbolUrl ?? undefined}
              alt=""
              loading="lazy"
              className="h-12 w-16 object-contain"
            />
          ) : (
            <div className="flex h-12 w-16 items-center justify-center rounded-lg bg-slate-800 text-[10px] text-slate-500">
              {set.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <span className="line-clamp-2 text-[11px] leading-tight text-slate-300">{set.name}</span>
        </Link>
      ))}
    </div>
  )
}
