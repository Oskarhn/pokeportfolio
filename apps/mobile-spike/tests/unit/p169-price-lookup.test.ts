import { convert } from '@shared/domain/fx'
import { PriceLookupError } from '../../src/features/price-check/model'
import { PriceLookupService } from '../../src/features/price-check/price-lookup'
import { EXACT_TRANSPORT_REWRITE_HEADER } from '../../src/features/price-check/search-prices-source'
import {
  FakeInvoker,
  NOW,
  STANDARD_FX,
  body,
  card,
  daysAgo,
  fakeFx,
  obs,
  variant,
} from '../support/p169-fakes'

/**
 * The P169 price adapter over a scripted search-prices invoker. Every rule it relies on comes from
 * the vendored P165 domain; these tests check the native wiring around it: contracts, NOK
 * references, cache keys, failures, and that nothing is ever shown as a zero it is not.
 */

const C = card('card-1', { name: 'P169 Pikachu' })
const V = variant('v-normal')

function service(invoker: FakeInvoker, fx = fakeFx(STANDARD_FX), now = () => NOW) {
  const snapshots = new Map<
    string,
    { snapshotDate: string; valueNokMinor: bigint; provider: string | null }[]
  >()
  const s = new PriceLookupService({
    invoke: invoker.invoke,
    readFx: fx,
    readSnapshots: (id) => Promise.resolve(snapshots.get(id) ?? []),
    now,
  })
  return { s, snapshots, fx }
}

async function rejection(p: Promise<unknown>): Promise<PriceLookupError> {
  try {
    await p
  } catch (e) {
    if (e instanceof PriceLookupError) return e
    throw e
  }
  throw new Error('expected a rejection')
}

