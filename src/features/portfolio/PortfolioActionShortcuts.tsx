import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { buildPortfolioCsv, downloadCsv } from '../../data/portfolioExport'
import type { PortfolioFilters } from '../../data/portfolio'
import { Sheet } from '../../ui/Sheet'
import { DownloadIcon, CheckIcon, ChartIcon, SwapIcon } from '../../ui/icons'

/**
 * The four Portfolio shortcuts the owner described (M7.1 prompt §46-49): Export and Bulk Actions
 * are real today; Market Movers is real as of M9.1 (its dependency, price history, shipped in M9)
 * — it must not stay a muted placeholder now that the milestone it was waiting on has landed
 * (M9.1 prompt §19). Trade Analyzer still needs real trade-value semantics (M18) and stays an
 * honest "not available yet" — muted styling plus an explicit message on tap, never a button that
 * silently does nothing (M7.1 prompt §46's own warning against letting the owner mistake it for a
 * working feature).
 *
 * The Export tile is deliberately RETAINED alongside the full M13 "Export & backup" screen
 * (D-081) because the two are different artifacts: this is the quick, filter-respecting CSV of
 * the CURRENT Portfolio view including derived current values (a report), while
 * Profile › Export & backup produces the canonical data suite and the versioned JSON backup.
 */
export function PortfolioActionShortcuts({
  filters,
  onEnterSelectMode,
}: {
  filters: PortfolioFilters
  onEnterSelectMode: () => void
}) {
  const navigate = useNavigate()
  const [futureNotice, setFutureNotice] = useState<'trade' | null>(null)
  const exportMutation = useMutation({
    mutationFn: async () => {
      const csv = await buildPortfolioCsv(filters)
      downloadCsv(csv, `portfolio-export-${new Date().toISOString().slice(0, 10)}.csv`)
    },
  })

  return (
    <div className="grid grid-cols-4 gap-2">
      <ShortcutTile
        icon={<DownloadIcon className="size-5" />}
        label={exportMutation.isPending ? 'Exporting…' : 'Quick CSV'}
        title="Quick CSV of your current filtered Portfolio view — full exports live under Profile › Export & backup"
        onClick={() => {
          exportMutation.mutate()
        }}
        disabled={exportMutation.isPending}
      />
      <ShortcutTile
        icon={<CheckIcon className="size-5" />}
        label="Bulk actions"
        onClick={onEnterSelectMode}
      />
      <ShortcutTile
        icon={<SwapIcon className="size-5" />}
        label="Trade analyzer"
        muted
        onClick={() => {
          setFutureNotice('trade')
        }}
      />
      <ShortcutTile
        icon={<ChartIcon className="size-5" />}
        label="Market movers"
        onClick={() => {
          void navigate({ to: '/market-movers' })
        }}
      />

      <Sheet
        open={futureNotice !== null}
        onClose={() => {
          setFutureNotice(null)
        }}
        title="Trade analyzer"
      >
        <p className="text-sm text-slate-300">
          Not available yet — trade analysis needs real trade-value semantics, which arrive with
          trades.
        </p>
      </Sheet>
    </div>
  )
}

function ShortcutTile({
  icon,
  label,
  title,
  onClick,
  disabled,
  muted,
}: {
  icon: React.ReactNode
  label: string
  title?: string
  onClick: () => void
  disabled?: boolean
  muted?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border p-2 text-center text-[11px] font-medium disabled:opacity-60 ${
        muted
          ? 'border-dashed border-slate-800 text-slate-500 hover:bg-slate-800/40'
          : 'border-slate-700 text-slate-200 hover:bg-slate-800'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
