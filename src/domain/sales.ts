/**
 * Disposal-side ledger metrics: RRC and PUD. FINANCIAL_MODEL.md §2.6.
 * A sale line with no cost basis produces proceeds, never a fabricated
 * result — its `costBasisAtSale` is `null`, and PUD (not RRC) is where its
 * money is counted. Invariant F5 ties the two paths back together.
 */
import { allocate } from './allocation'
import { add, subtract, sum, type Money } from './money'
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

/**
 * FIFO tie-break, deterministic (prompt §12/UX_FLOWS.md F7): oldest `acquiredOn` first, then
 * lowest `createdAt` (two lots acquired the same calendar day sort by real insertion order), then
 * `id` as a final deterministic tie-break so the suggestion never depends on query/array order.
 *
 * This is a *suggestion* only — src/domain/sales.ts never chooses a lot for the caller. The sale
 * builder pre-selects this order and marks it "Suggested: oldest acquired first"; the user can
 * change it before saving, and create_sale never substitutes its own choice (prompt §10-11).
 */
export interface FifoCandidateLot {
  readonly id: string
  readonly acquiredOn: string
  readonly createdAt: string
}

export function suggestFifoOrder<T extends FifoCandidateLot>(lots: readonly T[]): T[] {
  return [...lots].sort((a, b) => {
    if (a.acquiredOn !== b.acquiredOn) return a.acquiredOn < b.acquiredOn ? -1 : 1
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Per-line net proceeds, FINANCIAL_MODEL.md §4.5/prompt §43:
 * line_net = line_gross − allocated_fees − allocated_outbound_shipping + allocated_buyer_shipping.
 * Used by the sale builder's live preview — the same formula create_sale's SQL enforces via a
 * CHECK constraint on sale_lines (sale_lines_net_proceeds_formula).
 */
export function saleLineNetProceeds(
  lineGross: Money,
  allocatedFees: Money,
  allocatedShipping: Money,
  allocatedShippingCharged: Money,
): Money {
  return add(
    subtract(subtract(lineGross, allocatedFees), allocatedShipping),
    allocatedShippingCharged,
  )
}

export interface SalePreviewInput {
  /** One entry per sold lot: the unit sale price in minor units and the integer quantity. */
  readonly lines: readonly { readonly unitGrossMinor: bigint; readonly quantity: number }[]
  readonly feesMinor: bigint
  readonly shippingCostMinor: bigint
  readonly shippingChargedMinor: bigint
}

export interface SalePreview {
  readonly lineGross: bigint[]
  readonly grossMinor: bigint
  readonly feesMinor: bigint
  readonly shippingCostMinor: bigint
  readonly shippingChargedMinor: bigint
  /** The same amounts with the sign they carry in the net: fees and shipping cost are deductions. */
  readonly feesDeductionMinor: bigint
  readonly shippingCostDeductionMinor: bigint
  readonly netMinor: bigint
  /** Per line: gross − allocated fees − allocated shipping + allocated buyer shipping. */
  readonly lineNet: bigint[]
}

/**
 * The sale builder's and the sale editor's live preview, in the sale's own currency: the same
 * arithmetic create_sale freezes (FINANCIAL_MODEL.md §4.5). Sale-level charges are allocated across
 * the lines by line gross with the largest-remainder rule (§4.2), so Σ line net = net exactly.
 * Components format these numbers; they never compute them.
 */
export function previewSale(input: SalePreviewInput): SalePreview {
  const lineGross = input.lines.map((l) => l.unitGrossMinor * BigInt(l.quantity))
  const grossMinor = lineGross.reduce((a, b) => a + b, 0n)
  const allocFees = allocate(input.feesMinor, lineGross)
  const allocShip = allocate(input.shippingCostMinor, lineGross)
  const allocCharged = allocate(input.shippingChargedMinor, lineGross)
  const lineNet = lineGross.map(
    (g, i) => g - (allocFees[i] ?? 0n) - (allocShip[i] ?? 0n) + (allocCharged[i] ?? 0n),
  )
  return {
    lineGross,
    grossMinor,
    feesMinor: input.feesMinor,
    shippingCostMinor: input.shippingCostMinor,
    shippingChargedMinor: input.shippingChargedMinor,
    feesDeductionMinor: -input.feesMinor,
    shippingCostDeductionMinor: -input.shippingCostMinor,
    netMinor: grossMinor - input.feesMinor - input.shippingCostMinor + input.shippingChargedMinor,
    lineNet,
  }
}
