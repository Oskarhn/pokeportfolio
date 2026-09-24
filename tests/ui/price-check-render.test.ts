import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { gradedSection, parseGradedObservations } from '../../src/domain/price-check/graded'
import { parseFxRate, type FxRateParse } from '../../src/domain/price-check/fx'
import { resolveVariant } from '../../src/domain/price-check/identity'
import type {
  CardIdentity,
  GradedPriceSection,
  VariantIdentity,
} from '../../src/domain/price-check/types'
import type { CardPriceResponse } from '../../src/domain/price-check/raw-section'

// CardImage → data/catalog → the real Supabase client (refuses to start unconfigured). Rendering
// needs none of it.
vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))

const { ResultView } = await import('../../src/features/price-check/ResultView')
type ResultViewProps = import('../../src/features/price-check/ResultView').ResultViewProps

const NOW = Date.parse('2026-09-20T12:00:00Z')

const CARD: CardIdentity = {
  cardId: 'card-1',
  name: 'Charizard',
  setId: 'base1',
  setName: 'Base Set',
  collectorNumber: '4',
  language: 'en',
  imageBaseUrl: null,
  rarity: 'Rare Holo',
  illustrator: 'Mitsuhiro Arita',
}

const NORMAL: VariantIdentity = {
  variantId: 'v-normal',
  finish: 'normal',
  stamp: '',
  subtype: '',
  size: 'standard',
  isActive: true,
}
const HOLO: VariantIdentity = { ...NORMAL, variantId: 'v-holo', finish: 'holo' }

const NO_GRADED = gradedSection({ sources: [], observations: [], dropped: [] })
const EUR_RATE = parseFxRate(11.54, '2026-09-18')
const USD_RATE = parseFxRate(10.5, '2026-09-18')

function obs(o: Record<string, unknown> = {}) {
  return {
    provider: 'tcgdex_cardmarket',
    priceKind: 'cm_trend',
    sourceCurrency: 'EUR',
    valueMinor: '1234',
    providerUpdatedAt: '2026-09-19T08:03:04Z',
    ...o,
  }
}

function response(rows: unknown[], over: Partial<CardPriceResponse> = {}): CardPriceResponse {
  return { fetchedAt: '2026-09-20T11:30:00.000Z', providerErrorCount: 0, rows, ...over }
}

function view(over: Partial<ResultViewProps> = {}): string {
  const variants = over.variants ?? [NORMAL]
  const props: ResultViewProps = {
    card: CARD,
    variants,
    resolution: resolveVariant(variants, undefined),
    raw: {
      state: 'ready',
      origin: 'network',
      response: response([{ cardVariantId: 'v-normal', observations: [obs()] }]),
    },
    graded: NO_GRADED,
    fxByCurrency: { EUR: EUR_RATE, USD: USD_RATE },
    nowMs: NOW,
    onSelectVariant: () => undefined,
    onRetry: () => undefined,
    slots: {
      addToCollection: createElement('a', { 'data-testid': 'add-link' }, 'Add to collection'),
      searchAgain: createElement('a', null, 'Search again'),
      scanAgain: createElement('a', null, 'Scan'),
      setLink: createElement('span', null, 'Base Set') as ReactNode,
    },
    ...over,
  }
  return renderToStaticMarkup(createElement(ResultView, props))
}

const gradedFixture = (rows: Record<string, unknown>[], observedAt = '2026-09-18T00:00:00Z') =>
  gradedSection({
    sources: [{ id: 'fixture', label: 'Synthetic fixture', state: 'ok' }],
    ...parseGradedObservations(
      rows.map((r) => ({
        kind: 'sold',
        currency: 'USD',
        valueMinor: '10000',
        observedAt,
        ...r,
      })),
      {
        source: { id: 'fixture', label: 'Synthetic fixture' },
        fetchedAt: '2026-09-20T11:00:00Z',
        synthetic: true,
      },
    ),
  }) satisfies GradedPriceSection

