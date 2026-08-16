/**
 * Total tracked economic position (TTEP), FINANCIAL_MODEL.md §2.6:
 * `CMV + NSP − CS`. The honest headline figure — unlike `URC + RRC`, it
 * does not silently omit spend on product whose contents have no individual
 * cost basis. Never sum this with an opening return (invariant F8); the two
 * are different scopes over the same krone.
 */
import { add, subtract, type Money } from './money'

export function totalTrackedEconomicPosition(cmv: Money, nsp: Money, cs: Money): Money {
  return subtract(add(cmv, nsp), cs)
}
