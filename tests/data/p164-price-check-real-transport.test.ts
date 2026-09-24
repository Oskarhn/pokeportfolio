import { describe, expect, it, vi } from 'vitest'

// price-check.ts imports the app client (needs Vite env); every call here injects its own client.
vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))

import { createAppSupabaseClient } from '../../src/data/supabase-factory'
import {
  EXACT_TRANSPORT_REWRITE_HEADER,
  createExactTransportFetch,
} from '../../src/data/exact-json-guard'
import { fetchCardPriceResponse } from '../../src/data/price-check'
import { buildRawSection } from '../../src/domain/price-check/raw-section'
import type { VariantIdentity } from '../../src/domain/price-check/types'

/**
 * P164 — Price Check through the REAL exact-transport guard (P149/D-137).
 *
 * P161's compatibility tests replace the whole Supabase client with a stub, so the guard that
 * rewrites unsafe JSON integers in every response was never between the wire and the Price Check
 * parser. The guard QUOTES an unsafe integer literal (`9007199254740993` → `"9007199254740993"`),
 * and a quoted 16–18 digit string is exactly what Price Check's own `valueMinor` grammar accepts.
 * Without the rewrite marker, a bare (non-conforming) literal would therefore be laundered into a
 * plausible exact-looking price. Every body below is raw JSON TEXT pushed through a real client
 * built by the app's own factory.
 */

const CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VARIANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const variant: VariantIdentity = {
  variantId: VARIANT,
  finish: 'normal',
  stamp: '',
  subtype: '',
  size: 'standard',
  isActive: true,
}

/** A real app client whose network is a fixed JSON text; returns it plus the requests it saw. */
function clientReturning(bodyText: string) {
  const requests: { url: string; method: string }[] = []
  const baseFetch: typeof fetch = (input, init) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
    })
    return Promise.resolve(
      new Response(bodyText, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }
  const client = createAppSupabaseClient(
    'http://127.0.0.1:59999',
    'publishable-test-key',
    {},
    { baseFetch },
  )
  return {
    requests,
    invoke: (
      name: 'search-prices',
      options: { body: { cardIds: string[]; useEuPricing: boolean }; signal?: AbortSignal },
    ) => client.functions.invoke(name, options),
  }
}

const HEAD =
  `"cardVariantId":"${VARIANT}","cardId":"${CARD}","priceState":"available",` +
  `"provider":"tcgdex_cardmarket","priceKind":"cm_trend","sourceCurrency":"EUR",` +
  `"valueNokMinor":"14240","providerUpdatedAt":"2026-09-20T00:00:00Z"`

function rowText(sourceValueMinorLiteral: string, observationsText?: string): string {
  const obs = observationsText === undefined ? '' : `,"observations":${observationsText}`
  return `{"ok":true,"providerErrorCount":0,"results":[{${HEAD},"sourceValueMinor":${sourceValueMinorLiteral}${obs}}]}`
}

function observation(valueMinorLiteral: string, provider = 'tcgdex_cardmarket'): string {
  const [priceKind, currency] =
    provider === 'tcgdex_cardmarket' ? ['cm_trend', 'EUR'] : ['tp_market', 'USD']
  return (
    `{"provider":"${provider}","priceKind":"${priceKind}","sourceCurrency":"${currency}",` +
    `"valueMinor":${valueMinorLiteral},"providerUpdatedAt":"2026-09-20T00:00:00Z"}`
  )
}

async function priceCheck(bodyText: string) {
  const { invoke, requests } = clientReturning(bodyText)
  const response = await fetchCardPriceResponse(CARD, {
    invoke,
    now: () => Date.parse('2026-09-21T00:00:00Z'),
  })
  return { ...buildRawSection(response, variant), requests }
}

