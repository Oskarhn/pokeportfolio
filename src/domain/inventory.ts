/**
 * Portfolio-level inventory metrics: CMV, ACMV, UMV, URC, and the two counts
 * that keep absence visible instead of silently zeroed (UHC, ULC). See
 * FINANCIAL_MODEL.md §2.4–2.6.
 *
 * These functions deliberately do not offer a bare
 * `profit = marketValue - costBasis` helper. Every lot here forces the
 * caller to confront whether it has a resolvable value and a known cost
 * basis before a result figure exists at all — that is the point.
 */
import { multiplyByQuantity, subtract, sum, zero, type Money } from './money'
import type { CurrencyCode } from './currency'
import { isKnown, type CostBasisState } from './cost-basis'
import { hasResolvableValue, type MarketValue } from './market-value'

export interface InventoryLot {
  readonly quantityRemaining: bigint
  readonly costBasisState: CostBasisState
  readonly effectiveUnitCostBasis: Money | null
  readonly marketValue: MarketValue
}

export interface InventoryValueSummary {
  /** Current market value — CMV. Only lots with a resolvable value contribute. */
  readonly cmv: Money
  /** CMV restricted to lots with a known cost basis. */
  readonly acmv: Money
  /** CMV restricted to every other cost-basis state. */
  readonly umv: Money
  /** Unvalued holdings count — open lots with no resolvable value. */
  readonly uhc: number
  /** Uncosted lot count — open lots where the cost basis is not `known`. */
  readonly ulc: number
}

export function summarizeInventoryValue(
  currency: CurrencyCode,
  lots: readonly InventoryLot[],
): InventoryValueSummary {
  const valuedLots = lots.map((lot) => ({
    lot,
    lotValue: hasResolvableValue(lot.marketValue)
      ? multiplyByQuantity(lot.marketValue.value, lot.quantityRemaining)
      : null,
  }))

  const cmv = sum(
    currency,
    valuedLots.flatMap(({ lotValue }) => (lotValue ? [lotValue] : [])),
  )
  const acmv = sum(
    currency,
    valuedLots.flatMap(({ lot, lotValue }) =>
      lotValue && isKnown(lot.costBasisState) ? [lotValue] : [],
    ),
  )
  const umv = subtract(cmv, acmv)

  const uhc = valuedLots.filter(({ lotValue }) => lotValue === null).length
  const ulc = lots.filter((lot) => !isKnown(lot.costBasisState)).length

  return { cmv, acmv, umv, uhc, ulc }
}

/**
 * Direct cost basis of inventory (DCB) restricted to the same scope as ACMV
 * — open lots with a known cost basis — so URC (§2.6) compares like with
 * like.
 */
export function directCostBasisOfKnownLots(
  currency: CurrencyCode,
  lots: readonly InventoryLot[],
): Money {
  const knownLotCosts = lots
    .filter((lot) => isKnown(lot.costBasisState) && lot.effectiveUnitCostBasis !== null)
    .map((lot) =>
      multiplyByQuantity(lot.effectiveUnitCostBasis ?? zero(currency), lot.quantityRemaining),
    )
  return sum(currency, knownLotCosts)
}

/** Unrealized result on costed inventory (URC) = ACMV − DCB. */
export function unrealizedResultOnCostedInventory(acmv: Money, dcb: Money): Money {
  return subtract(acmv, dcb)
}
