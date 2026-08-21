import { Link } from '@tanstack/react-router'
import type { CatalogSearchResult } from '../../data/catalog'
import { CardImage } from './CardImage'
import { AddQuickButton } from './AddQuickButton'

/**
 * Image-led card result unit (M7.1 prompt §29-30) — replaces M7's generic list row. Real fields
 * only: name, set, rarity, collector number. No fabricated collector-number suffix ("/217") when
 * the set total is not part of this query's data — showing one would imply precision the data
 * does not carry (M7.1 prompt §29's own warning against exactly that).
 */
export function CardResultCard({ card }: { card: CatalogSearchResult }) {
  return (
    <div className="group relative rounded-xl p-1.5 hover:bg-slate-800/60">
      <Link
        to="/catalog/$cardId"
        params={{ cardId: card.cardId }}
        className="flex flex-col gap-1.5 focus-visible:outline-none"
      >
        <CardImage
          imageBaseUrl={card.imageBaseUrl}
          alt={card.name}
          quality="low"
          className="aspect-[5/7] w-full"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-100">{card.name}</p>
          <p className="truncate text-xs text-slate-400">{card.setName}</p>
          <p className="truncate text-xs text-slate-500">
            {card.rarity ?? (card.category === 'Energy' ? 'Energy' : '—')} · #{card.localId}
          </p>
        </div>
      </Link>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-slate-500">
          {card.language === 'ja' ? 'Japanese' : 'English'}
          {card.variantCount > 1 ? ` · ${card.variantCount} variants` : ''}
        </span>
        <AddQuickButton cardId={card.cardId} cardName={card.name} />
      </div>
    </div>
  )
}
