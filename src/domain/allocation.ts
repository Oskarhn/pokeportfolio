/**
 * Largest-remainder allocation. Splits a total across a set of non-negative
 * weights so the parts sum exactly to the total — no lost or invented minor
 * unit. See FINANCIAL_MODEL.md §4.2, invariant F6.
 *
 * If every weight is zero, the total is distributed equally, matching the
 * "purchase consisting only of shipping" edge case in §4.1. Ties in the
 * remainder ranking go to the lowest index — deterministic regardless of
 * input order or runtime.
 */
import { AllocationError } from './errors'
import { add, fromMinorUnits, type Money } from './money'
import type { CurrencyCode } from './currency'

/**
 * Pure bigint allocator. `weights` must be non-negative; `total` must be
 * non-negative. Returns one share per weight, in the same order, summing
 * exactly to `total`.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new AllocationError('Cannot allocate across zero weights')
  }
  if (total < 0n) {
    throw new AllocationError('Cannot allocate a negative total')
  }
  if (weights.some((w) => w < 0n)) {
    throw new AllocationError('Allocation weights must be non-negative')
  }

  const sumOfWeights = weights.reduce((acc, w) => acc + w, 0n)
  const effectiveWeights = sumOfWeights === 0n ? weights.map(() => 1n) : weights
  const effectiveSum = sumOfWeights === 0n ? BigInt(weights.length) : sumOfWeights

  const floors: bigint[] = []
  const remainders: bigint[] = []
  let sumOfFloors = 0n

  for (const weight of effectiveWeights) {
    const numerator = total * weight
    const floor = numerator / effectiveSum
    const remainder = numerator % effectiveSum
    floors.push(floor)
    remainders.push(remainder)
    sumOfFloors += floor
  }

  const remainingUnits = total - sumOfFloors

  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => {
      if (a.remainder !== b.remainder) {
        return a.remainder > b.remainder ? -1 : 1
      }
      return a.index - b.index
    })

  const shares = [...floors]
  for (let i = 0; i < remainingUnits; i++) {
    const winner = order[i]
    if (!winner) {
      throw new AllocationError('Largest-remainder distribution ran out of candidates')
    }
    shares[winner.index] = (shares[winner.index] ?? 0n) + 1n
  }

  return shares
}

/**
 * Money-aware convenience wrapper. Allocates `total` across `weights`
 * (arbitrary non-negative bigint weights, e.g. line totals in minor units)
 * and returns Money in the same currency as `total`.
 */
export function allocateMoney(total: Money, weights: readonly bigint[]): Money[] {
  const shares = allocate(total.minorUnits, weights)
  return shares.map((share) => fromMinorUnits(share, total.currency))
}

/**
 * Signed variant of `allocate` — the total may be negative (a sale can
 * genuinely net a loss, FINANCIAL_MODEL.md §2.2/prompt §109), while weights
 * must still be non-negative. Delegates to `allocate` on the magnitude and
 * negates the result: `allocateSigned(-T, w) === allocate(T, w).map(-)`.
 * Mirrors the SQL port `allocate_largest_remainder_signed`
 * (20260828120010_m10_sales_rpc.sql) — see tests/db for the parity proof.
 */
export function allocateSigned(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total >= 0n) {
    return allocate(total, weights)
  }
  return allocate(-total, weights).map((share) => -share)
}

/**
 * A purchase discount, allocated per line (FINANCIAL_MODEL.md §4.1, D-135). The TypeScript twin of
 * the SQL `allocate_purchase_discount` — tests/db/p144_financial_boundary.test.ts proves the two
 * agree on generated receipts.
 *
 * Two tiers, both the exact largest-remainder `allocate`:
 *   1. the goods tier, `min(discount, subtotal)`, by line total — the documented rule;
 *   2. the charge tier, the part of the discount that exceeds the goods, by each line's already
 *      allocated shipping + customs.
 *
 * For any non-negative integer weights `w` with sum `W` and `0 <= T <= W`, `allocate(T, w)[i] <=
 * w[i]`; applied to each tier this gives `discount[i] <= lineTotal[i] + shipping[i] + customs[i]`,
 * so no line's attributable cost is ever negative, and `Σ discount[i] === discount` exactly. When
 * the discount does not exceed the subtotal the second tier is empty and the result equals plain
 * `allocate(discount, lineTotals)`. A discount larger than subtotal + shipping + customs cannot be
 * allocated (it would make the receipt total negative) and throws — it is never clipped.
 */
export function allocatePurchaseDiscount(
  discount: bigint,
  lineTotals: readonly bigint[],
  allocatedShipping: readonly bigint[],
  allocatedCustoms: readonly bigint[],
): bigint[] {
  if (lineTotals.length === 0) {
    throw new AllocationError('Cannot allocate across zero weights')
  }
  if (
    allocatedShipping.length !== lineTotals.length ||
    allocatedCustoms.length !== lineTotals.length
  ) {
    throw new AllocationError('Line totals, shipping and customs must have the same length')
  }
  if (discount < 0n) {
    throw new AllocationError('Cannot allocate a negative total')
  }

  const chargeWeights = lineTotals.map(
    (_, i) => (allocatedShipping[i] ?? 0n) + (allocatedCustoms[i] ?? 0n),
  )
  const subtotal = lineTotals.reduce((acc, w) => acc + w, 0n)
  const charges = chargeWeights.reduce((acc, w) => acc + w, 0n)
  if (discount > subtotal + charges) {
    throw new AllocationError(
      'Discount cannot exceed the purchase subtotal plus shipping and customs',
    )
  }

  const goodsDiscount = discount < subtotal ? discount : subtotal
  const goodsShares = allocate(goodsDiscount, lineTotals)
  const chargeShares = allocate(discount - goodsDiscount, chargeWeights)
  return goodsShares.map((share, i) => share + (chargeShares[i] ?? 0n))
}

export interface PurchaseChargeAllocation {
  readonly shipping: bigint[]
  readonly customs: bigint[]
  readonly discount: bigint[]
  /** line total + shipping + customs − discount, per line; never negative. */
  readonly attributable: bigint[]
}

/**
 * Shipping, customs and discount for every line of one purchase (FINANCIAL_MODEL.md §4.1): the
 * single source of the allocation the record/edit forms preview. Shipping and customs go by line
 * total; the discount goes through {@link allocatePurchaseDiscount}. Throws the same
 * `AllocationError` the SQL raises for a discount larger than the whole receipt.
 */
export function allocatePurchaseCharges(
  lineTotals: readonly bigint[],
  shipping: bigint,
  customs: bigint,
  discount: bigint,
): PurchaseChargeAllocation {
  const allocatedShipping = allocate(shipping, lineTotals)
  const allocatedCustoms = allocate(customs, lineTotals)
  const allocatedDiscount = allocatePurchaseDiscount(
    discount,
    lineTotals,
    allocatedShipping,
    allocatedCustoms,
  )
  return {
    shipping: allocatedShipping,
    customs: allocatedCustoms,
    discount: allocatedDiscount,
    attributable: lineTotals.map(
      (lineTotal, i) =>
        lineTotal +
        (allocatedShipping[i] ?? 0n) +
        (allocatedCustoms[i] ?? 0n) -
        (allocatedDiscount[i] ?? 0n),
    ),
  }
}

/** Sums a set of allocated Money shares back to the original total. */
export function sumShares(currency: CurrencyCode, shares: readonly Money[]): Money {
  return shares.reduce((acc, share) => add(acc, share), fromMinorUnits(0n, currency))
}
