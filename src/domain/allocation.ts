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

/** Sums a set of allocated Money shares back to the original total. */
export function sumShares(currency: CurrencyCode, shares: readonly Money[]): Money {
  return shares.reduce((acc, share) => add(acc, share), fromMinorUnits(0n, currency))
}
