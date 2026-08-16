/**
 * Spending-side ledger metrics: GPO, CS, HS. FINANCIAL_MODEL.md §2.1.
 * Invariant F1: `GPO = CS + HS` for every user, at all times — true here by
 * construction, since CS and HS are disjoint partitions of the same line set.
 */
import { sum, type Money } from './money'
import type { CurrencyCode } from './currency'

export type SpendClass = 'collectible' | 'hobby'

export interface AttributedPurchaseLine {
  readonly spendClass: SpendClass
  /** line_total + allocated shipping + allocated customs − allocated discount. */
  readonly attributableCost: Money
}

/** Gross purchase outflow (GPO) — every krone spent, across both classes. */
export function grossPurchaseOutflow(
  currency: CurrencyCode,
  lines: readonly AttributedPurchaseLine[],
): Money {
  return sum(
    currency,
    lines.map((l) => l.attributableCost),
  )
}

/** Collectible spend (CS). */
export function collectibleSpend(
  currency: CurrencyCode,
  lines: readonly AttributedPurchaseLine[],
): Money {
  return sum(
    currency,
    lines.filter((l) => l.spendClass === 'collectible').map((l) => l.attributableCost),
  )
}

/** Hobby spend (HS). */
export function hobbySpend(
  currency: CurrencyCode,
  lines: readonly AttributedPurchaseLine[],
): Money {
  return sum(
    currency,
    lines.filter((l) => l.spendClass === 'hobby').map((l) => l.attributableCost),
  )
}
