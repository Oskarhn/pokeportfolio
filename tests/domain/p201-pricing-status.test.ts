import { describe, expect, it } from 'vitest'
import {
  classifySearchPrice,
  freshnessBadge,
  type PriceReference,
} from '../../src/domain/pricing-status'

/**
 * P201 — the four states a catalog price can be in are never collapsed: loading, unavailable (OUR
 * lookup failed), none (the source has no price), priced (with its age).
 */

const NOW = Date.parse('2026-10-09T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

function ref(over: Partial<PriceReference> = {}): PriceReference {
  return {
    priceState: 'available',
    providerUpdatedAt: day(1),
    valueNokMinor: 12_345n,
    ...over,
  }
}

describe('classifySearchPrice', () => {
  it('is loading while the lookup is pending', () => {
    expect(classifySearchPrice('pending', undefined, NOW)).toEqual({ kind: 'loading' })
  })

  it('a failed lookup is unavailable even when rows came back, and says which kind of failure', () => {
    expect(classifySearchPrice('request_failed', undefined, NOW)).toEqual({
      kind: 'unavailable',
      cause: 'request',
    })
    expect(classifySearchPrice('provider_failed', ref(), NOW)).toEqual({
      kind: 'unavailable',
      cause: 'provider',
    })
    expect(
      classifySearchPrice('provider_failed', { ...ref(), priceState: 'missing' }, NOW).kind,
    ).toBe('unavailable')
  })

  it('an answered lookup with no row or a missing row is none, never unavailable', () => {
    expect(classifySearchPrice('ok', undefined, NOW)).toEqual({ kind: 'none' })
    expect(
      classifySearchPrice(
        'ok',
        { priceState: 'missing', providerUpdatedAt: null, valueNokMinor: null },
        NOW,
      ),
    ).toEqual({ kind: 'none' })
  })

  it.each([
    [0, 'fresh'],
    [3, 'fresh'],
    [4, 'stale'],
    [30, 'stale'],
    [31, 'outdated'],
    [400, 'outdated'],
  ])('a price observed %i days ago is %s', (age, freshness) => {
    const status = classifySearchPrice('ok', ref({ providerUpdatedAt: day(age) }), NOW)
    expect(status).toMatchObject({ kind: 'priced', freshness, ageDays: age })
  })

  it('a price with no or an unusable date is priced with unknown age, not fresh', () => {
    for (const providerUpdatedAt of [null, 'soon', '2099-01-01T00:00:00Z']) {
      expect(classifySearchPrice('ok', ref({ providerUpdatedAt }), NOW)).toMatchObject({
        kind: 'priced',
        freshness: 'unknown',
        ageDays: null,
      })
    }
  })

  it('reports when the source price exists but no NOK reference could be derived', () => {
    expect(classifySearchPrice('ok', ref({ valueNokMinor: null }), NOW)).toMatchObject({
      kind: 'priced',
      nokKnown: false,
    })
  })

  it('a genuine zero NOK value is still a known price', () => {
    expect(classifySearchPrice('ok', ref({ valueNokMinor: 0n }), NOW)).toMatchObject({
      kind: 'priced',
      nokKnown: true,
    })
  })
})

describe('freshnessBadge', () => {
  const priced = (providerUpdatedAt: string | null) => {
    const s = classifySearchPrice('ok', ref({ providerUpdatedAt }), NOW)
    if (s.kind !== 'priced') throw new Error('expected priced')
    return s
  }

  it('shows nothing for a fresh price and a qualifier for every other age', () => {
    expect(freshnessBadge(priced(day(1)))).toBeNull()
    expect(freshnessBadge(priced(day(10)))).toBe('Stale · 10 days old')
    expect(freshnessBadge(priced(day(60)))).toBe('Outdated · 60 days old')
    expect(freshnessBadge(priced(null))).toBe('Age unknown')
  })
})
