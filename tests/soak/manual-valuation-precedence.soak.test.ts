import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fromMinorUnits, isZero, equals, type Money } from '../../src/domain/money'
import {
  hasResolvableValue,
  resolveMarketValue,
  type MarketValue,
} from '../../src/domain/market-value'
import type { CurrencyCode } from '../../src/domain/currency'

/**
 * P117 §13 — manual-valuation precedence soak. `resolveMarketValue` (src/domain/market-value.ts)
 * is the ONE place this precedence logic exists on the client (grepped: every other reference to
 * "manualValue"/"providerSnapshot" across src/ is a data-carrying field name on an RPC
 * input/response, not a second implementation of the priority order -- the actual resolution for
 * real holdings happens server-side, out of scope for this No-DB prompt). tests/financial/
 * market-value.test.ts already pins the exact boundary cases (0/3/4/6/30/31-day ageDays, zero
 * price, manual-wins, no-snapshot); this file property-fuzzes the same contract across all
 * currencies and random magnitudes/ages at volume, plus the "clear manual" transition. Run via
 * `pnpm test:soak`.
 */

const CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

function expectedState(input: {
  manualValue: Money | null
  providerSnapshot: { value: Money; ageDays: number } | null
}): 'manual' | 'fresh' | 'stale' | 'missing' {
  if (input.manualValue !== null) return 'manual'
  if (input.providerSnapshot === null) return 'missing'
  if (input.providerSnapshot.ageDays <= 3) return 'fresh'
  if (input.providerSnapshot.ageDays <= 30) return 'stale'
  return 'missing'
}

describe('resolveMarketValue soak — manual/market/both/neither matrix, all currencies, 100k cases', () => {
  it('the resolved state matches the documented priority order exactly, and the value (when resolvable) is preserved unmodified', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.option(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), { nil: null }), // manual amount, or absent
        fc.option(
          fc.record({
            valueMinor: fc.bigInt({ min: 0n, max: 10n ** 15n }),
            ageDays: fc.integer({ min: 0, max: 400 }),
          }),
          { nil: null },
        ),
        (currency, manualMinor, snapshot) => {
          runs++
          const manualValue = manualMinor === null ? null : fromMinorUnits(manualMinor, currency)
          const providerSnapshot =
            snapshot === null
              ? null
              : { value: fromMinorUnits(snapshot.valueMinor, currency), ageDays: snapshot.ageDays }
          const input = { manualValue, providerSnapshot }
          const result = resolveMarketValue(input)

          expect(result.state).toBe(expectedState(input))

          if (result.state === 'manual') {
            expect(manualValue).not.toBeNull()
            expect(equals(result.value, manualValue as Money)).toBe(true)
          } else if (result.state === 'fresh' || result.state === 'stale') {
            expect(providerSnapshot).not.toBeNull()
            expect(equals(result.value, (providerSnapshot as { value: Money }).value)).toBe(true)
            expect(result.ageDays).toBe((providerSnapshot as { ageDays: number }).ageDays)
          } else {
            expect(result.state).toBe('missing')
            expect(hasResolvableValue(result)).toBe(false)
          }
        },
      ),
      { numRuns: 100_000 },
    )
    expect(runs).toBe(100_000)
  })

  it('boundary ageDays (3/4/30/31) exactly determine fresh vs stale vs missing, for 20k random values/currencies', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.constantFrom(3, 4, 30, 31),
        (currency, valueMinor, ageDays) => {
          runs++
          const result = resolveMarketValue({
            manualValue: null,
            providerSnapshot: { value: fromMinorUnits(valueMinor, currency), ageDays },
          })
          if (ageDays <= 3) expect(result.state).toBe('fresh')
          else if (ageDays <= 30) expect(result.state).toBe('stale')
          else expect(result.state).toBe('missing')
        },
      ),
      { numRuns: 20_000 },
    )
    expect(runs).toBe(20_000)
  })

  it('a genuine zero-price observation is always resolvable and zero, never conflated with "missing", 20k cases', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 30 }),
        (currency, ageDays) => {
          runs++
          const result = resolveMarketValue({
            manualValue: null,
            providerSnapshot: { value: fromMinorUnits(0n, currency), ageDays },
          })
          expect(hasResolvableValue(result)).toBe(true)
          if (hasResolvableValue(result)) {
            expect(isZero(result.value)).toBe(true)
          }
          expect(result.state).not.toBe('missing')
        },
      ),
      { numRuns: 20_000 },
    )
    expect(runs).toBe(20_000)
  })

  it('"clear manual": removing a manual valuation with the same provider snapshot present deterministically falls back to the provider state, 10k cases', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 60 }),
        (currency, manualMinor, providerMinor, ageDays) => {
          runs++
          const providerSnapshot = { value: fromMinorUnits(providerMinor, currency), ageDays }
          const before: MarketValue = resolveMarketValue({
            manualValue: fromMinorUnits(manualMinor, currency),
            providerSnapshot,
          })
          const after: MarketValue = resolveMarketValue({ manualValue: null, providerSnapshot })

          expect(before.state).toBe('manual')
          expect(after.state).toBe(ageDays <= 3 ? 'fresh' : ageDays <= 30 ? 'stale' : 'missing')
          if (hasResolvableValue(after)) {
            expect(equals(after.value, providerSnapshot.value)).toBe(true)
          }
          // Clearing manual never fabricates equality with the old manual figure unless the
          // provider genuinely happens to match it -- no leftover state from `before` leaks in.
          if (manualMinor !== providerMinor && hasResolvableValue(after)) {
            expect(equals(after.value, fromMinorUnits(manualMinor, currency))).toBe(false)
          }
        },
      ),
      { numRuns: 10_000 },
    )
    expect(runs).toBe(10_000)
  })
})
