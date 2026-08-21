import { useState } from 'react'
import { Sheet } from '../../ui/Sheet'
import { Button } from '../../ui/form'
import { CONDITION_LABEL, GRADER_LABEL } from '../collection/labels'
import type { PortfolioFilters } from '../../data/portfolio'
import type { CardCondition, Grader } from '../../data/collection'

const CONDITIONS = Object.keys(CONDITION_LABEL) as CardCondition[]
const GRADERS = Object.keys(GRADER_LABEL) as Grader[]

/**
 * The full filter interface (M7 prompt §33/§84). Quick chips and this panel read and write the
 * same `PortfolioFilters` shape passed down from the route's URL search params — there is only
 * one filter state, never two systems that can disagree (M7 prompt §34).
 *
 * Value/missing-price honesty (M7 prompt §35-37): before M9 there is no raw-card market price.
 * "Low value"/"Missing value" here operate only on a graded holding's real manual valuation
 * (M6) — never a fabricated raw-card figure, and never the acquisition cost standing in for it.
 */
export function FiltersSheet({
  open,
  onClose,
  filters,
  onApply,
}: {
  open: boolean
  onClose: () => void
  filters: PortfolioFilters
  onApply: (next: PortfolioFilters) => void
}) {
  // Initialized once from the filters in effect when this sheet mounts — the parent remounts it
  // (via a `key` that changes on open) each time it opens, so this is always fresh without a
  // useEffect+setState resync, the pattern react-hooks/set-state-in-effect flags as cascading.
  const [draft, setDraft] = useState<PortfolioFilters>(filters)

  return (
    <Sheet open={open} onClose={onClose} title="Filters">
      <div className="max-h-[70vh] space-y-5 overflow-y-auto">
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Raw / Graded
          </legend>
          <div className="flex gap-2">
            {(
              [
                [undefined, 'All'],
                [false, 'Raw'],
                [true, 'Graded'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={draft.graded === value}
                onClick={() => {
                  setDraft((d) => ({ ...d, graded: value, grader: value ? d.grader : undefined }))
                }}
                className={`min-h-9 flex-1 rounded-lg border text-sm font-medium ${
                  draft.graded === value
                    ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                    : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {draft.graded ? (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Grader
            </legend>
            <div className="flex flex-wrap gap-2">
              {GRADERS.map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={draft.grader === g}
                  onClick={() => {
                    setDraft((d) => ({ ...d, grader: d.grader === g ? undefined : g }))
                  }}
                  className={`min-h-9 rounded-lg border px-3 text-sm font-medium ${
                    draft.grader === g
                      ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {GRADER_LABEL[g]}
                </button>
              ))}
            </div>
          </fieldset>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Condition
            </legend>
            <div className="flex flex-wrap gap-2">
              {CONDITIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={draft.condition === c}
                  onClick={() => {
                    setDraft((d) => ({ ...d, condition: d.condition === c ? undefined : c }))
                  }}
                  className={`min-h-9 rounded-lg border px-3 text-sm font-medium ${
                    draft.condition === c
                      ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {CONDITION_LABEL[c]}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Value
          </legend>
          <p className="text-xs text-slate-500">
            Market pricing for raw cards is not available yet. These only apply to a graded card's
            manual value.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={draft.lowValue === true}
              onClick={() => {
                setDraft((d) => ({
                  ...d,
                  lowValue: d.lowValue ? undefined : true,
                  missingValue: undefined,
                }))
              }}
              className={`min-h-9 rounded-lg border px-3 text-sm font-medium ${
                draft.lowValue
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              Low value
            </button>
            <button
              type="button"
              aria-pressed={draft.missingValue === true}
              onClick={() => {
                setDraft((d) => ({
                  ...d,
                  missingValue: d.missingValue ? undefined : true,
                  lowValue: undefined,
                }))
              }}
              className={`min-h-9 rounded-lg border px-3 text-sm font-medium ${
                draft.missingValue
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              Missing value
            </button>
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Other
          </legend>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={draft.favorite === true}
              onClick={() => {
                setDraft((d) => ({ ...d, favorite: d.favorite ? undefined : true }))
              }}
              className={`min-h-9 rounded-lg border px-3 text-sm font-medium ${
                draft.favorite
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              ★ Favourites
            </button>
            <button
              type="button"
              aria-pressed={draft.manualOnly === true}
              onClick={() => {
                setDraft((d) => ({ ...d, manualOnly: d.manualOnly ? undefined : true }))
              }}
              className={`min-h-9 rounded-lg border px-3 text-sm font-medium ${
                draft.manualOnly
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              Manual entries
            </button>
          </div>
        </fieldset>
      </div>

      <div className="mt-4 flex gap-2 border-t border-slate-800 pt-4">
        <Button
          type="button"
          variant="quiet"
          className="w-auto flex-1"
          onClick={() => {
            setDraft({})
            onApply({})
            onClose()
          }}
        >
          Clear all
        </Button>
        <Button
          type="button"
          className="w-auto flex-1"
          onClick={() => {
            onApply(draft)
            onClose()
          }}
        >
          Show results
        </Button>
      </div>
    </Sheet>
  )
}

export function activeFilterCount(filters: PortfolioFilters): number {
  return Object.values(filters).filter((v) => v !== undefined && v !== '').length
}
