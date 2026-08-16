/**
 * Disposal-side ledger metrics: RRC and PUD. FINANCIAL_MODEL.md §2.6.
 * A sale line with no cost basis produces proceeds, never a fabricated
 * result — its `costBasisAtSale` is `null`, and PUD (not RRC) is where its
 * money is counted. Invariant F5 ties the two paths back together.
 */
import { subtract, sum, type Money } from './money'
import type { CurrencyCode } from './currency'

export interface SaleLine {
  /** Frozen at the moment of sale; null when the disposed lot had no cost basis. */
  readonly costBasisAtSale: Money | null
  readonly allocatedNetProceeds: Money
}

export function isCosted(line: SaleLine): line is SaleLine & { costBasisAtSale: Money } {
  return line.costBasisAtSale !== null
}

/** Realized result on costed disposals (RRC) = Σ (net proceeds − cost basis). */
export function realizedResultOnCostedDisposals(
  currency: CurrencyCode,
  lines: readonly SaleLine[],
): Money {
  const results = lines
    .filter(isCosted)
    .map((line) => subtract(line.allocatedNetProceeds, line.costBasisAtSale))
  return sum(currency, results)
}

/** Proceeds from uncosted disposals (PUD) — a pure inflow, not a gain. */
export function proceedsFromUncostedDisposals(
  currency: CurrencyCode,
  lines: readonly SaleLine[],
): Money {
  return sum(
    currency,
    lines.filter((line) => !isCosted(line)).map((line) => line.allocatedNetProceeds),
  )
}

/** Net sales proceeds (NSP) across every sale line, costed or not. */
export function netSalesProceeds(currency: CurrencyCode, lines: readonly SaleLine[]): Money {
  return sum(
    currency,
    lines.map((line) => line.allocatedNetProceeds),
  )
}
