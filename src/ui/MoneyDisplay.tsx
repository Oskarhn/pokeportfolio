import { useQuery } from '@tanstack/react-query'
import { getLatestFxRatesToNok } from '../data/fx'
import { convertNokToDisplayCurrency } from '../domain/fx'
import { formatCurrencyMinor, formatNokMinor } from './money-format'
import { EyeIcon, EyeOffIcon } from './icons'

/**
 * The value-display contract (M7.1 prompt §75): one component every price surface (M9's resolved
 * raw-card value, M12's chart headline) wires a resolver into without a UI rewrite.
 *
 * States, never conflated:
 * - `known`   a real NOK amount exists.
 * - `hidden`  a real amount exists but the value-privacy eye (Profile/Home) is on: "••••".
 * - `missing` no amount exists. Never zero (DESIGN_SYSTEM.md §7) — always "—".
 *
 * Canonical storage stays NOK everywhere (FINANCIAL_MODEL.md §7). M9.1 (prompt §9-10) makes the
 * user's display-currency preference a real, presentation-only conversion: when a cached EUR/NOK
 * or USD/NOK rate exists, the converted amount becomes the primary figure and NOK is the small
 * secondary note — otherwise this falls back to NOK-only rather than fabricate a number, exactly
 * DESIGN_SYSTEM.md §7's rule. The conversion never mutates anything; `price_snapshots`, purchase
 * FX and cost basis are read once by their own callers and never touched here.
 */
export function MoneyDisplay({
  state,
  minorUnits,
  hidden = false,
  size = 'md',
  displayCurrency,
  stale = false,
}: {
  state: 'known' | 'missing'
  minorUnits?: bigint
  hidden?: boolean
  size?: 'lg' | 'md' | 'sm'
  displayCurrency?: string
  /** M9: the resolved value is real but the underlying snapshot is 4-30 days old
   *  (FINANCIAL_MODEL.md §6) — shown as a subtle marker, never hidden or treated as missing. */
  stale?: boolean
}) {
  const sizeClass = {
    lg: 'text-3xl font-semibold tracking-tight',
    md: 'text-xl font-semibold tracking-tight',
    sm: 'text-sm font-medium',
  }[size]

  const targetCurrency: 'EUR' | 'USD' | undefined =
    displayCurrency === 'EUR' || displayCurrency === 'USD' ? displayCurrency : undefined
  const rates = useQuery({
    queryKey: ['fx-rates-latest'],
    queryFn: getLatestFxRatesToNok,
    enabled: targetCurrency !== undefined && state === 'known' && !hidden,
    staleTime: 60 * 60 * 1000, // FX updates at most daily (ingest-fx) — an hour of staleness is fine
  })
  const rateToNok = targetCurrency ? rates.data?.[targetCurrency] : undefined
  const converted =
    targetCurrency && rateToNok && minorUnits !== undefined
      ? convertNokToDisplayCurrency(minorUnits, targetCurrency, rateToNok)
      : null

  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`tabular-nums ${sizeClass}`}>
        {state === 'missing' ? (
          <span className="text-slate-500">—</span>
        ) : hidden ? (
          <span aria-label="Value hidden">••••</span>
        ) : converted ? (
          formatCurrencyMinor(converted.minorUnits, converted.currency)
        ) : (
          <>
            <span className="mr-1 text-[0.6em] font-normal text-slate-500 align-baseline">kr</span>
            {formatNokMinor(minorUnits ?? 0n)}
          </>
        )}
      </span>
      {converted && !hidden ? (
        <span className="text-xs font-normal text-slate-500">
          kr {formatNokMinor(minorUnits ?? 0n)}
        </span>
      ) : targetCurrency && state === 'known' && !hidden ? (
        <span className="text-xs font-normal text-slate-500">
          NOK — {displayCurrency} rate not available yet
        </span>
      ) : null}
      {state === 'known' && stale && !hidden ? (
        <span
          className="rounded-full border border-slate-600 bg-slate-800/60 px-1.5 py-0.5 text-[10px] font-medium text-slate-200"
          title="This price hasn't refreshed in a few days — still used, just not brand new."
        >
          stale
        </span>
      ) : null}
    </span>
  )
}

/** The reusable eye control (M7.1 prompt §19). Toggles `hideValues` wherever a monetary figure is
 *  shown; the same preference persists to the profile so it applies consistently across Home and
 *  Portfolio. */
export function ValuePrivacyToggle({
  hidden,
  onToggle,
  className = '',
}: {
  hidden: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={hidden}
      aria-label={hidden ? 'Show values' : 'Hide values'}
      className={`flex size-9 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-slate-200 ${className}`}
    >
      {hidden ? <EyeOffIcon className="size-5" /> : <EyeIcon className="size-5" />}
    </button>
  )
}
