/**
 * Opening-scope analytics (FINANCIAL_MODEL.md §5). The opening OWNS the monetary cost of what
 * it consumed; pulled cards have no individual basis. Everything here is ANALYTICAL SCOPE over
 * kroner the purchase ledger already counted once — invariant F8: opening returns are never
 * additive with TTEP, and no dashboard surface may sum them.
 *
 * Pure functions only — components format numbers, they never compute them (AGENTS.md).
 */
import { add, subtract, type Money } from './money'

export type OpeningTracking = 'all_cards' | 'selected_pulls' | 'unknown'
export type OpeningCostSource = 'from_lot' | 'unknown'

export interface OpeningResultComponents {
  /** Current value of pulls from this opening still held (unpriced pulls excluded and counted). */
  readonly retainedTrackedValue: Money
  /** Net proceeds from sold pulls — the lot keeps its opening_id forever. */
  readonly netSoldProceeds: Money
  /** Owner-entered estimate for untracked leftovers; absent means "not supplied", not zero. */
  readonly bulkRemainderEstimate: Money | null
  /** Frozen consumed cost; null when unknown-cost (renders "—", never a 0-based result). */
  readonly openingCost: Money | null
}

/**
 * FINANCIAL_MODEL.md §5.3, verbatim:
 *   opening_return = retained_tracked_value + net_proceeds_from_sold_pulls
 *                  + bulk_remainder_estimate − opening_cost
 * Undefined when the opening cost is unknown — null here so no caller can render "0 kr result".
 */
export function computeOpeningReturn(components: OpeningResultComponents): Money | null {
  const { openingCost } = components
  if (openingCost === null) return null
  const inflow =
    components.bulkRemainderEstimate === null
      ? add(components.retainedTrackedValue, components.netSoldProceeds)
      : add(
          add(components.retainedTrackedValue, components.netSoldProceeds),
          components.bulkRemainderEstimate,
        )
  return subtract(inflow, openingCost)
}

/**
 * opening_roi = opening_return / opening_cost (§5.3), as percent rounded half-away-from-zero to
 * one decimal, computed entirely in exact bigint math before any Number conversion. Null
 * whenever either input is missing — an undefined ROI must stay undefined.
 */
export function openingRoiPercent(
  openingReturn: Money | null,
  openingCost: Money | null,
): number | null {
  if (openingReturn === null || openingCost === null) return null
  const cost = openingCost.minorUnits
  if (cost <= 0n) return null
  const scale = 1000n // one decimal of percent
  const product = openingReturn.minorUnits * scale
  const negative = product < 0n
  const magnitudeProduct = negative ? -product : product
  let whole = magnitudeProduct / cost
  const remainder = magnitudeProduct % cost
  if (remainder * 2n >= cost) whole += 1n
  return ((negative ? -1 : 1) * Number(whole)) / 10
}

/** §5.3 completeness flag: any non-all_cards tracking forces the incompleteness marker. */
export function isTrackingIncomplete(tracking: OpeningTracking): boolean {
  return tracking !== 'all_cards'
}

/**
 * The already-derived cost components of one openable sealed source lot (server-derived by
 * `list_opening_sources`, P53 §7). The client NEVER re-derives these from raw lot columns —
 * the SQL is the single place the consumption arithmetic lives outside the writer itself.
 *
 *   effectiveUnitBasis = unit_cost_basis_nok + floor(Σ adjustments / original quantity)
 *   exhaustionResidual = residual_nok + adjustment remainder of that same division
 *
 * Unknown-cost lots carry null for both components (`costKnown` false) — an unknown must never
 * become a computed zero (M1).
 */
export interface OpeningSourceCostShape {
  readonly quantityAvailable: number
  readonly effectiveUnitBasisNokMinor: bigint | null
  readonly exhaustionResidualNokMinor: bigint | null
}

/**
 * The exact preview of what opening `quantityOpened` units will freeze as the opening's cost —
 * byte-identical to what create_opening records:
 *
 *   q < quantity_available → effective_unit_basis × q
 *   q = quantity_available → effective_unit_basis × q + exhaustion_residual
 *
 * The residual lands ONLY on the opening that exhausts the lot, at most once in its lifetime
 * (FINANCIAL_MODEL §4.3 / D-060) — which is why the 29995 øre lot previews 19996 for 2 of 3 and
 * 9999 for the final unit, never 9998 followed by an inconsistent recorded figure.
 * Null when the cost is unknown (never a fabricated zero).
 */
export function computeOpeningCostPreview(
  source: OpeningSourceCostShape,
  quantityOpened: number,
): bigint | null {
  if (source.effectiveUnitBasisNokMinor === null || source.exhaustionResidualNokMinor === null) {
    return null
  }
  if (!Number.isInteger(quantityOpened) || quantityOpened < 1) {
    throw new Error('Opening quantity must be a positive integer')
  }
  const base = source.effectiveUnitBasisNokMinor * BigInt(quantityOpened)
  return quantityOpened >= source.quantityAvailable
    ? base + source.exhaustionResidualNokMinor
    : base
}
