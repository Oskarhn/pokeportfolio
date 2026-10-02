import { describe, expect, it } from 'vitest'
import {
  parseHeadlineObservation,
  parseRawObservations,
} from '../../../src/domain/price-check/raw-observations'
import { buildRawSection } from '../../../src/domain/price-check/raw-section'

/**
 * Wire → observation parsing. Expected values are literals written from the provider contract in
 * docs/API_SOURCES.md (Cardmarket = EUR, TCGplayer = USD, exact integer minor units), not derived
 * from the production helpers under test.
 */

const CTX = { fetchedAt: '2026-09-20T10:00:00.000Z', finish: 'normal' as const }

function wire(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'tcgdex_cardmarket',
    priceKind: 'cm_trend',
    sourceCurrency: 'EUR',
    valueMinor: '1234',
    providerUpdatedAt: '2026-09-19T08:03:04Z',
    ...overrides,
  }
}

describe('parseRawObservations', () => {
  it('keeps the exact minor units, the source currency and both timestamps', () => {
    const { observations, dropped } = parseRawObservations([wire()], CTX)
    expect(dropped).toEqual([])
    expect(observations).toHaveLength(1)
    const o = observations[0]!
    expect(o.price).toEqual({ minorUnits: 1234n, currency: 'EUR' })
    expect(o.observedAt).toBe('2026-09-19T08:03:04Z')
    expect(o.fetchedAt).toBe('2026-09-20T10:00:00.000Z')
    expect(o.provider).toBe('tcgdex_cardmarket')
    expect(o.providerLabel).toBe('Cardmarket via TCGdex')
    expect(o.subject).toEqual({ type: 'raw' })
  })

  it('labels every relayed statistic as an index — never sold or listing — and states no condition', () => {
    const kinds = ['cm_trend', 'cm_avg30', 'cm_avg7', 'cm_avg'].map(
      (priceKind) => parseRawObservations([wire({ priceKind })], CTX).observations[0],
    )
    for (const o of kinds) {
      expect(o?.kind).toBe('index')
      expect(o?.condition).toBeNull()
    }
    const tp = parseRawObservations(
      [wire({ provider: 'tcgdex_tcgplayer', priceKind: 'tp_market', sourceCurrency: 'USD' })],
      CTX,
    ).observations[0]
    expect(tp?.kind).toBe('index')
    expect(tp?.price.currency).toBe('USD')
  })

  it('records the averaging window for windowed metrics only', () => {
    const windows = ['cm_trend', 'cm_avg30', 'cm_avg7', 'cm_avg'].map(
      (priceKind) => parseRawObservations([wire({ priceKind })], CTX).observations[0]?.windowDays,
    )
    expect(windows).toEqual([null, 30, 7, null])
  })

  it('shows a provider-reported zero as zero (an observation), distinct from absence', () => {
    const zero = parseRawObservations([wire({ valueMinor: '0' })], CTX)
    expect(zero.observations).toHaveLength(1)
    expect(zero.observations[0]?.price.minorUnits).toBe(0n)
    const none = parseRawObservations([], CTX)
    expect(none.observations).toEqual([])
    expect(none.dropped).toEqual([])
  })

  it.each([
    ['negative', '-5'],
    ['fractional', '12.5'],
    ['exponent', '1e3'],
    ['empty', ''],
    ['spaces', ' 12 '],
  ])('drops a %s price instead of repairing it into a number', (_name, valueMinor) => {
    const { observations, dropped } = parseRawObservations([wire({ valueMinor })], CTX)
    expect(observations).toEqual([])
    expect(dropped).toEqual([{ reason: 'malformed_price', provider: 'tcgdex_cardmarket' }])
  })

  it('drops a JSON number price (only exact decimal strings are trusted)', () => {
    const { observations, dropped } = parseRawObservations([wire({ valueMinor: 1234 })], CTX)
    expect(observations).toEqual([])
    expect(dropped[0]?.reason).toBe('malformed_price')
  })

  it('rejects a currency that contradicts the provider (Cardmarket is EUR, not USD)', () => {
    const { observations, dropped } = parseRawObservations([wire({ sourceCurrency: 'USD' })], CTX)
    expect(observations).toEqual([])
    expect(dropped[0]?.reason).toBe('currency_mismatch')
  })

  it('rejects an unsupported currency code', () => {
    const { dropped } = parseRawObservations([wire({ sourceCurrency: 'XXX' })], CTX)
    expect(dropped[0]?.reason).toBe('unsupported_currency')
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'does not resolve the prototype member %s as a provider, metric or currency',
    (hostile) => {
      expect(parseRawObservations([wire({ provider: hostile })], CTX).dropped[0]?.reason).toBe(
        'unknown_provider',
      )
      expect(parseRawObservations([wire({ priceKind: hostile })], CTX).dropped[0]?.reason).toBe(
        'unknown_metric',
      )
      expect(
        parseRawObservations([wire({ sourceCurrency: hostile })], CTX).dropped[0]?.reason,
      ).toBe('unsupported_currency')
    },
  )

  it('rejects a metric that belongs to the other provider', () => {
    const { dropped } = parseRawObservations([wire({ priceKind: 'tp_market' })], CTX)
    expect(dropped[0]?.reason).toBe('unknown_metric')
  })

  it('treats an unparseable or absurd provider timestamp as unknown, keeping the price', () => {
    for (const providerUpdatedAt of ['yesterday', '', null, 12345, undefined]) {
      const o = parseRawObservations([wire({ providerUpdatedAt })], CTX).observations[0]
      expect(o?.observedAt).toBeNull()
    }
  })

  it('ignores non-array and non-object wire data without throwing', () => {
    expect(parseRawObservations(null, CTX).observations).toEqual([])
    expect(parseRawObservations({}, CTX).observations).toEqual([])
    expect(parseRawObservations(['x', 1, null], CTX).dropped).toHaveLength(3)
  })

  it('marks fixture data as synthetic only when the caller says so', () => {
    expect(parseRawObservations([wire()], CTX).observations[0]?.synthetic).toBe(false)
    expect(
      parseRawObservations([wire()], { ...CTX, synthetic: true }).observations[0]?.synthetic,
    ).toBe(true)
  })
})

describe('parseHeadlineObservation (deployment predating `observations`)', () => {
  it('turns the single headline value into one real observation', () => {
    const { observations } = parseHeadlineObservation(
      {
        provider: 'tcgdex_tcgplayer',
        priceKind: 'tp_market',
        sourceCurrency: 'USD',
        sourceValueMinor: 899,
        providerUpdatedAt: '2026-09-18T00:00:00Z',
      },
      CTX,
    )
    expect(observations[0]?.price).toEqual({ minorUnits: 899n, currency: 'USD' })
  })

  it('yields nothing for a missing headline — never a zero', () => {
    const { observations } = parseHeadlineObservation(
      {
        provider: null,
        priceKind: null,
        sourceCurrency: null,
        sourceValueMinor: null,
        providerUpdatedAt: null,
      },
      CTX,
    )
    expect(observations).toEqual([])
  })

  it('refuses a non-integer / unsafe headline number', () => {
    for (const sourceValueMinor of [1.5, -1, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      const { observations } = parseHeadlineObservation(
        {
          provider: 'tcgdex_cardmarket',
          priceKind: 'cm_trend',
          sourceCurrency: 'EUR',
          sourceValueMinor,
          providerUpdatedAt: null,
        },
        CTX,
      )
      expect(observations).toEqual([])
    }
  })
})

describe('buildRawSection: every outcome is its own state', () => {
  const variant = { variantId: 'v-1', finish: 'normal' as const }
  const base = { fetchedAt: CTX.fetchedAt, providerErrorCount: 0 }

  it('available: both providers side by side, no blending', () => {
    const { section, headlineOnly } = buildRawSection(
      {
        ...base,
        rows: [
          {
            cardVariantId: 'v-1',
            observations: [
              wire(),
              wire({
                provider: 'tcgdex_tcgplayer',
                priceKind: 'tp_market',
                sourceCurrency: 'USD',
                valueMinor: '1500',
              }),
            ],
          },
        ],
      },
      variant,
    )
    expect(headlineOnly).toBe(false)
    expect(section.status).toBe('available')
    expect(
      section.observations.map((o) => [o.provider, o.price.currency, o.price.minorUnits]),
    ).toEqual([
      ['tcgdex_cardmarket', 'EUR', 1234n],
      ['tcgdex_tcgplayer', 'USD', 1500n],
    ])
  })

  it('provider has no price for this variant → no_variant_price (not an error, not zero)', () => {
    const { section } = buildRawSection(
      { ...base, rows: [{ cardVariantId: 'v-1', observations: [] }] },
      variant,
    )
    expect(section).toMatchObject({
      status: 'unavailable',
      unavailable: 'no_variant_price',
      observations: [],
    })
  })

  it('a failed provider lookup is provider_error, never "no price"', () => {
    const { section } = buildRawSection(
      { ...base, providerErrorCount: 1, rows: [{ cardVariantId: 'v-1', observations: [] }] },
      variant,
    )
    expect(section.unavailable).toBe('provider_error')
  })

  it('a variant absent from the response is variant_not_in_response', () => {
    const { section } = buildRawSection(
      { ...base, rows: [{ cardVariantId: 'other', observations: [wire()] }] },
      variant,
    )
    expect(section.unavailable).toBe('variant_not_in_response')
  })

  it('never borrows another variant’s price', () => {
    const { section } = buildRawSection(
      {
        ...base,
        rows: [
          { cardVariantId: 'other', observations: [wire({ valueMinor: '99999' })] },
          { cardVariantId: 'v-1', observations: [] },
        ],
      },
      variant,
    )
    expect(section.observations).toEqual([])
  })

  it('everything malformed → malformed_response, with the refusals counted', () => {
    const { section } = buildRawSection(
      { ...base, rows: [{ cardVariantId: 'v-1', observations: [wire({ valueMinor: 'abc' })] }] },
      variant,
    )
    expect(section.unavailable).toBe('malformed_response')
    expect(section.dropped).toHaveLength(1)
  })

  it('one good and one malformed value: shows the good one and reports the refusal', () => {
    const { section } = buildRawSection(
      {
        ...base,
        rows: [
          {
            cardVariantId: 'v-1',
            observations: [wire(), wire({ priceKind: 'cm_avg', valueMinor: '-1' })],
          },
        ],
      },
      variant,
    )
    expect(section.status).toBe('available')
    expect(section.observations).toHaveLength(1)
    expect(section.dropped).toHaveLength(1)
  })

  it('old deployment (no observations field) falls back to the headline and says so', () => {
    const { section, headlineOnly } = buildRawSection(
      {
        ...base,
        rows: [
          {
            cardVariantId: 'v-1',
            provider: 'tcgdex_cardmarket',
            priceKind: 'cm_trend',
            sourceCurrency: 'EUR',
            sourceValueMinor: 1234,
            providerUpdatedAt: '2026-09-19T08:03:04Z',
          },
        ],
      },
      variant,
    )
    expect(headlineOnly).toBe(true)
    expect(section.observations[0]?.price.minorUnits).toBe(1234n)
  })

  it('old deployment with a missing headline is no_variant_price', () => {
    const { section } = buildRawSection(
      { ...base, rows: [{ cardVariantId: 'v-1', priceState: 'missing', provider: null }] },
      variant,
    )
    expect(section.unavailable).toBe('no_variant_price')
  })
})
