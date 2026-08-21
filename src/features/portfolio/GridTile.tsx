import { Link } from '@tanstack/react-router'
import type { PortfolioTile } from '../../data/portfolio'
import { portfolioDisplayName, portfolioSubtitle } from '../../data/portfolio'
import { CardImage } from '../catalog/CardImage'
import { CONDITION_LABEL } from '../collection/labels'
import { formatNokMinor } from '../../ui/money-format'

/** Density-specific tile content (DESIGN_SYSTEM.md §4.1, M7 prompt §25/§59-60). Higher density
 *  genuinely shows less — that is the trade the setting makes, and it is the user's to make, not
 *  overridden because a denser tile "should" show more. Tapping always opens full detail. */
export function GridTile({ tile, density }: { tile: PortfolioTile; density: number }) {
  const name = portfolioDisplayName(tile)
  const conditionText =
    tile.holdingKind === 'graded_card'
      ? `${tile.grader?.toUpperCase() ?? ''} ${tile.grade ?? ''}`.trim()
      : tile.condition
        ? CONDITION_LABEL[tile.condition]
        : null

  return (
    <Link
      to="/portfolio/$holdingId"
      params={{ holdingId: tile.holdingId }}
      className="group flex flex-col gap-1.5 rounded-lg p-1.5 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
    >
      <div className="relative">
        <CardImage
          imageBaseUrl={tile.cardImageBaseUrl}
          alt={name}
          quality="low"
          className="aspect-[5/7] w-full"
        />
        {tile.quantity > 1 ? (
          <span className="absolute right-1 top-1 rounded-full bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-100">
            ×{tile.quantity}
          </span>
        ) : null}
        {tile.isFavorite ? (
          <span aria-hidden className="absolute left-1 top-1 text-xs text-amber-400">
            ★
          </span>
        ) : null}
        {density >= 3 && conditionText ? (
          <span className="absolute bottom-1 left-1 rounded bg-slate-950/80 px-1 py-0.5 text-[9px] font-medium text-slate-200">
            {conditionText}
          </span>
        ) : null}
      </div>

      {density <= 2 ? (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-100">{name}</p>
          <p className="truncate text-xs text-slate-400">{portfolioSubtitle(tile)}</p>
          {density === 1 ? (
            <p className="truncate text-xs text-slate-500">
              {conditionText}
              {tile.manualCardId ? ' · Manual entry' : ''}
            </p>
          ) : null}
          <ValueLine tile={tile} />
        </div>
      ) : density === 3 ? (
        <ValueLine tile={tile} compact />
      ) : null}
    </Link>
  )
}

/** Never a fabricated value, and never zero for "unknown" (DESIGN_SYSTEM.md §7 — absence is not
 *  zero). Reserves a stable line so a later real value (M9) is a small change, not a layout one. */
function ValueLine({ tile, compact }: { tile: PortfolioTile; compact?: boolean }) {
  if (tile.resolvedValueMinor === null) {
    return <p className={compact ? 'text-[10px] text-slate-600' : 'text-xs text-slate-600'}>—</p>
  }
  return (
    <p className={compact ? 'text-[10px] text-slate-300' : 'text-xs text-slate-300'}>
      {formatNokMinor(tile.resolvedValueMinor)} NOK
    </p>
  )
}

/** Mobile 2 / desktop 4 at the default density; denser modes show more, less metadata; density 1
 *  shows fewer, larger tiles (M7 prompt §22-23/§58). */
export function gridColumnsClass(density: number): string {
  switch (density) {
    case 1:
      return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
    case 3:
      return 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6'
    case 4:
      return 'grid-cols-4 sm:grid-cols-5 lg:grid-cols-8'
    case 2:
    default:
      return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
  }
}