describe('variant confirmation', () => {
  it('a multi-variant card shows a chooser with nothing selected, no price and no Add link', () => {
    const html = view({ variants: [NORMAL, HOLO] })
    expect(html).toContain('data-testid="choose-variant"')
    expect(html.match(/role="radio"/g)).toHaveLength(2)
    expect(html).not.toContain('aria-checked="true"')
    expect(html).not.toContain('data-testid="observation"')
    expect(html).not.toContain('data-testid="add-link"')
    expect(html).not.toContain('Graded prices')
  })

  it('once a variant is chosen, that variant’s prices and the Add link appear', () => {
    const variants = [NORMAL, HOLO]
    const html = view({
      variants,
      resolution: resolveVariant(variants, 'v-holo'),
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          { cardVariantId: 'v-normal', observations: [obs({ valueMinor: '111' })] },
          { cardVariantId: 'v-holo', observations: [obs({ valueMinor: '99900' })] },
        ]),
      },
    })
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('€999.00')
    expect(html).not.toContain('€1.11')
    expect(html).toContain('data-testid="add-link"')
  })

  it('never selects a variant from a URL that names someone else’s variant', () => {
    const variants = [NORMAL, HOLO]
    const html = view({ variants, resolution: resolveVariant(variants, 'foreign') })
    expect(html).toContain('does not belong to this card')
    expect(html).not.toContain('data-testid="observation"')
  })

  it('a single-variant card says so and shows prices without a chooser', () => {
    const html = view()
    expect(html).toContain('data-testid="only-variant"')
    expect(html).not.toContain('role="radiogroup"')
    expect(html).toContain('data-testid="observation"')
  })

  it('a card with no variants says a price cannot be matched', () => {
    const html = view({ variants: [], resolution: resolveVariant([], undefined) })
    expect(html).toContain('data-testid="no-variants"')
  })

  it('the chooser reports availability per variant, never a price', () => {
    const variants = [NORMAL, HOLO]
    const html = view({
      variants,
      resolution: resolveVariant(variants, undefined),
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          { cardVariantId: 'v-normal', observations: [obs(), obs({ priceKind: 'cm_avg' })] },
          { cardVariantId: 'v-holo', observations: [] },
        ]),
      },
    })
    expect(html).toContain('2 prices')
    expect(html).toContain('No price')
    expect(html).not.toContain('€')
  })
})

