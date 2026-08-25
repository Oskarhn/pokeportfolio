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
