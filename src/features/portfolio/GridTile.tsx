import { Link } from '@tanstack/react-router'
import type { PortfolioTile } from '../../data/portfolio'
import { portfolioDisplayName, portfolioSubtitle } from '../../data/portfolio'
import { sealedIntentBreakdown } from '../../data/collection'
import { CardImage } from '../catalog/CardImage'
import { SealedProductImage } from '../catalog/SealedProductImage'
import { CONDITION_LABEL } from '../collection/labels'
import { formatNokMinor } from '../../ui/money-format'
import { CheckIcon } from '../../ui/icons'

/** Density-specific tile content (DESIGN_SYSTEM.md §4.1, M7 prompt §25/§59-60). Higher density
 *  genuinely shows less — that is the trade the setting makes, and it is the user's to make, not
 *  overridden because a denser tile "should" show more. Tapping always opens full detail, unless
 *  select mode is active (M7.1 prompt §42-43), where tapping toggles selection instead — a plain
 *  button rather than a Link, keyed by holding id so selection survives virtualization unmounting
 *  a tile and remounting it later (M7.1 prompt §73). */
export function GridTile({
  tile,
  density,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  tile: PortfolioTile
  density: number
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: (holdingId: string) => void
}) {
  const name = portfolioDisplayName(tile)
  const isSealed = tile.holdingKind === 'sealed'
  const conditionText = isSealed
    ? null
    : tile.holdingKind === 'graded_card'
      ? `${tile.grader?.toUpperCase() ?? ''} ${tile.grade ?? ''}`.trim()
      : tile.condition
        ? CONDITION_LABEL[tile.condition]
        : null
  const intentText = isSealed ? sealedIntentBreakdown(tile) : ''

  const content = (
    <>
      <div className="relative">
        {isSealed ? (
          <SealedProductImage
            imageUrl={tile.sealedImageUrl}
            productType={tile.sealedProductType ?? 'other'}
            alt={name}
            className="aspect-[5/7] w-full"
          />
        ) : (
          <CardImage
            imageBaseUrl={tile.cardImageBaseUrl}
            alt={name}
            quality="low"
            className="aspect-[5/7] w-full"
          />
        )}
        {selectMode ? (
          <span
            aria-hidden
            className={`absolute right-1 top-1 flex size-5 items-center justify-center rounded-full border-2 ${
              selected
                ? 'border-sky-500 bg-sky-600 text-accent-foreground'
                : 'border-slate-100/70 bg-slate-950/40'
            }`}
          >
            {selected ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
          </span>
        ) : (
          <>
            {tile.quantity > 1 ? (
              <span className="absolute right-1 top-1 rounded-full bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-100">
                ×{tile.quantity}
              </span>
            ) : null}
            {tile.isFavorite ? (
              <span
                aria-hidden
                className="absolute left-1 top-1 rounded-full bg-slate-950/80 px-1 text-xs text-slate-100"
              >
                ★
              </span>
            ) : null}
          </>
        )}
        {density >= 3 && conditionText ? (
          <span className="absolute bottom-1 left-1 rounded bg-slate-950/80 px-1 py-0.5 text-[9px] font-medium text-slate-200">
            {conditionText}
          </span>
        ) : null}
        {isSealed && tile.sealedIsCustom ? (
          <span
            className="absolute bottom-1 left-1 rounded bg-slate-950/80 px-1 py-0.5 text-[9px] font-medium text-slate-400"
            title="A custom product you added — not part of the shared catalog"
          >
            Custom
          </span>
        ) : null}
      </div>

      {density <= 2 ? (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-100">{name}</p>
          <p className="truncate text-xs text-slate-400">{portfolioSubtitle(tile)}</p>
          {isSealed ? (
            intentText ? (
              <p className="truncate text-xs text-slate-500">{intentText}</p>
            ) : null
          ) : density === 1 ? (
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
    </>
  )

  if (selectMode) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => {
          onToggleSelect?.(tile.holdingId)
        }}
        className="group flex w-full flex-col gap-1.5 rounded-lg p-1.5 text-left hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
      >
        {content}
      </button>
    )
  }

  return (
    <Link
      to="/portfolio/$holdingId"
      params={{ holdingId: tile.holdingId }}
      className="group flex flex-col gap-1.5 rounded-lg p-1.5 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
    >
      {content}
    </Link>
  )
}

/** Never a fabricated value, and never zero for "unknown" (DESIGN_SYSTEM.md §7 — absence is not
 *  zero). Shows the holding's TOTAL value (unit × quantity, D-052) — a stack of 20 owned copies
 *  reads as what it's actually worth, not one copy's price. A stale (4-30 day old) resolved value
 *  still shows, with a subtle marker, never hidden (FINANCIAL_MODEL.md §6). */
function ValueLine({ tile, compact }: { tile: PortfolioTile; compact?: boolean }) {
  if (tile.holdingValueMinor === null) {
    return <p className={compact ? 'text-[10px] text-slate-600' : 'text-xs text-slate-600'}>—</p>
  }
  return (
    <p
      className={
        compact
          ? 'flex items-center gap-1 text-[10px] text-slate-300'
          : 'flex items-center gap-1 text-xs text-slate-300'
      }
    >
      {formatNokMinor(tile.holdingValueMinor)} NOK
      {tile.priceState === 'stale' ? (
        <span className="size-1.5 rounded-full bg-slate-400" title="Price is a few days old" />
      ) : null}
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