describe('the guard marks a rewritten response; a conforming one is left unmarked', () => {
  it('a conforming payload (exact decimal STRINGS, 18 digits included) carries no marker', async () => {
    const base: typeof fetch = () =>
      Promise.resolve(
        new Response(`{"v":"999999999999999999","n":12}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const response = await createExactTransportFetch(base)('http://x.test/a')
    expect(response.headers.get(EXACT_TRANSPORT_REWRITE_HEADER)).toBeNull()
    expect(await response.text()).toBe(`{"v":"999999999999999999","n":12}`)
  })

  it('an unsafe integer literal is still quoted (P149 behaviour) and now ALSO marked', async () => {
    const base: typeof fetch = () =>
      Promise.resolve(
        new Response(`{"a":9007199254740993,"b":[-9007199254740993],"c":"9007199254740993"}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const response = await createExactTransportFetch(base)('http://x.test/a')
    expect(await response.text()).toBe(
      `{"a":"9007199254740993","b":["-9007199254740993"],"c":"9007199254740993"}`,
    )
    expect(response.headers.get(EXACT_TRANSPORT_REWRITE_HEADER)).toBe('2')
  })
})

describe('Price Check through the real transport: valid values pass, unsafe bare literals never become a price', () => {
  it('new function: both providers as exact strings above 2^53 arrive exactly, and the network saw one POST', async () => {
    const { section, headlineOnly, requests } = await priceCheck(
      rowText(
        '1234',
        `[${observation('"1234"')},${observation('"999999999999999999"', 'tcgdex_tcgplayer')}]`,
      ),
    )
    expect(headlineOnly).toBe(false)
    expect(section.status).toBe('available')
    expect(
      section.observations.map((o) => [o.provider, o.price.minorUnits, o.price.currency]),
    ).toEqual([
      ['tcgdex_cardmarket', 1234n, 'EUR'],
      ['tcgdex_tcgplayer', 999999999999999999n, 'USD'],
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
  })

  it('old function: a safe headline number is shown as the single (headline-only) observation', async () => {
    const { section, headlineOnly } = await priceCheck(rowText('1234'))
    expect(headlineOnly).toBe(true)
    expect(section.observations.map((o) => o.price.minorUnits)).toEqual([1234n])
  })

  it.each(['9007199254740993', '9007199254740992', '92233720368547760'])(
    'old function: an UNSAFE bare headline number (%s) is refused — no price, never BigInt(roundedNumber)',
    async (literal) => {
      // First layer: the guard's marker refuses the whole response. (Second layer, should a marker
      // ever be missing: the headline parser accepts only a SAFE number — the quoted string the guard
      // produces is `malformed_price`, pinned in tests/domain/price-check/raw-observations.test.ts.)
      await expect(priceCheck(rowText(literal))).rejects.toMatchObject({
        name: 'PriceCheckError',
        reason: 'malformed_response',
      })
    },
  )

  it('old function, marker absent (second layer): the quoted digits of an unsafe headline are dropped, not shown', async () => {
    const { invoke } = clientReturning(rowText('"9007199254740993"'))
    const response = await fetchCardPriceResponse(CARD, { invoke })
    const { section } = buildRawSection(response, variant)
    expect(section.observations).toEqual([])
    expect(section).toMatchObject({ status: 'unavailable', unavailable: 'malformed_response' })
  })

  it('old function: a missing price stays "no price" (never zero) through the real transport', async () => {
    const body =
      `{"ok":true,"providerErrorCount":0,"results":[{"cardVariantId":"${VARIANT}","cardId":"${CARD}",` +
      `"priceState":"missing","provider":null,"priceKind":null,"sourceCurrency":null,` +
      `"sourceValueMinor":null,"valueNokMinor":null,"providerUpdatedAt":null}]}`
    const { section } = await priceCheck(body)
    expect(section.observations).toEqual([])
    expect(section).toMatchObject({ status: 'unavailable', unavailable: 'no_variant_price' })
  })

  it('non-conforming function: a BARE unsafe valueMinor inside observations is refused, not laundered into an exact-looking string', async () => {
    // Without the rewrite marker the guard would turn this into "9007199254740993" and Price Check's
    // ^\d{1,18}$ grammar would accept it as a genuine 90 trillion-unit price.
    const { invoke } = clientReturning(
      rowText(
        '1234',
        `[${observation('9007199254740993')},${observation('"999"', 'tcgdex_tcgplayer')}]`,
      ),
    )
    await expect(fetchCardPriceResponse(CARD, { invoke })).rejects.toMatchObject({
      name: 'PriceCheckError',
      reason: 'malformed_response',
    })
  })

  it('a bare SAFE number in valueMinor is dropped as malformed (the wire grammar is a string)', async () => {
    const { section } = await priceCheck(rowText('1234', `[${observation('1234')}]`))
    expect(section.observations).toEqual([])
    expect(section).toMatchObject({ status: 'unavailable', unavailable: 'malformed_response' })
  })

  it('an unsafe literal anywhere else in the payload also fails the lookup closed (whole-response refusal)', async () => {
    const body = rowText('1234', `[${observation('"1234"')}]`).replace(
      '"providerErrorCount":0',
      '"providerErrorCount":0,"extra":123456789012345678',
    )
    const { invoke } = clientReturning(body)
    await expect(fetchCardPriceResponse(CARD, { invoke })).rejects.toMatchObject({
      reason: 'malformed_response',
    })
  })
})
