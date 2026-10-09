import type { ReactNode } from 'react'

/**
 * The textual alternative for a price that is not a fresh market price (FINANCIAL_MODEL.md
 * section 6). A coloured dot or a bare middle dot carries no information for a screen reader or
 * for anyone who cannot tell the shade apart, and a `title` attribute is not announced on touch.
 *
 * - `stale`   the value is real but 4-30 days old: a visible dot plus text that says so.
 * - `missing` there is no price: the visible em dash plus text that says it is absent, never
 *             "0" (absence is not zero).
 * - `fresh` / `manual` carry no mark.
 */
export function PriceStateMark({
  state,
}: {
  state: 'manual' | 'fresh' | 'stale' | 'missing'
}): ReactNode {
  if (state === 'stale') {
    return (
      <>
        <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-slate-400" />
        <span className="sr-only">Price is 4–30 days old</span>
      </>
    )
  }
  if (state === 'missing') {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">No price available</span>
      </>
    )
  }
  return null
}
