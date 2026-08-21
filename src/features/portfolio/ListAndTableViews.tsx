import { useRef } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Link } from '@tanstack/react-router'
import type { PortfolioTile } from '../../data/portfolio'
import { portfolioDisplayName, portfolioSubtitle } from '../../data/portfolio'
import { CardImage } from '../catalog/CardImage'
import { CONDITION_LABEL } from '../collection/labels'
import { formatNokMinor } from '../../ui/money-format'
import { useScrollMargin } from './useScrollMargin'

function valueText(tile: PortfolioTile): string {
  return tile.resolvedValueMinor === null ? '—' : `${formatNokMinor(tile.resolvedValueMinor)} NOK`
}

function conditionText(tile: PortfolioTile): string {
  if (tile.holdingKind === 'graded_card') {
    return `${tile.grader?.toUpperCase() ?? ''} ${tile.grade ?? ''}`.trim() || '—'
  }
  return tile.condition ? CONDITION_LABEL[tile.condition] : '—'
}

/** More information-dense than Grid (M7 prompt §44) — mobile rows target 56-64px per
 *  DESIGN_SYSTEM.md §4.2's "thumbs are imprecise" rule. Same window-virtualized shape as the grid. */
export function PortfolioListView({
  tiles,
  onEndReached,
  hasMore,
}: {
  tiles: PortfolioTile[]
  onEndReached: () => void
  hasMore: boolean
}) {
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
                <Link
                  to="/portfolio/$holdingId"
                  params={{ holdingId: tile.holdingId }}
                  className="flex min-h-16 items-center gap-3 px-3 py-2 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
                >
                  <CardImage
                    imageBaseUrl={tile.cardImageBaseUrl}
                    alt={portfolioDisplayName(tile)}
                    quality="low"
                    className="h-14 w-10 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {portfolioDisplayName(tile)}
                      {tile.isFavorite ? ' ★' : ''}
                    </p>
                    <p className="truncate text-xs text-slate-400">{portfolioSubtitle(tile)}</p>
                    <p className="truncate text-xs text-slate-500">
                      {conditionText(tile)}
                      {tile.hasMultipleStorageLocations ? ' · Multiple locations' : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {tile.quantity > 1 ? (
                      <p className="text-sm font-semibold text-slate-200">×{tile.quantity}</p>
                    ) : null}
                    <p className="text-xs text-slate-400">{valueText(tile)}</p>
                  </div>
                </Link>
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
}: {
  tiles: PortfolioTile[]
  onEndReached: () => void
  hasMore: boolean
}) {
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
                    <td className="min-w-0 flex-[2] gap-2 p-2">
                      <Link
                        to="/portfolio/$holdingId"
                        params={{ holdingId: tile.holdingId }}
                        className="flex min-w-0 items-center gap-2 hover:underline"
                      >
                        <span className="truncate font-medium text-slate-100">
                          {portfolioDisplayName(tile)}
                        </span>
                        {tile.isFavorite ? <span className="text-amber-400">★</span> : null}
                      </Link>
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
