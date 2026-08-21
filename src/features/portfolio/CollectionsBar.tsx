import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCustomCollection,
  deleteCustomCollection,
  listCustomCollections,
  renameCustomCollection,
} from '../../data/customCollections'
import { Sheet } from '../../ui/Sheet'
import { Button, TextField } from '../../ui/form'

/**
 * Custom collections are playlist-like (M7 prompt §39): a horizontal chip row keeps them
 * discoverable from Portfolio itself rather than buried in More (M7 prompt §86), without crowding
 * the mobile top area. Selecting one filters the main view via the same `customCollectionId`
 * search param the full filter panel uses (M7 prompt §34: quick controls and the full filter
 * panel share one state).
 */
export function CollectionsBar({
  activeId,
  onSelect,
}: {
  activeId: string | undefined
  onSelect: (id: string | undefined) => void
}) {
  const queryClient = useQueryClient()
  const [manageOpen, setManageOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const collections = useQuery({ queryKey: ['custom-collections'], queryFn: listCustomCollections })

  const createMutation = useMutation({
    mutationFn: (name: string) => createCustomCollection({ name }),
    onSuccess: async () => {
      setNewName('')
      await queryClient.invalidateQueries({ queryKey: ['custom-collections'] })
    },
  })
  const renameMutation = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      renameCustomCollection(input.id, { name: input.name }),
    onSuccess: async () => {
      setRenamingId(null)
      await queryClient.invalidateQueries({ queryKey: ['custom-collections'] })
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCustomCollection(id),
    onSuccess: async (_void, id) => {
      if (activeId === id) onSelect(undefined)
      await queryClient.invalidateQueries({ queryKey: ['custom-collections'] })
    },
  })

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      <button
        type="button"
        aria-pressed={activeId === undefined}
        onClick={() => {
          onSelect(undefined)
        }}
        className={`min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium ${
          activeId === undefined
            ? 'border-sky-500 bg-sky-600/20 text-sky-200'
            : 'border-slate-700 text-slate-300 hover:bg-slate-800'
        }`}
      >
        All cards
      </button>
      {(collections.data ?? []).map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={activeId === c.id}
          onClick={() => {
            onSelect(c.id)
          }}
          className={`min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium ${
            activeId === c.id
              ? 'border-sky-500 bg-sky-600/20 text-sky-200'
              : 'border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
        >
          {c.name}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          setManageOpen(true)
        }}
        className="min-h-9 shrink-0 rounded-full border border-dashed border-slate-700 px-3 text-xs font-medium text-slate-400 hover:bg-slate-800"
      >
        + Collections
      </button>

      <Sheet
        open={manageOpen}
        onClose={() => {
          setManageOpen(false)
        }}
        title="Custom collections"
      >
        <div className="space-y-4">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (newName.trim()) createMutation.mutate(newName.trim())
            }}
          >
            <TextField
              label="New collection"
              placeholder="Trade Binder"
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value)
              }}
            />
            <Button type="submit" variant="quiet" className="w-auto shrink-0">
              Create
            </Button>
          </form>

          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {(collections.data ?? []).map((c) => (
              <li key={c.id} className="flex items-center gap-2 p-2">
                {renamingId === c.id ? (
                  <>
                    <input
                      value={renameValue}
                      onChange={(event) => {
                        setRenameValue(event.target.value)
                      }}
                      className="min-h-9 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        renameMutation.mutate({ id: c.id, name: renameValue })
                      }}
                      className="text-xs text-sky-400 underline-offset-4 hover:underline"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm text-slate-200">{c.name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(c.id)
                        setRenameValue(c.name)
                      }}
                      className="text-xs text-slate-400 underline-offset-4 hover:underline"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          confirm(
                            `Remove "${c.name}"? This removes the group. The cards in it stay in your Portfolio.`,
                          )
                        ) {
                          deleteMutation.mutate(c.id)
                        }
                      }}
                      className="text-xs text-rose-400 underline-offset-4 hover:underline"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
            {(collections.data ?? []).length === 0 ? (
              <li className="p-3 text-sm text-slate-500">No custom collections yet.</li>
            ) : null}
          </ul>
        </div>
      </Sheet>
    </div>
  )
}