describe('search-prices observations (P165 candidate contract)', () => {
  it('shows every provider value of the exact printing with exact NOK references', async () => {
    const inv = new FakeInvoker()
    inv.answer(
      C.cardId,
      body({ [V.variantId]: [obs('tcgdex_cardmarket', '420'), obs('tcgdex_tcgplayer', '500')] }),
    )
    const { s } = service(inv)
    const r = await s.lookup('search_prices', C, V)
    expect(r.raw.status).toBe('observations')
    if (r.raw.status !== 'observations') return
    expect(r.raw.contract).toBe('search_prices_observations')
    const [cm, tp] = r.raw.rows
    expect(cm?.observation.price).toEqual({ minorUnits: 420n, currency: 'EUR' })
    expect(tp?.observation.price).toEqual({ minorUnits: 500n, currency: 'USD' })
    expect(cm?.nok).toMatchObject({
      status: 'converted',
      nok: { minorUnits: 4830n, currency: 'NOK' },
    })
    expect(tp?.nok).toMatchObject({
      status: 'converted',
      nok: { minorUnits: 5250n, currency: 'NOK' },
    })
    expect(cm?.freshness).toBe('fresh')
  })

  it('keeps 2^58 and 2^53+1 exact and converts above 2^53 exactly (never via Number)', async () => {
    const inv = new FakeInvoker()
    inv.answer(
      C.cardId,
      body({
        [V.variantId]: [
          obs('tcgdex_cardmarket', '288230376151711744'),
          obs('tcgdex_tcgplayer', '9007199254740993'),
        ],
      }),
    )
    const { s } = service(inv)
    const r = await s.lookup('search_prices', C, V)
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.rows[0]?.observation.price.minorUnits).toBe(288230376151711744n)
    expect(r.raw.rows[1]?.observation.price.minorUnits).toBe(9007199254740993n)
    const expected = convert({ minorUnits: 288230376151711744n, currency: 'EUR' }, '11.5', 'NOK')
    expect(r.raw.rows[0]?.nok).toMatchObject({ status: 'converted', nok: expected })
    expect(expected.minorUnits).toBe(3314649325744685056n)
  })

  it('an explicit provider zero is a real zero; no observation is "no price", not zero', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, body({ [V.variantId]: [obs('tcgdex_cardmarket', '0')], other: [] }))
    const { s } = service(inv)
    const zero = await s.lookup('search_prices', C, V)
    if (zero.raw.status !== 'observations') throw new Error(zero.raw.status)
    expect(zero.raw.rows[0]?.observation.price.minorUnits).toBe(0n)

    const inv2 = new FakeInvoker()
    inv2.answer(C.cardId, body({ [V.variantId]: [] }))
    const none = await service(inv2).s.lookup('search_prices', C, V)
    expect(none.raw).toMatchObject({ status: 'unavailable', reason: 'no_variant_price' })
  })

  it('refuses malformed and unsafe values instead of repairing them, and says so', async () => {
    const inv = new FakeInvoker()
    inv.answer(
      C.cardId,
      body({
        [V.variantId]: [
          obs('tcgdex_cardmarket', '-9007199254740993'),
          obs('tcgdex_cardmarket', Number('9007199254740993')),
          obs('tcgdex_cardmarket', '12.5'),
          obs('tcgdex_cardmarket', '1', null, { sourceCurrency: 'JPY' }),
          obs('tcgdex_tcgplayer', '777'),
        ],
      }),
    )
    const r = await service(inv).s.lookup('search_prices', C, V)
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.rows).toHaveLength(1)
    expect(r.raw.dropped.map((d) => d.reason)).toEqual([
      'malformed_price',
      'malformed_price',
      'malformed_price',
      'currency_mismatch',
    ])
  })

  it('everything refused -> malformed_response, not "no price"', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, body({ [V.variantId]: [obs('tcgdex_cardmarket', 'abc')] }))
    const r = await service(inv).s.lookup('search_prices', C, V)
    expect(r.raw).toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('released function (no observations field): ONE headline value, labelled partial', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, {
      ok: true,
      providerErrorCount: 0,
      results: [
        {
          cardVariantId: V.variantId,
          provider: 'tcgdex_cardmarket',
          priceKind: 'cm_trend',
          sourceCurrency: 'EUR',
          sourceValueMinor: 150,
          valueNokMinor: '1725',
          providerUpdatedAt: daysAgo(1),
        },
      ],
    })
    const r = await service(inv).s.lookup('search_prices', C, V)
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.contract).toBe('search_prices_headline_only')
    expect(r.raw.rows).toHaveLength(1)
    expect(r.raw.rows[0]?.observation.price.minorUnits).toBe(150n)
  })

  it('provider failure is provider_error (not no-price) and is NOT cached', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, body({ [V.variantId]: [] }, 1))
    const { s } = service(inv)
    expect((await s.lookup('search_prices', C, V)).raw).toMatchObject({
      status: 'unavailable',
      reason: 'provider_error',
    })
    await s.lookup('search_prices', C, V)
    expect(inv.calls).toHaveLength(2)
  })

  it('a printing missing from the response never borrows another printing', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, body({ 'v-other': [obs('tcgdex_cardmarket', '999')] }))
    const r = await service(inv).s.lookup('search_prices', C, V)
    expect(r.raw).toMatchObject({ status: 'unavailable', reason: 'variant_not_in_response' })
  })

  it('freshness comes from the provider timestamp: 10 days stale, 45 outdated, none unknown', async () => {
    const inv = new FakeInvoker()
    inv.answer(
      C.cardId,
      body({
        [V.variantId]: [
          obs('tcgdex_cardmarket', '777', daysAgo(10)),
          obs('tcgdex_tcgplayer', '888', null),
        ],
      }),
    )
    const r = await service(inv).s.lookup('search_prices', C, V)
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.rows.map((x) => [x.freshness, x.ageDays])).toEqual([
      ['stale', 10],
      ['unknown', null],
    ])
    const inv2 = new FakeInvoker()
    inv2.answer(C.cardId, body({ [V.variantId]: [obs('tcgdex_cardmarket', '1', daysAgo(45))] }))
    const r2 = await service(inv2).s.lookup('search_prices', C, V)
    if (r2.raw.status !== 'observations') throw new Error(r2.raw.status)
    expect(r2.raw.rows[0]?.freshness).toBe('outdated')
  })
})

