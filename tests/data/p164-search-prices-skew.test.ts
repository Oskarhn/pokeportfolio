import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCardPricing } from '../../supabase/functions/_shared/tcgdex'
import { observationsForVariant } from '../../supabase/functions/_shared/price-observations'
import { createAppSupabaseClient } from '../../src/data/supabase-factory'

const holder = vi.hoisted(() => ({
  client: null as null | ReturnType<
    typeof import('../../src/data/supabase-factory').createAppSupabaseClient
  >,
}))
vi.mock('../../src/data/supabase-client', () => ({
  supabase: {
    functions: {
      invoke: (name: string, options: never) => holder.client!.functions.invoke(name, options),
    },
  },
}))

import { searchPrices } from '../../src/data/pricing'
import { fetchCardPriceResponse, type SearchPricesInvoker } from '../../src/data/price-check'
import { buildRawSection } from '../../src/domain/price-check/raw-section'

/**
 * P164 — release-order compatibility of the `search-prices` Edge Function, both skew directions,
 * with the real mapper (`fetchCardPricing`, including the P149 exact-price rule), the real wire
 * builder (`observationsForVariant`), the real exact-transport guard and the real client code.
 *
 *   released client (d8682e0)  +  candidate function     "old client + new function"
 *   candidate client           +  released function      "new client + old function"
 *   candidate client           +  legacy emission        a function that still sent an unsafe JSON number
 *
 * The Edge Function itself runs on Deno with a hard-wired provider URL, so the response ROW is built
 * here by the same expressions the function uses; the last describe pins those expressions in the
 * function's source so a drift fails this file.
 */

const realInvoke: SearchPricesInvoker = (name, options) =>
  holder.client!.functions.invoke(name, options)

const CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NORMAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001'
const REVERSE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002'

afterEach(() => {
  vi.unstubAllGlobals()
})

const provider = (trend: number) => ({
  id: 'swsh1-2',
  localId: '2',
  name: 'Roselia',
  variants: { firstEdition: false, holo: false, normal: true, reverse: true, wPromo: false },
  variants_detailed: [
    { type: 'normal', size: 'standard', variantId: 'generated' },
    { type: 'reverse', size: 'standard', variantId: 'generated' },
  ],
  pricing: {
    cardmarket: {
      updated: '2026-09-20T08:03:04.936Z',
      unit: 'EUR',
      trend,
      'trend-holo': 0.43,
    },
    tcgplayer: {
      unit: 'USD',
      updated: '2026-09-20T08:03:20.122Z',
      normal: { marketPrice: 15 },
      'reverse-holofoil': { marketPrice: 0.3 },
    },
  },
})

async function mapProvider(trend: number) {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(provider(trend)) }),
  )
  return fetchCardPricing('en', 'swsh1-2')
}

type Pricing = Awaited<ReturnType<typeof mapProvider>>

/** The same row expressions as supabase/functions/search-prices/index.ts (pinned below). */
function functionRows(pricing: Pricing, ids: Record<string, string>, useEuPricing = true) {
  return pricing.variants.map((match) => {
    const primary = useEuPricing ? match.cardmarket : match.tcgplayer
    const secondary = useEuPricing ? match.tcgplayer : match.cardmarket
    const chosen = primary ?? secondary ?? null
    return {
      cardVariantId: ids[match.finish] ?? '',
      cardId: CARD,
      priceState: chosen ? 'available' : 'missing',
      provider: chosen?.provider ?? null,
      priceKind: chosen?.priceKind ?? null,
      sourceCurrency: chosen?.sourceCurrency ?? null,
      sourceValueMinor: chosen ? Number(chosen.valueMinor) : null,
      valueNokMinor: null,
      providerUpdatedAt: chosen?.providerUpdatedAt ?? null,
      observations: observationsForVariant(match),
    }
  })
}

const IDS = { normal: NORMAL, reverse: REVERSE }

function bodyText(rows: unknown[]): string {
  return JSON.stringify({ ok: true, results: rows, providerErrorCount: 0 })
}

