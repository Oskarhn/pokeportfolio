import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  bulkSetFavorite,
  removeHoldingsFromPortfolio,
  type RemoveHoldingsResult,
} from '../../data/collection'
import { addHoldingsToCollection, removeHoldingsFromCollection } from '../../data/customCollections'
import { portfolioDisplayName, type PortfolioTile } from '../../data/portfolio'
import { CollectionPickerSheet } from './CollectionPickerSheet'
import { Sheet } from '../../ui/Sheet'
import { Button, FormMessage } from '../../ui/form'
import { XIcon, StarIcon, TrashIcon } from '../../ui/icons'

/**
 * Portfolio select mode's action bar (M7.1 prompt §42-43, extended M8.1 prompt §11-13). Add/
 * remove to/from a custom collection and favourite/unfavourite are purely organisational (C1).
 * Remove from Portfolio is a real financial correction — it calls remove_holdings_from_portfolio
 * (M8.1, DECISIONS.md D-051), atomic and all-or-nothing: if any selected holding is blocked
 * (already partially disposed elsewhere), nothing is voided.
 */
export function BulkActionsBar({
  selectedIds,
  tiles,
  activeCollectionId,
  onClear,
}: {
  selectedIds: Set<string>
  tiles: PortfolioTile[]
  activeCollectionId: string | undefined
  onClear: () => void
}) {
  const queryClient = useQueryClient()
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [blockedResults, setBlockedResults] = useState<RemoveHoldingsResult[] | null>(null)
  const ids = [...selectedIds]
  const selectedTiles = tiles.filter((t) => selectedIds.has(t.holdingId))
  const physicalCount = selectedTiles.reduce((sum, t) => sum + t.quantity, 0)

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
  }

  const addMutation = useMutation({
    mutationFn: (collectionId: string) => addHoldingsToCollection(collectionId, ids),
    onSuccess: async () => {
      await invalidate()
      onClear()
    },
  })
  const removeFromActiveMutation = useMutation({
    mutationFn: () => removeHoldingsFromCollection(activeCollectionId as string, ids),
    onSuccess: async () => {
      await invalidate()
      onClear()
    },
  })
  const favoriteMutation = useMutation({
    mutationFn: (value: boolean) => bulkSetFavorite(ids, value),
    onSuccess: async () => {
      await invalidate()
      onClear()
    },
  })
  const removeMutation = useMutation({
    mutationFn: () => removeHoldingsFromPortfolio(ids),
    onSuccess: async (results) => {
      const blocked = results.filter((r) => r.blocked)
      if (blocked.length > 0) {
        setBlockedResults(blocked)
        return
      }
      setRemoveConfirmOpen(false)
      await invalidate()
      await queryClient.invalidateQueries({ queryKey: ['spending-summary'] })
      onClear()
    },
    onError: (error: Error) => {
      setRemoveError(error.message)
    },
  })

  return (
    <div
      className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/95 p-3 shadow-lg backdrop-blur-xl md:bottom-4"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <button
        type="button"
        onClick={onClear}
        aria-label="Cancel selection"
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800"
      >
        <XIcon className="size-4" />
      </button>
      <p className="mr-auto text-sm font-medium text-slate-200">{selectedIds.size} selected</p>

      <button
        type="button"
        disabled={ids.length === 0}
        onClick={() => {
          setAddSheetOpen(true)
        }}
        className="min-h-9 rounded-full border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      >
        Add to collection
      </button>
      {activeCollectionId ? (
        <button
          type="button"
          disabled={ids.length === 0 || removeFromActiveMutation.isPending}
          onClick={() => {
            removeFromActiveMutation.mutate()
          }}
          className="min-h-9 rounded-full border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          Remove from this collection
        </button>
      ) : null}
      <button
        type="button"
        disabled={ids.length === 0 || favoriteMutation.isPending}
        onClick={() => {
          favoriteMutation.mutate(true)
        }}
        aria-label="Favourite selected"
        className="flex min-h-9 items-center gap-1.5 rounded-full border border-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      >
        <StarIcon className="size-4" />
        Favourite
      </button>
      <button
        type="button"
        disabled={ids.length === 0}
        onClick={() => {
          setRemoveError(null)
          setBlockedResults(null)
          setRemoveConfirmOpen(true)
        }}
        aria-label="Remove from Portfolio"
        className="flex min-h-9 items-center gap-1.5 rounded-full border border-rose-900/60 px-3 text-sm font-medium text-rose-300 hover:bg-rose-950/40 disabled:opacity-50"
      >
        <TrashIcon className="size-4" />
        Remove
      </button>

      <CollectionPickerSheet
        open={addSheetOpen}
        onClose={() => {
          setAddSheetOpen(false)
        }}
        title="Add to collection"
        onPick={(collectionId) => {
          addMutation.mutate(collectionId)
        }}
      />

      <Sheet
        open={removeConfirmOpen}
        onClose={() => {
          setRemoveConfirmOpen(false)
        }}
        title={`Remove ${selectedIds.size} holding${selectedIds.size === 1 ? '' : 's'} from Portfolio?`}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            {physicalCount} physical card{physicalCount === 1 ? '' : 's'} will no longer be tracked.
          </p>
          <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-slate-400">
            {selectedTiles.slice(0, 8).map((tile) => (
              <li key={tile.holdingId} className="truncate">
                {portfolioDisplayName(tile)} × {tile.quantity}
              </li>
            ))}
            {selectedTiles.length > 8 ? <li>and {selectedTiles.length - 8} more…</li> : null}
          </ul>
          <p className="text-xs text-slate-500">
            Use this only to correct an entry — selling or trading a card will have separate
            workflows. Nothing is deleted: your acquisition history is kept, just excluded going
            forward.
          </p>
          {removeError ? <FormMessage tone="error">{removeError}</FormMessage> : null}
          <Button
            variant="primary"
            className="border border-rose-900/60 bg-rose-900/80 hover:bg-rose-800"
            disabled={removeMutation.isPending}
            onClick={() => {
              setRemoveError(null)
              removeMutation.mutate()
            }}
          >
            {removeMutation.isPending ? 'Removing…' : 'Remove from Portfolio'}
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={blockedResults !== null}
        onClose={() => {
          setBlockedResults(null)
        }}
        title="Some holdings could not be removed"
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            Nothing was changed. The rest of your selection was left exactly as it was too — try
            removing the others on their own.
          </p>
          <ul className="space-y-2 text-sm">
            {(blockedResults ?? []).map((r) => {
              const tile = tiles.find((t) => t.holdingId === r.holdingId)
              return (
                <li key={r.holdingId} className="rounded-lg border border-slate-800 p-2">
                  <p className="font-medium text-slate-200">
                    {tile ? portfolioDisplayName(tile) : 'This holding'}
                  </p>
                  <p className="text-xs text-slate-500">{r.blockedReason}</p>
                </li>
              )
            })}
          </ul>
        </div>
      </Sheet>
    </div>
  )
}
