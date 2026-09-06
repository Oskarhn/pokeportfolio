import type { CostBasisState, LotOrigin } from '../../data/collection'

/**
 * The origin → cost-basis-state mapping for direct card adds (FINANCIAL_MODEL.md §5.2/E12).
 * Extracted from AddToCollectionPage so the M15 scanner commits through the SAME financial
 * semantics instead of copying them (M15 prompt §26). `null` means "the user chooses known vs
 * unknown" — purchase/other are the origins where an amount may genuinely be entered.
 */

export function fixedCostBasisState(origin: LotOrigin): CostBasisState | null {
  switch (origin) {
    case 'opening':
      return 'unallocated_opening'
    case 'gift':
      return 'not_paid'
    case 'trade_in':
      return 'trade_in'
    case 'pre_tracking':
      return 'unknown'
    default:
      return null // purchase / other: the user chooses known vs unknown
  }
}

/** Whether a direct per-card cost is even askable for this origin — a pull or a gift never shows
 *  a cost field (FINANCIAL_MODEL.md §5.2/E12; M6 prompt §56). */
export function costIsApplicable(origin: LotOrigin): boolean {
  return origin === 'purchase' || origin === 'other'
}
