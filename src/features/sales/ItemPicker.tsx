import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  listPortfolio,
  portfolioDisplayName,
  portfolioSubtitle,
  type PortfolioTile,
} from '../../data/portfolio'
import { CardImage } from '../catalog/CardImage'
import { Sheet } from '../../ui/Sheet'

/**
 * "What am I selling from what I own?" (prompt §75) — searches only current owned holdings via
 * the bounded `list_portfolio` RPC (name_asc, whatever the query matches), never the shared
 * catalog. Selecting one hands the holding id back to the sale builder, which loads its own open
 * lots separately.
 */
export function ItemPicker({
  open,
  onClose,
  onPick,
  excludeHoldingIds,
}: {
  open: boolean
  onClose: () => void
  onPick: (tile: PortfolioTile) => void
  excludeHoldingIds: Set<string>
}) {
  const [query, setQuery] = useState('')

  const results = useQuery({
    queryKey: ['sale-item-picker', query],
    queryFn: () => listPortfolio({ sort: 'name_asc', filters: query ? { query } : {}, limit: 20 }),
    enabled: open,
  })

  return (
    <Sheet open={open} onClose={onClose} title="Add item to sale">
      <div className="space-y-3">
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          placeholder="Search your Portfolio…"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
        />
        <div className="max-h-96 space-y-1 overflow-y-auto">
          {results.isPending ? (
            <div className="h-16 animate-pulse rounded-lg bg-slate-800/60" />
          ) : results.data && results.data.results.length > 0 ? (
            results.data.results
              .filter((tile) => !excludeHoldingIds.has(tile.holdingId))
              .map((tile) => (
                <button
                  key={tile.holdingId}
                  type="button"
                  onClick={() => {
                    onPick(tile)
                  }}
                  className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 text-left hover:bg-slate-800/60"
                >
                  <CardImage
                    imageBaseUrl={tile.cardImageBaseUrl}
                    alt={portfolioDisplayName(tile)}
                    quality="low"
                    className="h-12 w-9 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {portfolioDisplayName(tile)}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {portfolioSubtitle(tile)}
                      {tile.condition ? ` · ${tile.condition}` : ''} · owns ×{tile.quantity}
                    </p>
                  </div>
                </button>
              ))
          ) : (
            <p className="p-3 text-sm text-slate-500">
              {query ? 'No owned cards match.' : 'Start typing to search what you own.'}
            </p>
          )}
        </div>
      </div>
    </Sheet>
  )
}
