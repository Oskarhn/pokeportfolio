import { useRef } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Link } from '@tanstack/react-router'
import type { PortfolioTile } from '../../data/portfolio'
import { portfolioDisplayName, portfolioSubtitle } from '../../data/portfolio'
import { sealedIntentBreakdown } from '../../data/collection'
import { CardImage } from '../catalog/CardImage'
import { SealedProductImage } from '../catalog/SealedProductImage'
import { CONDITION_LABEL } from '../collection/labels'
import { formatNokMinor } from '../../ui/money-format'
import { CheckIcon } from '../../ui/icons'
import { useScrollMargin } from './useScrollMargin'

interface SelectModeProps {
  selectMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (holdingId: string) => void
}

function valueText(tile: PortfolioTile): string {
  if (tile.holdingValueMinor === null) return '—'
  const suffix = tile.priceState === 'stale' ? ' ·' : ''
  return `${formatNokMinor(tile.holdingValueMinor)} NOK${suffix}`
}

function conditionText(tile: PortfolioTile): string {
  if (tile.holdingKind === 'graded_card') {
    return `${tile.grader?.toUpperCase() ?? ''} ${tile.grade ?? ''}`.trim() || '—'
  }
  // Sealed holdings carry no condition (card-only field) — falls through to the same '—' a raw
  // card with no recorded condition would show, never a blank cell (prompt §41's own rule).
  return tile.condition ? CONDITION_LABEL[tile.condition] : '—'
}

/** List view's denser row has room for the intent breakdown next to condition/grade (Table's
 *  single fixed "Condition / grade" column does not, so Table keeps conditionText() as-is and
 *  shows '—' for a sealed row there instead). */
function rowMetaText(tile: PortfolioTile): string {
  if (tile.holdingKind === 'sealed') {
    return sealedIntentBreakdown(tile) || '—'
  }
  return conditionText(tile)
}

/** More information-dense than Grid (M7 prompt §44) — mobile rows target 56-64px per
 *  DESIGN_SYSTEM.md §4.2's "thumbs are imprecise" rule. Same window-virtualized shape as the grid. */
