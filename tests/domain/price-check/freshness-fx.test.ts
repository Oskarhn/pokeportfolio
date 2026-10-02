import { describe, expect, it } from 'vitest'
import {
  ageInDays,
  classifyFreshness,
  isFxRateStale,
} from '../../../src/domain/price-check/freshness'
import { nokReference, parseFxRate } from '../../../src/domain/price-check/fx'
import { resolveMarketValue } from '../../../src/domain/market-value'
import { fromMinorUnits } from '../../../src/domain/money'

const NOW = Date.parse('2026-09-20T12:00:00Z')

describe('freshness', () => {
  it.each([
    ['2026-09-20T00:00:01Z', 0, 'fresh'],
    ['2026-09-19T23:59:59Z', 1, 'fresh'],
    ['2026-09-17T08:00:00Z', 3, 'fresh'],
    ['2026-09-16T23:00:00Z', 4, 'stale'],
    ['2026-08-21T00:00:00Z', 30, 'stale'],
    ['2026-08-20T23:59:59Z', 31, 'outdated'],
    ['2020-01-01T00:00:00Z', 2454, 'outdated'],
  ])('%s is %s days old → %s', (observedAt, days, label) => {
    expect(ageInDays(observedAt, NOW)).toBe(days)
    expect(classifyFreshness(observedAt, NOW)).toBe(label)
  })

  it('a missing or invalid observation date is unknown — never fresh', () => {
    for (const value of [null, '', 'not a date', '2026-13-45T00:00:00Z']) {
      expect(classifyFreshness(value, NOW)).toBe('unknown')
    }
  })

  it('a timestamp far in the future is unknown, not "0 days old"', () => {
    expect(classifyFreshness('2026-09-25T00:00:00Z', NOW)).toBe('unknown')
  })

  it('agrees with the portfolio resolver at every boundary (fresh ≤3, stale ≤30)', () => {
    const value = fromMinorUnits(100n, 'EUR')
    for (const age of [0, 3, 4, 30, 31]) {
      const resolved = resolveMarketValue({
        manualValue: null,
        providerSnapshot: { value, ageDays: age },
      }).state
      const mine = classifyFreshness(new Date(NOW - age * 86_400_000).toISOString(), NOW)
      // The resolver turns >30 into `missing`; Price Check keeps the number but flags it.
      const expected = resolved === 'missing' ? 'outdated' : resolved
      expect(mine).toBe(expected)
    }
  })

  it('flags an exchange rate older than a week, tolerating a long holiday weekend', () => {
    expect(isFxRateStale('2026-09-15', NOW)).toBe(false) // 5 days
    expect(isFxRateStale('2026-09-13', NOW)).toBe(false) // 7 days
    expect(isFxRateStale('2026-09-12', NOW)).toBe(true) // 8 days
  })
})

describe('parseFxRate', () => {
  it('accepts a plain positive decimal and keeps it exactly', () => {
    expect(parseFxRate(11.54, '2026-09-18')).toEqual({
      ok: true,
      rate: { rateToNok: '11.54', rateDate: '2026-09-18' },
    })
    expect(parseFxRate('0.06037500', '2026-09-18')).toMatchObject({ ok: true })
  })

  it('distinguishes missing from malformed', () => {
    expect(parseFxRate(null, '2026-09-18')).toEqual({ ok: false, reason: 'missing' })
    expect(parseFxRate(11.5, undefined)).toEqual({ ok: false, reason: 'missing' })
    for (const bad of [0, -1, '0.00', 'abc', NaN, Infinity, 1e-7, 1e21, '1.123456789', '']) {
      expect(parseFxRate(bad, '2026-09-18')).toEqual({ ok: false, reason: 'malformed' })
    }
    expect(parseFxRate(11.5, '18/09/2026')).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('nokReference — exact, exponent-aware, never invented', () => {
  const rate = (r: string) => parseFxRate(r, '2026-09-18')

  it('EUR 12.34 at 11.54 NOK/EUR = 142.4036 → kr 142.40 (14240 øre)', () => {
    const ref = nokReference(fromMinorUnits(1234n, 'EUR'), rate('11.54'))
    expect(ref.status).toBe('converted')
    if (ref.status === 'converted') {
      expect(ref.nok).toEqual({ minorUnits: 14240n, currency: 'NOK' })
      expect(ref.rate.rateDate).toBe('2026-09-18')
    }
  })

  it('USD 10.00 at 10.5 NOK/USD = kr 105.00', () => {
    const ref = nokReference(fromMinorUnits(1000n, 'USD'), rate('10.5'))
    expect(ref.status === 'converted' && ref.nok.minorUnits).toBe(10500n)
  })

  it('JPY has exponent 0: ¥1000 at 0.060375 NOK/JPY = kr 60.375 → 6038 øre (half up), not 100× off', () => {
    const ref = nokReference(fromMinorUnits(1000n, 'JPY'), rate('0.060375'))
    expect(ref.status === 'converted' && ref.nok.minorUnits).toBe(6038n)
  })

  it('rounds half up exactly once: EUR 0.01 at 10.5 = 0.105 NOK → 11 øre', () => {
    const ref = nokReference(fromMinorUnits(1n, 'EUR'), rate('10.5'))
    expect(ref.status === 'converted' && ref.nok.minorUnits).toBe(11n)
  })

  it('a zero source price converts to zero (a real observation), not to unavailable', () => {
    const ref = nokReference(fromMinorUnits(0n, 'EUR'), rate('11.54'))
    expect(ref.status === 'converted' && ref.nok.minorUnits).toBe(0n)
  })

  it('handles values beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const ref = nokReference(fromMinorUnits(9007199254740993n, 'EUR'), rate('2'))
    expect(ref.status === 'converted' && ref.nok.minorUnits).toBe(18014398509481986n)
  })

  it('no rate → unavailable (the caller shows the source currency), never a guessed NOK', () => {
    expect(nokReference(fromMinorUnits(1234n, 'EUR'), null)).toEqual({
      status: 'unavailable',
      reason: 'fx_missing',
    })
    expect(nokReference(fromMinorUnits(1234n, 'EUR'), parseFxRate(null, null))).toEqual({
      status: 'unavailable',
      reason: 'fx_missing',
    })
    expect(nokReference(fromMinorUnits(1234n, 'EUR'), parseFxRate('abc', '2026-09-18'))).toEqual({
      status: 'unavailable',
      reason: 'fx_malformed',
    })
  })

  it('a NOK price needs no conversion', () => {
    const ref = nokReference(fromMinorUnits(5000n, 'NOK'), null)
    expect(ref).toEqual({ status: 'source_is_nok', nok: { minorUnits: 5000n, currency: 'NOK' } })
  })
})
