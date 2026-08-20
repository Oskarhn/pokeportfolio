import { describe, expect, it } from 'vitest'
import { parseMinorUnits, serializeMinorUnits } from '../../src/data/money'

describe('money boundary mapping (pure round-trip)', () => {
  it('parses a decimal string to an exact bigint', () => {
    expect(parseMinorUnits('69900')).toBe(69_900n)
  })

  it('round-trips a value beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const huge = '9007199254740993' // 2^53 + 1 — not exactly representable as a JS number
    expect(parseMinorUnits(huge)).toBe(9_007_199_254_740_993n)
    expect(serializeMinorUnits(parseMinorUnits(huge))).toBe(huge)
  })

  it('serializes a bigint to its decimal string form', () => {
    expect(serializeMinorUnits(69_900n)).toBe('69900')
  })
})