describe('raw price presentation', () => {
  it('shows the source-currency amount, source, metric, kind, dates and condition honestly', () => {
    const html = view()
    expect(html).toContain('€12.34')
    expect(html).toContain('Cardmarket via TCGdex')
    expect(html).toContain('Trend price')
    expect(html).toContain('Index price')
    expect(html).toContain('Observed by source 2026-09-19')
    expect(html).toContain('Fetched 2026-09-20 11:30 UTC')
    expect(html).toContain('Condition not specified by source')
    expect(html).toContain('data-freshness="fresh"')
    expect(html).toContain('1 day old')
    expect(html).toContain('raw condition')
  })

  it('shows the NOK figure only as a labelled reference with rate and date', () => {
    const html = view()
    expect(html).toContain('≈ kr 142,40 at 11.54 NOK per EUR (Norges Bank, 2026-09-18)')
  })

  it('without an exchange rate it shows the original currency and says NOK is unavailable', () => {
    const html = view({ fxByCurrency: {} })
    expect(html).toContain('€12.34')
    expect(html).toContain('NOK reference unavailable')
    expect(html).not.toContain('≈ kr')
  })

  it('a malformed cached rate is reported as invalid, not converted', () => {
    const bad: FxRateParse = { ok: false, reason: 'malformed' }
    const html = view({ fxByCurrency: { EUR: bad } })
    expect(html).toContain('the cached exchange rate is invalid')
    expect(html).not.toContain('≈ kr')
  })

  it('flags a stale exchange rate', () => {
    const html = view({ fxByCurrency: { EUR: parseFxRate(11.54, '2026-09-08') } })
    expect(html).toContain('data-testid="fx-stale"')
    expect(html).toContain('12 days old')
  })

  it.each([
    ['2026-09-10T00:00:00Z', 'stale', 'Stale · 10 days old'],
    ['2026-07-01T00:00:00Z', 'outdated', 'Outdated'],
    [null, 'unknown', 'Age unknown'],
  ])('observation date %s → %s', (providerUpdatedAt, freshness, text) => {
    const html = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          { cardVariantId: 'v-normal', observations: [obs({ providerUpdatedAt })] },
        ]),
      },
    })
    expect(html).toContain(`data-freshness="${freshness}"`)
    expect(html).toContain(text)
    if (freshness === 'unknown') expect(html).toContain('Source gave no observation date')
  })

  it('a provider-reported zero is shown as €0.00; a missing price is "Not available", never a number', () => {
    const zero = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          { cardVariantId: 'v-normal', observations: [obs({ valueMinor: '0' })] },
        ]),
      },
    })
    expect(zero).toContain('€0.00')
    expect(zero).toContain('≈ kr 0,00')

    const missing = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([{ cardVariantId: 'v-normal', observations: [] }]),
      },
    })
    expect(missing).toContain('data-reason="no_variant_price"')
    expect(missing).toContain('Not available')
    expect(missing).not.toContain('data-testid="observation"')
    expect(missing).not.toMatch(/€0|kr 0/)
  })

  it('shows both providers side by side, each in its own currency, never blended', () => {
    const html = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          {
            cardVariantId: 'v-normal',
            observations: [
              obs(),
              obs({
                provider: 'tcgdex_tcgplayer',
                priceKind: 'tp_market',
                sourceCurrency: 'USD',
                valueMinor: '1500',
              }),
            ],
          },
        ]),
      },
    })
    expect(html).toContain('€12.34')
    expect(html).toContain('$15.00')
    expect(html).toContain('TCGplayer via TCGdex')
    expect(html.match(/data-testid="observation"/g)).toHaveLength(2)
  })

  it('renders very large values exactly (no float rounding)', () => {
    const html = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          { cardVariantId: 'v-normal', observations: [obs({ valueMinor: '9007199254740993' })] },
        ]),
      },
    })
    expect(html).toContain('€90,071,992,547,409.93')
  })

  it('labels cached data as cached with its original fetch time', () => {
    const html = view({
      raw: {
        state: 'ready',
        origin: 'cache',
        response: response([{ cardVariantId: 'v-normal', observations: [obs()] }]),
      },
    })
    expect(html).toContain('Cached — fetched 2026-09-20 11:30 UTC')
  })

  it('names provider failure as a failure with a retry, not as a zero or "no price"', () => {
    const html = view({ raw: { state: 'error', reason: 'provider_error' } })
    expect(html).toContain('data-reason="provider_error"')
    expect(html).toContain('lookup failure, not a zero price')
    expect(html).toContain('Try again')
    expect(html).not.toContain('data-testid="observation"')
  })

  it('rate limiting and network failures are distinct, retryable states', () => {
    expect(view({ raw: { state: 'error', reason: 'rate_limited' } })).toContain('rate limiting')
    expect(view({ raw: { state: 'error', reason: 'network' } })).toContain('connection failed')
  })

  it('a loading state is announced politely', () => {
    const html = view({ raw: { state: 'loading' } })
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Loading prices')
  })

  it('reports refused provider values instead of hiding them', () => {
    const html = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          {
            cardVariantId: 'v-normal',
            observations: [obs(), obs({ priceKind: 'cm_avg', valueMinor: '-5' })],
          },
        ]),
      },
    })
    expect(html).toContain('data-testid="dropped-notice"')
    expect(html).toContain('1 provider value was ignored')
  })

  it('admits when an older deployment could only show one provider', () => {
    const html = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([
          {
            cardVariantId: 'v-normal',
            provider: 'tcgdex_cardmarket',
            priceKind: 'cm_trend',
            sourceCurrency: 'EUR',
            sourceValueMinor: 1234,
            providerUpdatedAt: '2026-09-19T08:03:04Z',
          },
        ]),
      },
    })
    expect(html).toContain('data-testid="headline-only"')
  })

  it('never calls a cached/relayed statistic "live" or "current"', () => {
    const html = view()
    expect(html).not.toMatch(/\blive\b/i)
    expect(html).not.toMatch(/current price/i)
  })

  it('long card names wrap instead of overflowing', () => {
    const html = view({ card: { ...CARD, name: 'Pikachu with Grey Felt Hat '.repeat(6).trim() } })
    expect(html).toContain('break-words')
  })
})