/** A real app client (real transport guard) whose network is a fixed body. */
function useClientReturning(text: string): void {
  holder.client = createAppSupabaseClient(
    'http://127.0.0.1:59999',
    'publishable-test-key',
    {},
    {
      baseFetch: () =>
        Promise.resolve(
          new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
    },
  )
}

/** VERBATIM excerpt of the RELEASED client mapping (src/data/pricing.ts @ d8682e0, `searchPrices`). */
function releasedClientMapping(text: string) {
  const body = JSON.parse(text) as {
    ok: boolean
    results?: {
      cardVariantId: string
      cardId: string
      priceState: string
      provider: string | null
      sourceCurrency: string | null
      sourceValueMinor: number | null
      valueNokMinor: string | null
      providerUpdatedAt: string | null
    }[]
  }
  if (!body.ok || !body.results) return new Map()
  return new Map(
    body.results.map((r) => [
      r.cardVariantId,
      {
        cardVariantId: r.cardVariantId,
        cardId: r.cardId,
        priceState: r.priceState,
        provider: r.provider,
        sourceCurrency: r.sourceCurrency,
        sourceValueMinor:
          r.sourceValueMinor === null ? null : BigInt(Math.round(r.sourceValueMinor)),
        valueNokMinor: r.valueNokMinor === null ? null : BigInt(r.valueNokMinor),
        providerUpdatedAt: r.providerUpdatedAt,
      },
    ]),
  )
}

const variantOf = (id: string, finish: 'normal' | 'reverse') => ({
  variantId: id,
  finish,
  stamp: '',
  subtype: '',
  size: 'standard',
  isActive: true,
})

describe('old client (released d8682e0) + candidate function', () => {
  it('ignores the additive `observations` field and reads the same headline as before', async () => {
    const text = bodyText(functionRows(await mapProvider(12.34), IDS))
    const map = releasedClientMapping(text)
    expect(map.get(NORMAL)).toMatchObject({
      priceState: 'available',
      provider: 'tcgdex_cardmarket',
      sourceCurrency: 'EUR',
      sourceValueMinor: 1234n,
      valueNokMinor: null,
    })
    // The reverse printing has its own Cardmarket slot ("-holo"): 43 minor units, its own variant.
    expect(map.get(REVERSE)).toMatchObject({ sourceValueMinor: 43n })
  })

  it('an absurd provider price is ABSENT from the candidate function (P149 rule), so the released client sees "missing", not a rounded price', async () => {
    const pricing = await mapProvider(Number('90071992547409.93'))
    const rows = functionRows(pricing, IDS)
    const normal = rows.find((r) => r.cardVariantId === NORMAL)
    // Cardmarket's trend was refused as unsafe; the chain falls through — never a rounded number.
    expect(normal?.sourceValueMinor).not.toBe(Number(2n ** 53n))
    expect(normal?.observations.every((o) => BigInt(o.valueMinor) < 2n ** 53n)).toBe(true)
    const map = releasedClientMapping(bodyText(rows))
    for (const value of map.values() as Iterable<{ sourceValueMinor: bigint | null }>) {
      expect(value.sourceValueMinor === null || value.sourceValueMinor < 2n ** 53n).toBe(true)
    }
  })
})

describe('candidate client + released function (no `observations`)', () => {
  it('Price Check shows the single headline value, marks it partial, and the existing consumer still reads it', async () => {
    const rows = functionRows(await mapProvider(12.34), IDS).map((row) => {
      const legacyRow: Record<string, unknown> = { ...row }
      delete legacyRow['observations']
      return legacyRow
    })
    useClientReturning(bodyText(rows))
    const response = await fetchCardPriceResponse(CARD, { invoke: realInvoke })
    const { section, headlineOnly } = buildRawSection(response, variantOf(NORMAL, 'normal'))
    expect(headlineOnly).toBe(true)
    expect(section.observations.map((o) => [o.provider, o.price.minorUnits])).toEqual([
      ['tcgdex_cardmarket', 1234n],
    ])
    const map = await searchPrices([CARD], true)
    expect(map.get(NORMAL)?.sourceValueMinor).toBe(1234n)
  })

  it('candidate client + candidate function: both providers, exact', async () => {
    useClientReturning(bodyText(functionRows(await mapProvider(12.34), IDS)))
    const response = await fetchCardPriceResponse(CARD, { invoke: realInvoke })
    const { section, headlineOnly } = buildRawSection(response, variantOf(NORMAL, 'normal'))
    expect(headlineOnly).toBe(false)
    expect(
      section.observations.map((o) => [o.provider, o.price.minorUnits, o.price.currency]),
    ).toEqual([
      ['tcgdex_cardmarket', 1234n, 'EUR'],
      ['tcgdex_tcgplayer', 1500n, 'USD'],
    ])
  })
})

describe('candidate client + a LEGACY emission (a function that still sends an unsafe JSON number)', () => {
  // What the released mapper would have produced for an absurd price: a candidate with the exact
  // bigint, whose headline field then goes through `Number(...)` and is already rounded on the wire.
  const legacyMatch = {
    finish: 'normal' as const,
    stamp: '',
    subtype: '',
    size: 'standard',
    cardmarket: {
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: 9007199254740993n,
      providerUpdatedAt: '2026-09-20T08:03:04Z',
    },
    tcgplayer: null,
  }
  const legacyRow = (withObservations: boolean) => ({
    cardVariantId: NORMAL,
    cardId: CARD,
    priceState: 'available',
    provider: legacyMatch.cardmarket.provider,
    priceKind: legacyMatch.cardmarket.priceKind,
    sourceCurrency: 'EUR',
    sourceValueMinor: Number(legacyMatch.cardmarket.valueMinor), // 9007199254740992 — rounded
    valueNokMinor: null,
    providerUpdatedAt: legacyMatch.cardmarket.providerUpdatedAt,
    ...(withObservations ? { observations: observationsForVariant(legacyMatch as never) } : {}),
  })

  it('the emitted headline really is an unsafe bare JSON number (the premise)', () => {
    expect(bodyText([legacyRow(false)])).toContain('"sourceValueMinor":9007199254740992,')
  })

  it.each([false, true])(
    'is refused as a whole (observations present: %s) — never shown, never BigInt(roundedNumber)',
    async (withObservations) => {
      useClientReturning(bodyText([legacyRow(withObservations)]))
      await expect(fetchCardPriceResponse(CARD, { invoke: realInvoke })).rejects.toMatchObject({
        name: 'PriceCheckError',
        reason: 'malformed_response',
      })
    },
  )

  it('the existing pricing consumer (search / card detail) shows NO price for it instead of the rounded one', async () => {
    useClientReturning(bodyText([legacyRow(false)]))
    // Without the marker check this returned sourceValueMinor 9007199254740992n: the guard quotes
    // the bare number and `parseNullableMinorUnits` accepts the digits it can no longer vouch for.
    expect((await searchPrices([CARD], true)).size).toBe(0)
  })

  it('and it still shows a conforming price (a marker only ever follows an unsafe literal)', async () => {
    useClientReturning(bodyText(functionRows(await mapProvider(12.34), IDS)))
    expect((await searchPrices([CARD], true)).get(NORMAL)?.sourceValueMinor).toBe(1234n)
  })
})

describe('the row expressions mirrored above are the function’s own', () => {
  const source = readFileSync(
    new URL('../../supabase/functions/search-prices/index.ts', import.meta.url),
    'utf8',
  )
  it.each([
    'sourceValueMinor: chosen ? Number(chosen.valueMinor) : null,',
    'observations: perRowObservations.get(row.id) ?? [],',
    'perRowObservations.set(row.id, observationsForVariant(match))',
    'const primary = useEuPricing ? match?.cardmarket : match?.tcgplayer',
    'perRowChosen.set(row.id, primary ?? secondary ?? null)',
  ])('%s', (expression) => {
    expect(source).toContain(expression)
  })
})
