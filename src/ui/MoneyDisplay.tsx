import { formatNokMinor } from './money-format'
import { EyeIcon, EyeOffIcon } from './icons'

/**
 * The value-display contract (M7.1 prompt §75): one component every future price surface (M9's
 * resolved raw-card value, M12's chart headline) wires a resolver into without a UI rewrite.
 *
 * States, never conflated:
 * - `known`   a real NOK amount exists (currently: a graded holding's manual valuation, the only
 *             real "value" in the app pre-M9 — DECISIONS.md D-041).
 * - `hidden`  a real amount exists but the value-privacy eye (Profile/Home) is on: "••••".
 * - `missing` no amount exists. Never zero (DESIGN_SYSTEM.md §7) — always "—".
 *
 * All money in this app is frozen to NOK until M9 (manual_valuations' currency check constraint).
 * The user's own display-currency preference is shown as a small suffix note, never as a
 * conversion — showing a converted number with no real FX behind it would be exactly the
 * fabrication DESIGN_SYSTEM.md §7 rules out.
 */
export function MoneyDisplay({
  state,
  minorUnits,
  hidden = false,
  size = 'md',
  displayCurrency,
}: {
  state: 'known' | 'missing'
  minorUnits?: bigint
  hidden?: boolean
  size?: 'lg' | 'md' | 'sm'
  displayCurrency?: string
}) {
  const sizeClass = {
    lg: 'text-3xl font-semibold tracking-tight',
    md: 'text-xl font-semibold tracking-tight',
    sm: 'text-sm font-medium',
  }[size]

  const showConversionNote =
    displayCurrency !== undefined && displayCurrency !== 'NOK' && state === 'known' && !hidden

  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`tabular-nums ${sizeClass}`}>
        {state === 'missing' ? (
          <span className="text-slate-500">—</span>
        ) : hidden ? (
          <span aria-label="Value hidden">••••</span>
        ) : (
          <>
            <span className="mr-1 text-[0.6em] font-normal text-slate-500 align-baseline">kr</span>
            {formatNokMinor(minorUnits ?? 0n)}
          </>
        )}
      </span>
      {showConversionNote ? (
        <span className="text-xs font-normal text-slate-500">
          NOK — {displayCurrency} shown once conversion exists
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