describe('FX reference: never invented', () => {
  it('missing rate -> source currency only; malformed rate is distinct; failed READ is flagged', async () => {
    const inv = new FakeInvoker()
    inv.answer(
      C.cardId,
      body({ [V.variantId]: [obs('tcgdex_cardmarket', '100'), obs('tcgdex_tcgplayer', '100')] }),
    )
    const fx = fakeFx({ EUR: { rate: '1e3', rate_date: '2026-09-25' }, USD: 'error' })
    const r = await service(inv, fx).s.lookup('search_prices', C, V)
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.rows[0]?.nok).toEqual({ status: 'unavailable', reason: 'fx_malformed' })
    expect(r.raw.rows[1]?.nok).toEqual({ status: 'unavailable', reason: 'fx_missing' })
    expect(r.raw.rows[1]?.fxReadFailed).toBe(true)
    expect(r.raw.rows[1]?.observation.price.minorUnits).toBe(100n)

    const inv2 = new FakeInvoker()
    inv2.answer(C.cardId, body({ [V.variantId]: [obs('tcgdex_tcgplayer', '100')] }))
    const r2 = await service(inv2, fakeFx({})).s.lookup('search_prices', C, V)
    if (r2.raw.status !== 'observations') throw new Error(r2.raw.status)
    expect(r2.raw.rows[0]).toMatchObject({
      nok: { status: 'unavailable', reason: 'fx_missing' },
      fxReadFailed: false,
    })
  })

  it('a rate older than a week is flagged, one read per currency', async () => {
    const inv = new FakeInvoker()
    inv.answer(
      C.cardId,
      body({
        [V.variantId]: [
          obs('tcgdex_cardmarket', '100'),
          obs('tcgdex_cardmarket', '5', null, { priceKind: 'cm_avg30' }),
        ],
      }),
    )
    const fx = fakeFx({ EUR: { rate: 11.5, rate_date: '2026-09-10' } })
    const r = await service(inv, fx).s.lookup('search_prices', C, V)
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.rows.every((x) => x.fxRateStale)).toBe(true)
    expect(fx.calls).toEqual(['EUR'])
  })
})

describe('cache keys and identity', () => {
  it('one provider call per CARD: switching printing reuses it; a cached answer keeps its fetchedAt', async () => {
    let now = NOW
    const inv = new FakeInvoker()
    const V2 = variant('v-reverse', { finish: 'reverse' })
    inv.answer(
      C.cardId,
      body({
        [V.variantId]: [obs('tcgdex_cardmarket', '150')],
        [V2.variantId]: [obs('tcgdex_cardmarket', '420')],
      }),
    )
    const { s } = service(inv, fakeFx(STANDARD_FX), () => now)
    const first = await s.lookup('search_prices', C, V)
    now += 60_000
    const second = await s.lookup('search_prices', C, V2)
    expect(inv.calls).toHaveLength(1)
    expect(second.raw.fromCache).toBe(true)
    expect(second.raw.fetchedAt).toBe(first.raw.fetchedAt)
    if (second.raw.status !== 'observations') throw new Error(second.raw.status)
    expect(second.raw.rows[0]?.observation.price.minorUnits).toBe(420n)
  })

  it('two cards with the SAME name and number in different sets never share a price', async () => {
    const inv = new FakeInvoker()
    const base = card('base-025', {
      name: 'P169 Pikachu',
      collectorNumber: '025',
      setName: 'P169 Base Set',
    })
    const reprint = card('reprint-025', {
      name: 'P169 Pikachu',
      collectorNumber: '025',
      setName: 'P169 Legends Reprint',
    })
    inv.answer(base.cardId, body({ vb: [obs('tcgdex_cardmarket', '150')] }))
    inv.answer(reprint.cardId, body({ vr: [obs('tcgdex_cardmarket', '30')] }))
    const { s } = service(inv)
    await s.lookup('search_prices', base, variant('vb'))
    const r = await s.lookup('search_prices', reprint, variant('vr'))
    expect(inv.calls.map((c) => c.cardIds[0])).toEqual(['base-025', 'reprint-025'])
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.rows[0]?.observation.price.minorUnits).toBe(30n)
  })

  it('reset() (identity change) forgets every cached answer', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, body({ [V.variantId]: [obs('tcgdex_cardmarket', '150')] }))
    const { s } = service(inv)
    await s.lookup('search_prices', C, V)
    s.reset()
    await s.lookup('search_prices', C, V)
    expect(inv.calls).toHaveLength(2)
  })

  it('an answer that lands after reset() does not refill the cache', async () => {
    const inv = new FakeInvoker()
    const held = inv.hold()
    const { s } = service(inv)
    const p = s.lookup('search_prices', C, V)
    s.reset()
    held.resolve({ data: body({ [V.variantId]: [obs('tcgdex_cardmarket', '150')] }), error: null })
    await p
    inv.answer(C.cardId, body({ [V.variantId]: [obs('tcgdex_cardmarket', '999')] }))
    const r = await s.lookup('search_prices', C, V)
    expect(inv.calls).toHaveLength(2)
    if (r.raw.status !== 'observations') throw new Error(r.raw.status)
    expect(r.raw.rows[0]?.observation.price.minorUnits).toBe(999n)
  })
})

