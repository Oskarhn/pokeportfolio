import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../auth/useAuth'
import { getPortfolioCounts } from '../../data/portfolio'

/**
 * Home: the future financial-portfolio dashboard (M7 prompt §17-18/§89/§106). Only truthful,
 * currently-available data ships now — physical card count, unique holdings, graded and manual
 * counts, quick actions. The eventual investment-style value/chart panel is reserved and honestly
 * marked unavailable, never a fabricated number or a sample line graph — M12 owns the real
 * dashboard and the chart-library spike.
 */
export function HomePage() {
  const { email, isAdmin } = useAuth()
  const counts = useQuery({ queryKey: ['portfolio-counts'], queryFn: getPortfolioCounts })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Home</h1>
        <p className="text-sm text-slate-400">
          Signed in as <span className="text-slate-200">{email ?? '—'}</span>
          {isAdmin ? ' · administrator' : ''}
        </p>
      </header>

      {/* Reserved for the primary portfolio-value figure and an investment-style value-over-time
          chart once real pricing and portfolio snapshots exist (M9/M12). Honestly marked
          unavailable now — never a sample line, never a fabricated total. */}
      <section className="space-y-1 rounded-lg border border-dashed border-slate-800 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Portfolio value
        </p>
        <p className="text-3xl font-semibold tabular-nums text-slate-600">—</p>
        <p className="text-xs text-slate-500">
          Not available yet — market pricing and the value chart arrive in a later update.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <StatTile label="Physical cards" value={counts.data?.physicalCardCount} />
        <StatTile label="Unique holdings" value={counts.data?.uniqueHoldingCount} />
        <StatTile label="Graded" value={counts.data?.gradedCount} />
        <StatTile label="Manual entries" value={counts.data?.manualCount} />
      </section>

      <section className="flex gap-3">
        <Link
          to="/catalog"
          className="min-h-11 flex-1 rounded-lg border border-slate-700 px-4 py-2 text-center text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Search cards
        </Link>
        <Link
          to="/portfolio"
          className="min-h-11 flex-1 rounded-lg bg-sky-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-sky-500"
        >
          Open Portfolio
        </Link>
      </section>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-lg border border-slate-800 p-4">
      <p className="text-2xl font-semibold tabular-nums text-slate-100">
        {value === undefined ? '—' : value.toLocaleString('nb-NO')}
      </p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  )
}
