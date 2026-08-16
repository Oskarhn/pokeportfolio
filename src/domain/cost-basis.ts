/**
 * Cost basis as a state, not a nullable number. See FINANCIAL_MODEL.md §1.1
 * and invariant M2: `unit_cost_basis_minor IS NOT NULL` iff the state is
 * `known`. Encoding the five states as a discriminated union makes that
 * invariant a property of the type system rather than a rule someone has to
 * remember to enforce — a lot in any other state cannot even hold an amount.
 */
import { add, fromMinorUnits, sum, type Money } from './money'
import type { CurrencyCode } from './currency'

export type CostBasisState =
  | { readonly kind: 'known'; readonly unitCostBasis: Money }
  | { readonly kind: 'unallocated_opening' }
  | { readonly kind: 'not_paid' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'trade_in' }

export function isKnown(
  state: CostBasisState,
): state is { readonly kind: 'known'; readonly unitCostBasis: Money } {
  return state.kind === 'known'
}

/** A later cost attributable to a specific lot — e.g. a grading fee. */
export interface LotCostAdjustment {
  readonly kind: 'grading_fee' | 'grading_shipping'
  readonly amount: Money
}

/**
 * Effective unit cost basis (EUCB), FINANCIAL_MODEL.md §2.5:
 * `unit_cost_basis + (Σ adjustments ÷ original lot quantity)`. Returns
 * `null` when the lot has no direct cost basis — adjustments never manufacture
 * one, per invariant F7 (every adjustment traces to a real purchase line, it
 * does not change *whether* the lot has a basis).
 */
export function effectiveUnitCostBasis(
  state: CostBasisState,
  adjustments: readonly LotCostAdjustment[],
  originalLotQuantity: bigint,
): Money | null {
  if (!isKnown(state)) {
    return null
  }
  if (adjustments.length === 0) {
    return state.unitCostBasis
  }
  const currency = state.unitCostBasis.currency
  const totalAdjustments = sum(
    currency,
    adjustments.map((a) => a.amount),
  )
  const perUnitAdjustment = divideEvenlyDroppingRemainder(totalAdjustments, originalLotQuantity)
  return add(state.unitCostBasis, perUnitAdjustment)
}

function divideEvenlyDroppingRemainder(amount: Money, quantity: bigint): Money {
  if (quantity <= 0n) {
    return fromMinorUnits(0n, amount.currency)
  }
  return fromMinorUnits(amount.minorUnits / quantity, amount.currency)
}

/**
 * Direct cost basis of inventory (DCB), FINANCIAL_MODEL.md §2.5: sum over
 * open lots of `quantityRemaining × EUCB`, skipping lots with no basis.
 */
export interface CostedLot {
  readonly quantityRemaining: bigint
  readonly effectiveUnitCostBasis: Money | null
}

export function directCostBasisOfInventory(
  currency: CurrencyCode,
  lots: readonly CostedLot[],
): Money {
  const knownLotCosts = lots
    .filter(
      (lot): lot is CostedLot & { effectiveUnitCostBasis: Money } =>
        lot.effectiveUnitCostBasis !== null,
    )
    .map((lot) =>
      fromMinorUnits(lot.effectiveUnitCostBasis.minorUnits * lot.quantityRemaining, currency),
    )
  return sum(currency, knownLotCosts)
}
