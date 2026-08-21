const CURRENCIES = ['NOK', 'EUR', 'USD'] as const

/**
 * Home/Portfolio display-currency preference (M7.1 prompt §18). Persists `profiles.display_currency`
 * — already existed, unused until now. Selecting EUR/USD does not convert anything: every real
 * amount in the app is frozen to NOK until M9 has FX, so `MoneyDisplay` shows a "shown once
 * conversion exists" note rather than a fabricated number.
 */
export function CurrencySelector({
  value,
  onChange,
}: {
  value: string
  onChange: (currency: string) => void
}) {
  return (
    <select
      aria-label="Display currency"
      value={CURRENCIES.includes(value as (typeof CURRENCIES)[number]) ? value : 'NOK'}
      onChange={(event) => {
        onChange(event.target.value)
      }}
      className="min-h-9 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm font-medium text-slate-200 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
    >
      {CURRENCIES.map((code) => (
        <option key={code} value={code}>
          {code}
        </option>
      ))}
    </select>
  )
}
