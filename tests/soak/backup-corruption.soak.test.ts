import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { validateBackupEnvelope } from '../../src/domain/export/backup-validate'
import { buildBackupEnvelope, serializeBackupEnvelope } from '../../src/domain/export/build-backup'
import { FIXED_EXPORTED_AT, fixtureSnapshot } from '../data/export-fixtures'

/**
 * P117 §15 — backup envelope corruption fuzz, scaled from P114's ~6,500 generated cases
 * (tests/data/export-backup-envelope-fuzz.test.ts) to >=100,000. Same contract, same generators,
 * same helper functions -- this file exists purely to run them at the higher volume the P117
 * brief asks for without slowing down `pnpm test`'s per-commit gate. Run via `pnpm test:soak`.
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

const jsonValue = fc.jsonValue()

describe('backup envelope validator soak — >=100k generated malformed envelopes, never throws/hangs, fails closed', () => {
  it('30k cases: arbitrary JSON value as the entire top-level envelope', () => {
    let runs = 0
    fc.assert(
      fc.property(jsonValue, (value) => {
        runs++
        expectFailsClosedNeverThrows(value)
      }),
      { numRuns: 30_000 },
    )
    expect(runs).toBe(30_000)
  })

  it('30k cases: one top-level key replaced with arbitrary JSON garbage', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const topKeys = Object.keys(base)
    let runs = 0
    fc.assert(
      fc.property(fc.constantFrom(...topKeys), jsonValue, (key, garbage) => {
        runs++
        expectFailsClosedNeverThrows({ ...base, [key]: garbage })
      }),
      { numRuns: 30_000 },
    )
    expect(runs).toBe(30_000)
  })

  it('20k cases: one data-section value replaced with arbitrary JSON garbage', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const data = base['data'] as Record<string, unknown>
    const dataKeys = Object.keys(data)
    let runs = 0
    fc.assert(
      fc.property(fc.constantFrom(...dataKeys), jsonValue, (key, garbage) => {
        runs++
        expectFailsClosedNeverThrows({ ...base, data: { ...data, [key]: garbage } })
      }),
      { numRuns: 20_000 },
    )
    expect(runs).toBe(20_000)
  })

  it('15k cases: counts carrying arbitrary numeric-looking garbage (negative, fractional, huge, NaN-shaped)', () => {
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
    let runs = 0
    fc.assert(
      fc.property(fc.constantFrom(...countKeys), numericGarbage, (key, garbage) => {
        runs++
        expectFailsClosedNeverThrows({ ...base, counts: { ...counts, [key]: garbage } })
      }),
      { numRuns: 15_000 },
    )
    expect(runs).toBe(15_000)
  })

  it('10k cases: a truncated envelope (random subset of top-level keys removed) always fails closed', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const topKeys = Object.keys(base)
    let runs = 0
    fc.assert(
      fc.property(fc.subarray(topKeys, { minLength: 0, maxLength: topKeys.length - 1 }), (kept) => {
        runs++
        const truncated: Record<string, unknown> = {}
        for (const key of kept) truncated[key] = base[key]
        const result = validateBackupEnvelope(truncated)
        expect(result.valid).toBe(false)
      }),
      { numRuns: 10_000 },
    )
    expect(runs).toBe(10_000)
  })

  it('10k cases: two-or-more top-level keys simultaneously corrupted with arbitrary JSON garbage', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const topKeys = Object.keys(base)
    let runs = 0
    fc.assert(
      fc.property(
        fc.subarray(topKeys, { minLength: 2, maxLength: topKeys.length }),
        fc.array(jsonValue, { minLength: 2, maxLength: topKeys.length }),
        (keys, garbageValues) => {
          runs++
          const mutated = { ...base }
          keys.forEach((key, i) => {
            mutated[key] = garbageValues[i % garbageValues.length]
          })
          expectFailsClosedNeverThrows(mutated)
        },
      ),
      { numRuns: 10_000 },
    )
    expect(runs).toBe(10_000)
  })

  it('5k cases: a row array replaced by non-array garbage of every JSON type', () => {
    const base = goodEnvelope() as Record<string, unknown>
    const data = base['data'] as Record<string, unknown>
    const dataKeys = Object.keys(data)
    const nonArrayGarbage = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.object(),
      fc.dictionary(fc.string(), jsonValue),
    )
    let runs = 0
    fc.assert(
      fc.property(fc.constantFrom(...dataKeys), nonArrayGarbage, (key, garbage) => {
        runs++
        const mutatedData = { ...data, [key]: garbage }
        expectFailsClosedNeverThrows({ ...base, data: mutatedData })
      }),
      { numRuns: 5_000 },
    )
    expect(runs).toBe(5_000)
  })
})
