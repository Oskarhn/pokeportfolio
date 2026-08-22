import { Link } from '@tanstack/react-router'
import type { CatalogSearchResult } from '../../data/catalog'
import type { CardPriceSummary } from '../../data/pricing'
import { formatNokMinor } from '../../ui/money-format'
import { CardImage } from './CardImage'
import { AddQuickButton } from './AddQuickButton'

/** M9.1 (prompt §7): honest compact-tile price text — never one arbitrary variant's price shown
 *  as "the" price for a multi-variant card, and partial coverage never implied as complete. */
function priceText(summary: CardPriceSummary | undefined): string | null {
  if (!summary || summary.pricedCount === 0) return null
  const { pricedCount, variantCount, minValueNokMinor, maxValueNokMinor } = summary
  if (minValueNokMinor === null || maxValueNokMinor === null) return null
  if (pricedCount < variantCount) return `From kr ${formatNokMinor(minValueNokMinor)}`
  if (minValueNokMinor === maxValueNokMinor) return `kr ${formatNokMinor(minValueNokMinor)}`
  return `kr ${formatNokMinor(minValueNokMinor)}–${formatNokMinor(maxValueNokMinor)}`
}

/**
 * Image-led card result unit (M7.1 prompt §29-30) — replaces M7's generic list row. Real fields
 * only: name, set, rarity, collector number. No fabricated collector-number suffix ("/217") when
 * the set total is not part of this query's data — showing one would imply precision the data
 * does not carry (M7.1 prompt §29's own warning against exactly that).
 *
 * `priceSummary` is computed by the caller from one batched search-prices request per result page
 * (M9.1 prompt §6) — this component never fetches its own price.
 */
export function CardResultCard({
  card,
  priceSummary,
}: {
  card: CatalogSearchResult
  priceSummary?: CardPriceSummary
}) {
  const price = priceText(priceSummary)
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
          {price ? <p className="truncate text-xs font-medium text-slate-300">{price}</p> : null}
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
