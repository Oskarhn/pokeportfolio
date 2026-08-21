import { useQuery } from '@tanstack/react-query'
import { listCustomCollections } from '../../data/customCollections'
import { Sheet } from '../../ui/Sheet'

/** Picks a custom collection for a bulk membership write (M7.1 prompt §43). Reuses the exact same
 *  collections the chip row and Home's scope selector already read — no second grouping model. */
export function CollectionPickerSheet({
  open,
  onClose,
  title,
  onPick,
}: {
  open: boolean
  onClose: () => void
  title: string
  onPick: (collectionId: string) => void
}) {
  const collections = useQuery({ queryKey: ['custom-collections'], queryFn: listCustomCollections })

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-1">
        {(collections.data ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              onPick(c.id)
              onClose()
            }}
            className="flex min-h-11 items-center rounded-lg px-3 text-left text-sm font-medium text-slate-200 hover:bg-slate-800/60"
          >
            {c.name}
          </button>
        ))}
        {collections.isSuccess && collections.data.length === 0 ? (
          <p className="px-3 py-2 text-sm text-slate-500">
            No custom collections yet — create one from the collections row on Portfolio first.
          </p>
        ) : null}
      </div>
    </Sheet>
  )
}
