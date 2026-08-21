import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { buildPortfolioCsv, downloadCsv } from '../../data/portfolioExport'
import type { PortfolioFilters } from '../../data/portfolio'
import { Sheet } from '../../ui/Sheet'
import { DownloadIcon, CheckIcon, ChartIcon, SwapIcon } from '../../ui/icons'

/**
 * The four Portfolio shortcuts the owner described (M7.1 prompt §46-49): Export and Bulk Actions
 * are real today; Trade Analyzer (needs real trade-value semantics, M9/M18) and Market Movers
 * (needs price history, M9) are architected here but honestly unavailable — muted styling plus an
 * explicit message on tap, never a button that silently does nothing (M7.1 prompt §46's own
 * warning against letting the owner mistake them for working features).
 */
export function PortfolioActionShortcuts({
  filters,
  onEnterSelectMode,
}: {
  filters: PortfolioFilters
  onEnterSelectMode: () => void
}) {
  const [futureNotice, setFutureNotice] = useState<'trade' | 'movers' | null>(null)
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
        label={exportMutation.isPending ? 'Exporting…' : 'Export'}
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
        muted
        onClick={() => {
          setFutureNotice('movers')
        }}
      />

      <Sheet
        open={futureNotice !== null}
        onClose={() => {
          setFutureNotice(null)
        }}
        title={futureNotice === 'trade' ? 'Trade analyzer' : 'Market movers'}
      >
        <p className="text-sm text-slate-300">
          {futureNotice === 'trade'
            ? 'Not available yet — trade analysis needs real card values, which arrive with market pricing.'
            : 'Not available yet — ranking cards by price movement needs price history, which arrives with market pricing.'}
        </p>
      </Sheet>
    </div>
  )
}

function ShortcutTile({
  icon,
  label,
  onClick,
  disabled,
  muted,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  muted?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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
