import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { validateBackupEnvelope } from '../../src/domain/export/backup-validate'
import { buildBackupEnvelope, serializeBackupEnvelope } from '../../src/domain/export/build-backup'
import { FIXED_EXPORTED_AT, fixtureSnapshot } from './export-fixtures'

/**
 * P114 §15 — corruption/hostility fuzz for the backup-envelope structural validator. The
 * hand-written cases in export-backup-envelope.test.ts already pin specific corruption shapes
 * (wrong version, inflated counts, unknown keys, ...); this file instead throws a wide,
 * randomized battery of hostile JSON shapes at `validateBackupEnvelope` to catch what a fixed set
 * of examples cannot: a crash, a hang, or (worse) an accidental `valid: true` on garbage. The
 * validator's own contract is "fail closed with a structural failure, never throw" — every case
 * here checks exactly that, never anything about *which* failure path is taken.
 */

function goodEnvelope(): unknown {
  return JSON.parse(
    serializeBackupEnvelope(
      buildBackupEnvelope(fixtureSnapshot(), { exportedAt: FIXED_EXPORTED_AT, appVersion: 'test' }),
    ),
  )
}

function expectFailsClosedNeverThrows(input: unknown): void {
  let result
  expect(() => {
    result = validateBackupEnvelope(input)
  }).not.toThrow()
  expect(result).toBeDefined()
  // @ts-expect-error narrowed by the assertion above
  expect(typeof result.valid).toBe('boolean')
}