describe('failures are distinguishable', () => {
  const http = (status: number) => ({ name: 'FunctionsHttpError', context: { status } })
  it.each([
    [http(401), 'unauthorized'],
    [http(429), 'rate_limited'],
    [http(404), 'not_found'],
    [http(500), 'provider_error'],
    [{ name: 'FunctionsRelayError' }, 'provider_error'],
    [
      {
        name: 'FunctionsFetchError',
        context: { name: 'TypeError', message: 'Network request failed' },
      },
      'network',
    ],
    [
      { name: 'FunctionsFetchError', context: { name: 'UnsafeNumericResponseError' } },
      'malformed_response',
    ],
    [{ name: 'FunctionsFetchError', context: { name: 'WriteRefusedError' } }, 'write_refused'],
  ])('%j -> %s', async (error, reason) => {
    const inv = new FakeInvoker()
    inv.fail(C.cardId, error)
    expect((await rejection(service(inv).s.lookup('search_prices', C, V))).reason).toBe(reason)
  })

  it('a response whose numbers were rewritten in transit is refused (D-164)', async () => {
    const inv = new FakeInvoker()
    inv.byCard.set(C.cardId, {
      data: body({ [V.variantId]: [obs('tcgdex_cardmarket', '9007199254740993')] }),
      error: null,
      response: {
        headers: { get: (n: string) => (n === EXACT_TRANSPORT_REWRITE_HEADER ? '1' : null) },
      },
    })
    expect((await rejection(service(inv).s.lookup('search_prices', C, V))).reason).toBe(
      'malformed_response',
    )
  })

  it('a body that is not { ok: true, results: [] } is malformed', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, { ok: false })
    expect((await rejection(service(inv).s.lookup('search_prices', C, V))).reason).toBe(
      'malformed_response',
    )
  })
})

describe('graded and snapshots', () => {
  it('graded is ALWAYS not configured, never derived from a raw price', async () => {
    const inv = new FakeInvoker()
    inv.answer(C.cardId, body({ [V.variantId]: [obs('tcgdex_cardmarket', '100000')] }))
    const r = await service(inv).s.lookup('search_prices', C, V)
    expect(r.graded).toEqual({
      status: 'unavailable',
      observations: [],
      unavailable: 'graded_source_not_configured',
      dropped: [],
      sources: [],
    })
  })

  it('released snapshot RPC: server NOK exact above 2^53, provider named, freshness from the date', async () => {
    const inv = new FakeInvoker()
    const { s, snapshots } = service(inv)
    snapshots.set(V.variantId, [
      { snapshotDate: '2026-09-20', valueNokMinor: 1n, provider: 'tcgdex_cardmarket' },
      {
        snapshotDate: '2026-09-25',
        valueNokMinor: 11358024692635798n,
        provider: 'tcgdex_cardmarket',
      },
    ])
    const r = await s.lookup('snapshot_rpc', C, V)
    expect(inv.calls).toHaveLength(0)
    expect(r.raw).toMatchObject({
      status: 'snapshot',
      contract: 'released_snapshot_rpc',
      headlines: [
        {
          provider: 'tcgdex_cardmarket',
          nok: { minorUnits: 11358024692635798n, currency: 'NOK' },
          snapshotDate: '2026-09-25',
          freshness: 'fresh',
        },
      ],
    })
    expect((await s.lookup('snapshot_rpc', C, variant('none'))).raw).toMatchObject({
      status: 'unavailable',
      reason: 'no_variant_price',
    })
  })
})
