import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { bulkSetFavorite } from '../../data/collection'
import { addHoldingsToCollection, removeHoldingsFromCollection } from '../../data/customCollections'
import { CollectionPickerSheet } from './CollectionPickerSheet'
import { XIcon, StarIcon } from '../../ui/icons'

/**
 * Portfolio select mode's action bar (M7.1 prompt §42-43). Functional bulk actions only — add/
 * remove selected holdings to/from a custom collection, and favourite/unfavourite. Bulk "Remove
 * from Portfolio" is deliberately absent: it needs a batch-void operation that voids acquisition
 * lots safely and atomically (never a hard DELETE), and building that correctly under time
 * pressure risks an unsafe or partial operation on financial records — the prompt's own guidance
 * is to ship the safe subset now and document the rest as deferred rather than ship something
 * that can corrupt a purchase/lot history (see docs/BACKLOG.md).
 */
export function BulkActionsBar({
  selectedIds,
  activeCollectionId,
  onClear,
}: {
  selectedIds: Set<string>
  activeCollectionId: string | undefined
  onClear: () => void
}) {
  const queryClient = useQueryClient()
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const ids = [...selectedIds]

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
    </div>
  )
}