describe('graded presentation', () => {
  it('with no authorized source it says so and shows no price or estimate', () => {
    const html = view()
    expect(html).toContain('Graded prices')
    expect(html).toContain('data-reason="graded_source_not_configured"')
    expect(html).toContain('never estimated from raw prices')
    expect(html).toContain('PSA: no data')
    expect(html).not.toContain('data-testid="graded-row"')
  })

  it('renders each company separately with its own rows; PSA 10 and BGS 10 are never merged', () => {
    const graded = gradedFixture([
      { company: 'PSA', grade: '10', valueMinor: '30000' },
      { company: 'PSA', grade: '9', valueMinor: '9000' },
      { company: 'BGS', grade: '10', valueMinor: '50000', qualifier: 'Pristine' },
      { company: 'CGC', grade: '10', valueMinor: '10000' },
    ])
    const html = view({ graded })
    expect(html.match(/data-testid="graded-row"/g)).toHaveLength(4)
    for (const company of ['PSA', 'BGS', 'CGC']) {
      expect(html).toContain(`aria-label="${company} graded prices"`)
    }
    expect(html).toContain('BGS 10 Pristine')
    expect(html).toContain('$300.00')
    expect(html).toContain('$500.00')
    expect(html).toContain('Grades are never compared across companies')
  })

  it('marks synthetic fixtures as synthetic', () => {
    const html = view({ graded: gradedFixture([{ company: 'PSA', grade: '10' }]) })
    expect(html).toContain('data-testid="synthetic-badge"')
    expect(html).toContain('Synthetic test data')
  })

  it('raw missing, graded present', () => {
    const html = view({
      raw: {
        state: 'ready',
        origin: 'network',
        response: response([{ cardVariantId: 'v-normal', observations: [] }]),
      },
      graded: gradedFixture([{ company: 'PSA', grade: '10' }]),
    })
    expect(html).toContain('data-reason="no_variant_price"')
    expect(html).toContain('data-testid="graded-row"')
  })

  it('raw present, graded missing', () => {
    const html = view()
    expect(html).toContain('data-testid="observation"')
    expect(html).toContain('data-reason="graded_source_not_configured"')
  })

  it('only the selected companies and grades appear — nothing is filled in for the others', () => {
    const html = view({ graded: gradedFixture([{ company: 'CGC', grade: '9.5' }]) })
    expect(html).toContain('CGC 9.5')
    expect(html).not.toContain('aria-label="PSA graded prices"')
    expect(html).not.toContain('aria-label="BGS graded prices"')
  })

  it('stale graded data is flagged stale, not presented as current', () => {
    const html = view({
      graded: gradedFixture([{ company: 'PSA', grade: '10' }], '2026-09-01T00:00:00Z'),
    })
    expect(html).toContain('data-freshness="stale"')
  })

  it('a graded row shows its price type (sold vs listing)', () => {
    const html = view({
      graded: gradedFixture([
        { company: 'PSA', grade: '10', kind: 'sold' },
        { company: 'PSA', grade: '9', kind: 'listing' },
      ]),
    })
    expect(html).toContain('Sold price')
    expect(html).toContain('Listing price')
  })

  it('JPY graded values render with no decimals and a JPY label', () => {
    const html = view({
      graded: gradedFixture([
        { company: 'PSA', grade: '10', currency: 'JPY', valueMinor: '25000' },
      ]),
    })
    expect(html).toContain('25,000 JPY')
    expect(html).not.toContain('250.00 JPY')
  })

  it('the wide table sits in a labelled, keyboard-focusable scroll region', () => {
    const html = view({ graded: gradedFixture([{ company: 'PSA', grade: '10' }]) })
    expect(html).toMatch(/role="region"[^>]*aria-label="PSA graded prices"[^>]*tabindex="0"/)
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('<caption')
  })
})