export function PortfolioListView({
  tiles,
  onEndReached,
  hasMore,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: {
  tiles: PortfolioTile[]
  onEndReached: () => void
  hasMore: boolean
} & SelectModeProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const scrollMargin = useScrollMargin(parentRef)
  const count = tiles.length + (hasMore ? 1 : 0)
  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: () => 72,
    overscan: 8,
    scrollMargin,
  })
  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index
  if (lastIndex !== undefined && lastIndex >= count - 1 && hasMore) {
    queueMicrotask(onEndReached)
  }

  return (
    <div ref={parentRef} className="rounded-lg border border-slate-800">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {items.map((row) => {
          const isLoaderRow = row.index === count - 1 && hasMore
          const tile = tiles[row.index]
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
              }}
              className="border-b border-slate-800 last:border-b-0"
            >
              {isLoaderRow || !tile ? (
                <div className="flex h-16 items-center justify-center text-sm text-slate-500">
                  Loading more…
                </div>
              ) : (
                (() => {
                  const rowContent = (
                    <>
                      {selectMode ? (
                        <span
                          aria-hidden
                          className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                            selectedIds?.has(tile.holdingId)
                              ? 'border-sky-500 bg-sky-600 text-accent-foreground'
                              : 'border-slate-600'
                          }`}
                        >
                          {selectedIds?.has(tile.holdingId) ? (
                            <CheckIcon className="size-3" strokeWidth={3} />
                          ) : null}
                        </span>
                      ) : null}
                      {tile.holdingKind === 'sealed' ? (
                        <SealedProductImage
                          imageUrl={tile.sealedImageUrl}
                          productType={tile.sealedProductType ?? 'other'}
                          alt={portfolioDisplayName(tile)}
                          className="h-14 w-10 shrink-0"
                        />
                      ) : (
                        <CardImage
                          imageBaseUrl={tile.cardImageBaseUrl}
                          alt={portfolioDisplayName(tile)}
                          quality="low"
                          className="h-14 w-10 shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-100">
                          {portfolioDisplayName(tile)}
                          {tile.isFavorite ? ' ★' : ''}
                          {tile.holdingKind === 'sealed' && tile.sealedIsCustom ? (
                            <span className="ml-1 rounded bg-slate-800 px-1 py-0.5 text-[9px] font-medium text-slate-400">
                              Custom
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-slate-400">{portfolioSubtitle(tile)}</p>
                        <p className="truncate text-xs text-slate-500">
                          {rowMetaText(tile)}
                          {tile.hasMultipleStorageLocations ? ' · Multiple locations' : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {tile.quantity > 1 ? (
                          <p className="text-sm font-semibold text-slate-200">×{tile.quantity}</p>
                        ) : null}
                        <p className="text-xs text-slate-400">{valueText(tile)}</p>
                      </div>
                    </>
                  )
                  if (selectMode) {
                    return (
                      <button
                        type="button"
                        aria-pressed={selectedIds?.has(tile.holdingId)}
                        onClick={() => {
                          onToggleSelect?.(tile.holdingId)
                        }}
                        className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
                      >
                        {rowContent}
                      </button>
                    )
                  }
                  return (
                    <Link
                      to="/portfolio/$holdingId"
                      params={{ holdingId: tile.holdingId }}
                      className="flex min-h-16 items-center gap-3 px-3 py-2 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
                    >
                      {rowContent}
                    </Link>
                  )
                })()
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Table view (M7 prompt §45-46) — also available on mobile, deliberately horizontally scrollable
 * rather than squeezed. Holdings stay grouped: one row per holding, never one row per lot.
 */
export function PortfolioTableView({
  tiles,
  onEndReached,
  hasMore,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: {
  tiles: PortfolioTile[]
  onEndReached: () => void
  hasMore: boolean
} & SelectModeProps) {
  const parentRef = useRef<HTMLTableSectionElement>(null)
  const scrollMargin = useScrollMargin(parentRef)
  const count = tiles.length + (hasMore ? 1 : 0)
  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: () => 40,
    overscan: 12,
    scrollMargin,
  })
  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index
  if (lastIndex !== undefined && lastIndex >= count - 1 && hasMore) {
    queueMicrotask(onEndReached)
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="sticky top-0 bg-slate-950 text-left text-xs text-slate-500">
          <tr>
            {selectMode ? <th className="w-8 p-2" aria-label="Select" /> : null}
            <th className="p-2 font-medium">Card</th>
            <th className="p-2 font-medium">Set / #</th>
            <th className="p-2 font-medium">Qty</th>
            <th className="p-2 font-medium">Condition / grade</th>
            <th className="p-2 font-medium">Storage</th>
            <th className="p-2 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody
          ref={parentRef}
          className="relative block"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((row) => {
            const isLoaderRow = row.index === count - 1 && hasMore
            const tile = tiles[row.index]
            return (
              <tr
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute left-0 flex w-full border-t border-slate-800 [&>td]:flex [&>td]:items-center"
                style={{
                  transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                {isLoaderRow || !tile ? (
                  <td className="h-10 w-full justify-center text-slate-500">Loading more…</td>
                ) : (
                  <>
                    {selectMode ? (
                      <td className="w-8 p-2">
                        <button
                          type="button"
                          aria-pressed={selectedIds?.has(tile.holdingId)}
                          aria-label={`Select ${portfolioDisplayName(tile)}`}
                          onClick={() => {
                            onToggleSelect?.(tile.holdingId)
                          }}
                          className={`flex size-5 items-center justify-center rounded-full border-2 ${
                            selectedIds?.has(tile.holdingId)
                              ? 'border-sky-500 bg-sky-600 text-accent-foreground'
                              : 'border-slate-600'
                          }`}
                        >
                          {selectedIds?.has(tile.holdingId) ? (
                            <CheckIcon className="size-3" strokeWidth={3} />
                          ) : null}
                        </button>
                      </td>
                    ) : null}
                    <td className="min-w-0 flex-[2] gap-2 p-2">
                      {selectMode ? (
                        <button
                          type="button"
                          onClick={() => {
                            onToggleSelect?.(tile.holdingId)
                          }}
                          className="flex min-w-0 items-center gap-2 text-left hover:underline"
                        >
                          <span className="truncate font-medium text-slate-100">
                            {portfolioDisplayName(tile)}
                          </span>
                          {tile.isFavorite ? <span className="text-amber-400">★</span> : null}
                          {tile.holdingKind === 'sealed' && tile.sealedIsCustom ? (
                            <span className="shrink-0 rounded bg-slate-800 px-1 py-0.5 text-[9px] font-medium text-slate-400">
                              Custom
                            </span>
                          ) : null}
                        </button>
                      ) : (
                        <Link
                          to="/portfolio/$holdingId"
                          params={{ holdingId: tile.holdingId }}
                          className="flex min-w-0 items-center gap-2 hover:underline"
                        >
                          <span className="truncate font-medium text-slate-100">
                            {portfolioDisplayName(tile)}
                          </span>
                          {tile.isFavorite ? <span className="text-amber-400">★</span> : null}
                          {tile.holdingKind === 'sealed' && tile.sealedIsCustom ? (
                            <span className="shrink-0 rounded bg-slate-800 px-1 py-0.5 text-[9px] font-medium text-slate-400">
                              Custom
                            </span>
                          ) : null}
                        </Link>
                      )}
                    </td>
                    <td className="min-w-0 flex-[1.5] p-2 text-slate-400">
                      {portfolioSubtitle(tile)}
                    </td>
                    <td className="flex-1 p-2 text-slate-200">×{tile.quantity}</td>
                    <td className="flex-1 p-2 text-slate-400">{conditionText(tile)}</td>
                    <td className="flex-1 p-2 text-slate-400">
                      {tile.hasMultipleStorageLocations ? 'Multiple locations' : '—'}
                    </td>
                    <td className="flex-1 justify-end p-2 text-right text-slate-200">
                      {valueText(tile)}
                    </td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
