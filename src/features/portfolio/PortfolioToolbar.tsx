import { useState, type ReactNode } from 'react'
import { Sheet } from '../../ui/Sheet'
import { GridIcon, ListIcon, TableIcon, DensityIcon, SortIcon, FilterIcon } from '../../ui/icons'
import {
  SORT_LABEL,
  SORT_OPTIONS,
  type PortfolioFilters,
  type PortfolioSortOrder,
} from '../../data/portfolio'
import type { CollectionView } from '../../data/profile'
import { FiltersSheet, activeFilterCount } from './FiltersSheet'

const VIEW_OPTIONS: { value: CollectionView; label: string; icon: typeof GridIcon }[] = [
  { value: 'grid', label: 'Grid', icon: GridIcon },
  { value: 'list', label: 'List', icon: ListIcon },
  { value: 'table', label: 'Table', icon: TableIcon },
]

const DENSITY_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 1, label: 'Large', hint: 'Fewer cards, more detail' },
  { value: 2, label: 'Default', hint: 'Mobile 2 / desktop 4 per row' },
  { value: 3, label: 'Compact', hint: 'More cards, less detail' },
  { value: 4, label: 'Dense', hint: 'Most cards, image + quantity only' },
]

/**
 * The desktop toolbar puts density next to Sort by, as the owner specifically asked (M7 prompt
 * §92). Mobile keeps every control independently reachable rather than folding them behind one
 * icon (M7 prompt §93) — Sort, Density, View and Filters are four separate, always-visible
 * buttons; only their panels collapse into sheets.
 */
export function PortfolioToolbar({
  resultLabel,
  sort,
  onSortChange,
  density,
  onDensityChange,
  view,
  onViewChange,
  filters,
  onFiltersChange,
}: {
  resultLabel: string
  sort: PortfolioSortOrder
  onSortChange: (sort: PortfolioSortOrder) => void
  density: number
  onDensityChange: (density: number) => void
  view: CollectionView
  onViewChange: (view: CollectionView) => void
  filters: PortfolioFilters
  onFiltersChange: (filters: PortfolioFilters) => void
}) {
  const [sortOpen, setSortOpen] = useState(false)
  const [densityOpen, setDensityOpen] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filterCount = activeFilterCount(filters)
  const ActiveViewIcon = VIEW_OPTIONS.find((v) => v.value === view)?.icon ?? GridIcon

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto text-sm text-slate-400">{resultLabel}</p>

      <ToolbarButton
        label={SORT_LABEL[sort]}
        icon={<SortIcon className="size-4" />}
        onClick={() => {
          setSortOpen(true)
        }}
      />
      <ToolbarButton
        label={DENSITY_OPTIONS.find((d) => d.value === density)?.label ?? 'Density'}
        icon={<DensityIcon className="size-4" />}
        onClick={() => {
          setDensityOpen(true)
        }}
        iconOnlyOnMobile
      />
      <ToolbarButton
        label={VIEW_OPTIONS.find((v) => v.value === view)?.label ?? 'View'}
        icon={<ActiveViewIcon className="size-4" />}
        onClick={() => {
          setViewOpen(true)
        }}
        iconOnlyOnMobile
      />
      <ToolbarButton
        label={filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
        icon={<FilterIcon className="size-4" />}
        onClick={() => {
          setFiltersOpen(true)
        }}
      />

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
              className={`min-h-11 rounded-lg px-3 text-left text-sm font-medium ${
                sort === option ? 'bg-sky-600/20 text-sky-200' : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              {SORT_LABEL[option]}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={densityOpen}
        onClose={() => {
          setDensityOpen(false)
        }}
        title="Density"
      >
        <div className="flex flex-col gap-1">
          {DENSITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={density === option.value}
              onClick={() => {
                onDensityChange(option.value)
                setDensityOpen(false)
              }}
              className={`flex min-h-11 flex-col rounded-lg px-3 py-1.5 text-left ${
                density === option.value
                  ? 'bg-sky-600/20 text-sky-200'
                  : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-xs text-slate-500">{option.hint}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={viewOpen}
        onClose={() => {
          setViewOpen(false)
        }}
        title="View"
      >
        <div className="flex flex-col gap-1">
          {VIEW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={view === option.value}
              onClick={() => {
                onViewChange(option.value)
                setViewOpen(false)
              }}
              className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium ${
                view === option.value
                  ? 'bg-sky-600/20 text-sky-200'
                  : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              <option.icon className="size-4" />
              {option.label}
            </button>
          ))}
        </div>
      </Sheet>

      <FiltersSheet
        key={filtersOpen ? 'filters-open' : 'filters-closed'}
        open={filtersOpen}
        onClose={() => {
          setFiltersOpen(false)
        }}
        filters={filters}
        onApply={onFiltersChange}
      />
    </div>
  )
}

function ToolbarButton({
  label,
  icon,
  onClick,
  iconOnlyOnMobile,
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  iconOnlyOnMobile?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-300 hover:bg-slate-800"
    >
      {icon}
      <span className={iconOnlyOnMobile ? 'hidden sm:inline' : undefined}>{label}</span>
    </button>
  )
}
