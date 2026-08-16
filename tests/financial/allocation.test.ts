import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { allocate } from '../../src/domain/allocation'
import { AllocationError } from '../../src/domain/errors'

describe('allocate — largest remainder', () => {
  it('two equal lines split an odd total 51/49-ish with the earlier line winning the tie', () => {
    // 101 across weights [1, 1]: exact share is 50.5 each: remainder ties,
    // lowest index wins the extra unit.
    expect(allocate(101n, [1n, 1n])).toEqual([51n, 50n])
  })

  it('three unequal lines (worked example E3 shipping allocation)', () => {
    // Shipping 10000 øre across line totals [700, 500, 100] (ETB, card, sleeves).
    expect(allocate(10000n, [700n, 500n, 100n])).toEqual([5385n, 3846n, 769n])
  })

  it('very small total distributes single units to the largest remainders', () => {
    expect(allocate(1n, [1n, 1n, 1n])).toEqual([1n, 0n, 0n])
  })

  it('rounding ties break toward the lowest index, deterministically', () => {
    const result = allocate(10n, [1n, 1n, 1n, 1n])
    expect(result).toEqual([3n, 3n, 2n, 2n])
    // Repeated calls are identical — no reliance on unstable sort or Map order.
    expect(allocate(10n, [1n, 1n, 1n, 1n])).toEqual(result)
  })

  it('zero shared cost allocates zero to every line', () => {
    expect(allocate(0n, [700n, 500n, 100n])).toEqual([0n, 0n, 0n])
  })

  it('one line receives the entire total', () => {
    expect(allocate(999n, [1n])).toEqual([999n])
  })

  it('many lines: sum always equals the total', () => {
    const weights = Array.from({ length: 137 }, (_, i) => BigInt((i % 13) + 1))
    const result = allocate(100_000n, weights)
    expect(result.reduce((a, b) => a + b, 0n)).toBe(100_000n)
  })

  it('large values stay exact', () => {
    const total = 999_999_999_999n
    const result = allocate(total, [1n, 2n, 3n])
    expect(result.reduce((a, b) => a + b, 0n)).toBe(total)
  })

  it('rejects a negative weight', () => {
    expect(() => allocate(100n, [1n, -1n])).toThrow(AllocationError)
  })

  it('rejects a negative total', () => {
    expect(() => allocate(-1n, [1n])).toThrow(AllocationError)
  })

  it('rejects an empty weight list', () => {
    expect(() => allocate(100n, [])).toThrow(AllocationError)
  })

  it('all-zero weights fall back to an equal split (purchase of only shipping)', () => {
    expect(allocate(100n, [0n, 0n])).toEqual([50n, 50n])
  })

  it('a zero-weight line receives nothing when other lines carry weight', () => {
    expect(allocate(100n, [0n, 100n])).toEqual([0n, 100n])
  })

  it('is deterministic for identical input regardless of call order', () => {
    const a = allocate(1234n, [3n, 1n, 4n, 1n, 5n, 9n])
    const b = allocate(1234n, [3n, 1n, 4n, 1n, 5n, 9n])
    expect(a).toEqual(b)
  })
})

describe('allocate — property tests (invariant F6)', () => {
  const weightsArb = fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), {
    minLength: 1,
    maxLength: 50,
  })
  const totalArb = fc.bigInt({ min: 0n, max: 1_000_000_000n })

  it('the shares always sum exactly to the total', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        const shares = allocate(total, weights)
        const sum = shares.reduce((a, b) => a + b, 0n)
        expect(sum).toBe(total)
      }),
    )
  })

  it('produces one share per weight', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        const shares = allocate(total, weights)
        expect(shares).toHaveLength(weights.length)
      }),
    )
  })

  it('every share is non-negative', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        const shares = allocate(total, weights)
        expect(shares.every((s) => s >= 0n)).toBe(true)
      }),
    )
  })

  it('is deterministic for identical input', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        const first = allocate(total, weights)
        const second = allocate(total, weights)
        expect(second).toEqual(first)
      }),
    )
  })

  it('a single weight receives the entire total', () => {
    fc.assert(
      fc.property(totalArb, (total) => {
        expect(allocate(total, [1n])).toEqual([total])
      }),
    )
  })
})
