import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listCustomCollections } from '../data/customCollections'
import { Sheet } from './Sheet'
import { ChevronDownIcon, CheckIcon } from './icons'

/**
 * Shared Home/Portfolio scope selector (M7.1 prompt §17/§44/§74): "Portfolio Main" (everything) or
 * one of the user's existing custom collections. Reuses the exact grouping model M7 already
 * shipped (`custom_collections`) rather than inventing a second one — a `null` scope id means the
 * whole Portfolio; a real id scopes to that collection's membership, the same filter
 * `list_portfolio`'s `p_custom_collection_id` already accepts.
 */
export function ScopeSelector({
  value,
  onChange,
}: {
  value: string | null
  onChange: (collectionId: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const collections = useQuery({ queryKey: ['custom-collections'], queryFn: listCustomCollections })
  const label = value
    ? (collections.data?.find((c) => c.id === value)?.name ?? 'Collection')
    : 'Portfolio Main'

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
        }}
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-lg font-semibold tracking-tight text-slate-100 hover:bg-slate-800"
      >
        {label}
        <ChevronDownIcon className="size-4 text-slate-400" />
      </button>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        title="Switch scope"
      >
        <div className="flex flex-col gap-1">
          <ScopeOption
            label="Portfolio Main"
            description="Everything you own"
            selected={value === null}
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
          />
          {(collections.data ?? []).map((collection) => (
            <ScopeOption
              key={collection.id}
              label={collection.name}
              description={collection.description}
              selected={value === collection.id}
              onClick={() => {
                onChange(collection.id)
                setOpen(false)
              }}
            />
          ))}
          {collections.isSuccess && collections.data.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500">
              No custom collections yet — create one from Portfolio.
            </p>
          ) : null}
        </div>
      </Sheet>
    </>
  )
}

function ScopeOption({
  label,
  description,
  selected,
  onClick,
}: {
  label: string
  description: string | null
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-12 items-center justify-between gap-3 rounded-lg px-3 text-left hover:bg-slate-800/60"
    >
      <span>
        <span className="block text-sm font-medium text-slate-100">{label}</span>
        {description ? <span className="block text-xs text-slate-500">{description}</span> : null}
      </span>
      {selected ? <CheckIcon className="size-4 shrink-0 text-sky-400" /> : null}
    </button>
  )
}
