import { useState } from 'react'
import { Sheet } from '../../ui/Sheet'
import { MoreIcon, CheckIcon } from '../../ui/icons'
import { SORT_LABEL, SORT_OPTIONS, type PortfolioSortOrder } from '../../data/portfolio'

/**
 * Portfolio's top-bar action menu (M7.1 prompt §40-41): Sort and Select, reachable from beside the
 * search field — a shortcut into the same sort state the toolbar's own Sort button already
 * controls (DESIGN_SYSTEM.md's "toolbar controls stay independently visible" rule is about that
 * toolbar staying uncollapsed, not about this being the only place Sort can live).
 */
export function PortfolioActionMenu({
  sort,
  onSortChange,
  onEnterSelectMode,
}: {
  sort: PortfolioSortOrder
  onSortChange: (sort: PortfolioSortOrder) => void
  onEnterSelectMode: () => void
}) {
  const [open, setOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
        }}
        aria-label="Portfolio actions"
        className="flex size-11 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-400 hover:bg-slate-800"
      >
        <MoreIcon className="size-5" />
      </button>

      <Sheet
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        title="Actions"
      >
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setSortOpen(true)
            }}
            className="flex min-h-11 items-center justify-between rounded-lg px-3 text-left text-sm font-medium text-slate-200 hover:bg-slate-800/60"
          >
            Sort
            <span className="text-xs font-normal text-slate-500">{SORT_LABEL[sort]}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onEnterSelectMode()
            }}
            className="flex min-h-11 items-center rounded-lg px-3 text-left text-sm font-medium text-slate-200 hover:bg-slate-800/60"
          >
            Select
          </button>
        </div>
      </Sheet>

      <Sheet
        open={sortOpen}
        onClose={() => {
          setSortOpen(false)
        }}
        title="Sort by"
      >
        <div className="flex flex-col gap-1">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={sort === option}
              onClick={() => {
                onSortChange(option)
                setSortOpen(false)
              }}
              className={`flex min-h-11 items-center justify-between rounded-lg px-3 text-left text-sm font-medium ${
                sort === option ? 'bg-sky-600/20 text-sky-200' : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              {SORT_LABEL[option]}
              {sort === option ? <CheckIcon className="size-4" /> : null}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  )
}
