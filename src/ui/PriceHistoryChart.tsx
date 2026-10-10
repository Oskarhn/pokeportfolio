import { formatNokMinor } from './money-format'
import { valueChange } from '../domain/dashboard'
import type { PriceHistoryPoint } from '../data/pricing'

/**
 * Card Detail's real price-history chart (M9 prompt §52). A small, accessible inline SVG — not
 * M12's full investment-dashboard chart-library spike (D-015), just enough to show real data
 * honestly. Never interpolates or fabricates a point: `points` is exactly what
 * `get_card_variant_price_history` returned, and the three length cases below are the whole
 * honest range of what "history" can mean the day tracking starts.
 */
export function PriceHistoryChart({ points }: { points: PriceHistoryPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-xl border border-dashed border-slate-800 text-xs text-slate-500">
        No price history available yet
      </div>
    )
  }

  const [point] = points
  if (points.length === 1 && point) {
    return (
      <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-800 text-xs text-slate-500">
        <span className="text-sm font-medium text-slate-200">
          {formatNokMinor(point.valueNokMinor)} NOK
        </span>
        <span>Current reference only — not enough history for a trend yet</span>
      </div>
    )
  }

  // Plot geometry and the percentage label are NON-AUTHORITATIVE display values (D-137): `Number()`
  // of a bigint is the nearest double, which only matters to a pixel position or a "%" shown to
  // one decimal. Every amount on this component is formatted from the exact bigint.
  const values = points.map((p) => Number(p.valueNokMinor))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const width = 280
  const height = 64
  const stepX = points.length > 1 ? width / (points.length - 1) : 0

  const coords = points.map((p, i) => {
    const x = i * stepX
    const y = height - ((Number(p.valueNokMinor) - min) / range) * height
    return [x, y] as const
  })
  const path = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')

  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  const { changeMinor, pct: changePct } = valueChange(first.valueNokMinor, last.valueNokMinor)

  return (
    <div className="space-y-1.5 rounded-xl border border-slate-800 p-2">
      <svg
        viewBox={`0 -4 ${width} ${height + 8}`}
        className="h-20 w-full"
        role="img"
        aria-label={`Price history from ${first.snapshotDate} to ${last.snapshotDate}`}
      >
        <path d={path} fill="none" stroke="#38bdf8" strokeWidth={1.75} />
      </svg>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          {formatNokMinor(first.valueNokMinor)} → {formatNokMinor(last.valueNokMinor)} NOK
        </span>
        <span className={changeMinor >= 0n ? 'text-emerald-400' : 'text-rose-400'}>
          {changeMinor >= 0n ? '+' : ''}
          {formatNokMinor(changeMinor)} NOK
          {changePct !== null ? ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%)` : ''}
        </span>
      </div>
    </div>
  )
}