describe('backup envelope validator — hostile/corrupted top-level shapes never throw or hang', () => {
  const hostileTopLevel: readonly unknown[] = [
    null,
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    '',
    'not json shaped at all',
    [],
    [1, 2, 3],
    [{ format: 'pokeportfolio-backup' }], // array instead of object (§15)
    true,
    false,
    () => {
      /* functions never survive JSON.parse, but a hostile caller could still pass one */
    },
    new Date(),
    new Map(),
    new Set(),
  ]

  it.each(hostileTopLevel.map((v, i) => [i, v] as const))(
    'case %i: fails closed without throwing',
    (_i, input) => {
      expectFailsClosedNeverThrows(input)
      expect(validateBackupEnvelope(input).valid).toBe(false)
    },
  )

  it('prototype-pollution-shaped keys at every level are inert and fail closed', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const pollutionKeys = ['__proto__', 'constructor', 'prototype']
    for (const key of pollutionKeys) {
      // JSON.parse itself never creates a real prototype link for "__proto__" as an own key
      // (it becomes an ordinary own property), but a hostile caller could still hand the
      // validator an object built with Object.defineProperty or similar. Simulate that shape
      // via defineProperty so the key genuinely exists as an own enumerable property.
      const polluted: Record<string, unknown> = { ...base }
      Object.defineProperty(polluted, key, {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
      })
      const result = validateBackupEnvelope(polluted)
      expect(result.valid).toBe(false)
      // The prototype of Object.prototype itself must be untouched.
      expect(Object.getPrototypeOf(Object.prototype)).toBeNull()
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    }
  })

  it('a data section containing prototype-pollution-shaped row keys is inert and structurally rejected or accepted on its own declared merits only', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const data = base['data'] as Record<string, unknown>
    const rowWithPollutionKey = { __proto__: { polluted: true }, id: 'x' }
    const mutatedData = { ...data, tags: [rowWithPollutionKey] }
    const mutatedCounts = {
      ...(base['counts'] as Record<string, number>),
      tags: 1,
    }
    const result = validateBackupEnvelope({ ...base, data: mutatedData, counts: mutatedCounts })
    // The row itself is a plain object (isRowArray only checks typeof/Array.isArray), so this is
    // expected to validate structurally — the point of the test is that nothing about validating
    // it pollutes the real Object.prototype.
    expect(typeof result.valid).toBe('boolean')
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('deeply nested garbage inside a data row does not hang or blow the stack', () => {
    const base = goodEnvelope() as Record<string, unknown>
    let deep: unknown = { bottom: true }
    for (let i = 0; i < 5000; i += 1) {
      deep = { nested: deep }
    }
    const data = base['data'] as Record<string, unknown>
    const mutatedData = { ...data, tags: [{ id: 'x', payload: deep }] }
    const mutatedCounts = { ...(base['counts'] as Record<string, number>), tags: 1 }
    expectFailsClosedNeverThrows({ ...base, data: mutatedData, counts: mutatedCounts })
  })

  it('a very long string in a row value does not hang validation', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const longString = 'x'.repeat(2_000_000)
    const data = base['data'] as Record<string, unknown>
    const mutatedData = { ...data, tags: [{ id: 'x', notes: longString }] }
    const mutatedCounts = { ...(base['counts'] as Record<string, number>), tags: 1 }
    const start = performance.now()
    expectFailsClosedNeverThrows({ ...base, data: mutatedData, counts: mutatedCounts })
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('a huge row array (50k rows) validates within a bounded time — no O(n^2) blowup', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const hugeArray = Array.from({ length: 50_000 }, (_, i) => ({ id: `row-${String(i)}` }))
    const data = base['data'] as Record<string, unknown>
    const mutatedData = { ...data, tags: hugeArray }
    const mutatedCounts = { ...(base['counts'] as Record<string, number>), tags: hugeArray.length }
    const start = performance.now()
    const result = validateBackupEnvelope({ ...base, data: mutatedData, counts: mutatedCounts })
    const elapsed = performance.now() - start
    expect(result.valid).toBe(true)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('backup envelope validator — randomized structural fuzzing (fast-check)', () => {
  // A generator that produces arbitrary JSON-ish values, including the exact shapes described in
  // P114 §15: wrong types, negative/fractional numbers, unknown keys, empty objects, etc.
  const jsonValue = fc.jsonValue()

  it('never throws for any arbitrary JSON value as the top-level envelope', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expectFailsClosedNeverThrows(value)
      }),
      { numRuns: 2000 },
    )
  })

  it('never throws when arbitrary JSON garbage replaces one top-level envelope key', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const topKeys = Object.keys(base)
    fc.assert(
      fc.property(fc.constantFrom(...topKeys), jsonValue, (key, garbage) => {
        expectFailsClosedNeverThrows({ ...base, [key]: garbage })
      }),
      { numRuns: 1000 },
    )
  })

  it('never throws when arbitrary JSON garbage replaces one data-section value', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const data = base['data'] as Record<string, unknown>
    const dataKeys = Object.keys(data)
    fc.assert(
      fc.property(fc.constantFrom(...dataKeys), jsonValue, (key, garbage) => {
        expectFailsClosedNeverThrows({ ...base, data: { ...data, [key]: garbage } })
      }),
      { numRuns: 1000 },
    )
  })

  it('never throws when counts carry arbitrary numeric-looking garbage (negative, fractional, huge, NaN-shaped)', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const counts = base['counts'] as Record<string, number>
    const countKeys = Object.keys(counts)
    const numericGarbage = fc.oneof(
      fc.double(),
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
    )
    fc.assert(
      fc.property(fc.constantFrom(...countKeys), numericGarbage, (key, garbage) => {
        expectFailsClosedNeverThrows({ ...base, counts: { ...counts, [key]: garbage } })
      }),
      { numRuns: 1000 },
    )
  })

  it('a truncated envelope (random subset of top-level keys removed) always fails closed', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const topKeys = Object.keys(base)
    fc.assert(
      fc.property(fc.subarray(topKeys, { minLength: 0, maxLength: topKeys.length - 1 }), (kept) => {
        const truncated: Record<string, unknown> = {}
        for (const key of kept) truncated[key] = base[key]
        const result = validateBackupEnvelope(truncated)
        expect(result.valid).toBe(false)
      }),
      { numRuns: 500 },
    )
  })
})
