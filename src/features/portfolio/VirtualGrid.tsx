import { useRef } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import type { PortfolioTile } from '../../data/portfolio'
import { GridTile, gridColumnsClass } from './GridTile'
import { useResponsiveColumns } from './useResponsiveColumns'
import { useScrollMargin } from './useScrollMargin'

/**
 * A 10 000-lot Portfolio cannot mount 10 000 tiles (M7 prompt §53-57/§116) — virtualizing over the
 * *window* scroll (rather than a fixed-height inner container) keeps the rest of the page — the
 * toolbar, filter chips — in normal document flow, which a fixed-height virtualized viewport would
 * otherwise force out of. Each virtual "row" is one CSS grid row of `columns` tiles; `columns`
 * itself comes from `useResponsiveColumns`, the JS mirror of the same breakpoints `gridColumnsClass`
 * encodes in Tailwind, since a virtualizer has to know row *count* before CSS ever lays anything out.
 */
export function VirtualGrid({
  tiles,
  density,
  onEndReached,
  hasMore,
}: {
  tiles: PortfolioTile[]
  density: number
  onEndReached: () => void
  hasMore: boolean
}) {
  const columns = useResponsiveColumns(density)
  const rowCount = Math.ceil(tiles.length / columns) + (hasMore ? 1 : 0)
  const parentRef = useRef<HTMLDivElement>(null)
  const scrollMargin = useScrollMargin(parentRef)

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => 260,
    overscan: 4,
    scrollMargin,
  })

  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index

  if (lastIndex !== undefined && lastIndex >= rowCount - 1 && hasMore) {
    // Fires during render intentionally debounced by the virtualizer's own item identity — this
    // mirrors the standard TanStack Virtual "load more at the last row" recipe rather than a
    // separate IntersectionObserver, which would double up on scroll listeners for the same signal.
    queueMicrotask(onEndReached)
  }

  return (
    <div ref={parentRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {items.map((virtualRow) => {
          const start = virtualRow.index * columns
          const rowTiles = tiles.slice(start, start + columns)
          const isLoaderRow = virtualRow.index === rowCount - 1 && hasMore

          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {isLoaderRow ? (
                <div className="grid h-24 place-items-center text-sm text-slate-500">
                  Loading more…
                </div>
              ) : (
                <div className={`grid gap-3 ${gridColumnsClass(density)}`}>
                  {rowTiles.map((tile) => (
                    <GridTile key={tile.holdingId} tile={tile} density={density} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
