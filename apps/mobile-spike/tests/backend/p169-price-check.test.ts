import { convert } from '@shared/domain/fx'
import type { PriceCheckFlowState } from '../../src/features/price-check/price-check-flow-store'
import {
  fixture,
  ledgerHashes,
  mockProviderCalls,
  p169Describe,
  p169Session,
  psql,
  signIn,
  until,
  type P169Session,
} from './p169-support'

/**
 * P169 against the REAL isolated local stack (see p169-support.ts). Every price below is the
 * synthetic mock's invented number (scripts/p169/catalog-fixture.mjs), served through the actual
 * search-prices Edge Function code of the P165 candidate (git 3d03eec) or of released main
 * (d8682e0), through the native client's read-only policy and exact-transport guard.
 */

jest.setTimeout(120_000)

const f = () => fixture().catalog
const V = (key: string, printing: string): string => {
  const id = f()[key]?.variants[printing]
  if (id === undefined) throw new Error(`no variant ${key} ${printing}`)
  return id
}
const C = (key: string): string => {
  const id = f()[key]?.cardId
  if (id === undefined) throw new Error(`no card ${key}`)
  return id
}

async function open(s: P169Session, key: string, variant?: string): Promise<PriceCheckFlowState> {
  await s.feature.priceCheck.openCard(C(key), variant === undefined ? undefined : V(key, variant))
  return s.feature.priceCheck.getSnapshot()
}

function rows(state: PriceCheckFlowState) {
  const raw = state.lookup.result?.raw
  if (raw?.status !== 'observations')
    throw new Error(`expected observations, got ${JSON.stringify(raw?.status ?? state.lookup)}`)
  return raw
}

const measured: Record<string, number> = {}

p169Describe('P169 catalog search on the real stack', () => {
  let s: P169Session
  beforeAll(async () => {
    s = p169Session()
    await signIn(s, 'a')
  })
  afterAll(async () => {
    await s.runtime.auth.signOut()
  })

  it('"P169 Pikachu" returns every same-named card with set/number/language to tell them apart', async () => {
    s.feature.search.setQuery('P169 Pikachu')
    const t0 = Date.now()
    await s.feature.search.submit()
    measured.coldSearchMs = Date.now() - t0
    const hits = s.feature.search.getSnapshot().hits
    const pikas = hits.filter((h) => h.name.startsWith('P169 Pikachu'))
    const ids = new Set(pikas.map((h) => h.cardId))
    for (const key of ['pika-base-025', 'pika-reprint-025', 'pika-promo', 'jp-001'])
      expect(ids.has(C(key))).toBe(true)
    const base = hits.find((h) => h.cardId === C('pika-base-025'))
    const reprint = hits.find((h) => h.cardId === C('pika-reprint-025'))
    expect(base).toMatchObject({
      setName: 'P169 Base Set',
      collectorNumber: '025',
      language: 'en',
      activeVariantCount: 2,
      sharesName: true,
    })
    expect(reprint).toMatchObject({
      setName: 'P169 Legends Reprint',
      collectorNumber: '025',
      activeVariantCount: 1,
      sharesName: true,
    })
    expect(hits.find((h) => h.cardId === C('jp-001'))?.language).toBe('ja')
    // Nothing is chosen for the person.
    expect(s.feature.priceCheck.getSnapshot().card.status).toBe('idle')

    const t1 = Date.now()
    s.feature.search.setQuery('P169 Pikachu')
    await s.feature.search.submit()
    measured.warmSearchMs = Date.now() - t1
  })

  it('language filter, set-name match and number match', async () => {
    s.feature.search.setQuery('P169 Pikachu')
    s.feature.search.setLanguage('en')
    await until(() => s.feature.search.getSnapshot().status === 'ready')
    expect(s.feature.search.getSnapshot().hits.some((h) => h.language === 'ja')).toBe(false)
    s.feature.search.setLanguage(null)

    s.feature.search.setQuery('Legends Reprint')
    await s.feature.search.submit()
    expect(s.feature.search.getSnapshot().hits.map((h) => h.cardId)).toContain(
      C('pika-reprint-025'),
    )

    s.feature.search.setQuery('P169 Pikachu 025')
    await s.feature.search.submit()
    const top = s.feature.search
      .getSnapshot()
      .hits.slice(0, 2)
      .map((h) => h.collectorNumber)
    expect(top).toEqual(['025', '025'])
  })

  it('bounded pagination in pages of 25, no duplicate ids, every bulk card reached', async () => {
    s.feature.search.setQuery('P169 Bulk')
    await s.feature.search.submit()
    // search_cards also admits trigram-similar names (> 0.15), so the other "P169 …" cards match too:
    // the total is the SERVER's count, not the 120 bulk cards (recorded as a search finding).
    const total = s.feature.search.getSnapshot().totalCount
    expect(total).toBeGreaterThanOrEqual(120)
    measured.bulkQueryTotal = total
    let guard = 0
    while (s.feature.search.canLoadMore && guard < 10) {
      await s.feature.search.loadMore()
      guard += 1
    }
    const hits = s.feature.search.getSnapshot().hits
    expect(hits).toHaveLength(total)
    expect(new Set(hits.map((h) => h.cardId)).size).toBe(total)
    expect(hits.filter((h) => h.name.startsWith('P169 Bulk'))).toHaveLength(120)
    expect(guard).toBe(Math.ceil(total / 25) - 1)
  })

  it('no match is "empty", not an error', async () => {
    s.feature.search.setQuery('zzqx no such card')
    await s.feature.search.submit()
    expect(s.feature.search.getSnapshot()).toMatchObject({ status: 'empty', hits: [] })
  })
})

p169Describe('P169 Price Check through the P165 CANDIDATE search-prices', () => {
  let s: P169Session
  let before: Record<string, string>
  let providerCallsBefore: number
  beforeAll(async () => {
    before = ledgerHashes()
    providerCallsBefore = await mockProviderCalls()
    s = p169Session()
    await signIn(s, 'a')
  })
  afterAll(async () => {
    await s.runtime.auth.signOut()
  })

  it('two ACTIVE printings: no price until chosen; the chosen one gets both providers, exact NOK', async () => {
    const state = await open(s, 'pika-base-025')
    expect(state.resolution?.status).toBe('choice_required')
    expect(s.log.some((e) => e.path === '/functions/v1/search-prices')).toBe(false)

    const t0 = Date.now()
    await s.feature.priceCheck.chooseVariant(V('pika-base-025', 'reverse|'))
    measured.priceRequestMs = Date.now() - t0
    const raw = rows(s.feature.priceCheck.getSnapshot())
    expect(raw.contract).toBe('search_prices_observations')
    expect(
      raw.rows.map((r) => [
        r.observation.provider,
        r.observation.price.minorUnits,
        r.observation.price.currency,
      ]),
    ).toEqual([
      ['tcgdex_cardmarket', 420n, 'EUR'],
      ['tcgdex_tcgplayer', 500n, 'USD'],
    ])
    expect(
      raw.rows.map((r) => (r.nok.status === 'converted' ? r.nok.nok.minorUnits : null)),
    ).toEqual([4830n, 5250n])
    expect(raw.rows.every((r) => r.freshness === 'fresh' && r.observation.condition === null)).toBe(
      true,
    )
  })

  it('switching printing on the same card reuses the one response (no second provider call)', async () => {
    const calls = s.log.filter((e) => e.path === '/functions/v1/search-prices').length
    const t0 = Date.now()
    await s.feature.priceCheck.chooseVariant(V('pika-base-025', 'normal|'))
    measured.cachedVariantSwitchMs = Date.now() - t0
    expect(s.log.filter((e) => e.path === '/functions/v1/search-prices').length).toBe(calls)
    const raw = rows(s.feature.priceCheck.getSnapshot())
    expect(raw.fromCache).toBe(true)
    expect(raw.rows.map((r) => r.observation.price.minorUnits)).toEqual([150n, 210n])
  })

  it('the same name AND number in another set has its OWN price (no inheritance across sets)', async () => {
    const state = await open(s, 'pika-reprint-025')
    expect(state.resolution).toMatchObject({ status: 'confirmed', basis: 'only_variant' })
    expect(
      rows(s.feature.priceCheck.getSnapshot()).rows.map((r) => r.observation.price.minorUnits),
    ).toEqual([30n, 45n])
  })

  it('a NOK reference above 2^53 is exact and equals the shared-domain conversion', async () => {
    await open(s, 'zard-base-004', 'holo|')
    const [cm] = rows(s.feature.priceCheck.getSnapshot()).rows
    expect(cm?.observation.price).toEqual({ minorUnits: 987654321098765n, currency: 'EUR' })
    const expected = convert({ minorUnits: 987654321098765n, currency: 'EUR' }, '11.5', 'NOK')
    expect(cm?.nok).toMatchObject({ status: 'converted', nok: expected })
    expect(expected.minorUnits).toBe(11358024692635798n)
    expect(expected.minorUnits > 2n ** 53n).toBe(true)
  })

  it('an inactive printing chosen explicitly has no price (honest), not a borrowed one', async () => {
    await open(s, 'zard-base-004', 'normal|')
    expect(s.feature.priceCheck.getSnapshot().lookup.result?.raw).toMatchObject({
      status: 'unavailable',
      reason: 'no_variant_price',
    })
  })

  it('provider zero is a real zero; no price, no provider id and provider failures are distinct states', async () => {
    await open(s, 'zero-099')
    expect(
      rows(s.feature.priceCheck.getSnapshot()).rows.map((r) => r.observation.price.minorUnits),
    ).toEqual([0n, 0n])
    for (const [key, reason] of [
      ['unpriced-098', 'no_variant_price'],
      ['noid-094', 'no_variant_price'],
      ['missing-097', 'provider_error'],
      ['broken-096', 'provider_error'],
      ['huge-092', 'no_variant_price'],
    ] as const) {
      await open(s, key)
      expect([key, s.feature.priceCheck.getSnapshot().lookup.result?.raw]).toMatchObject([
        key,
        { status: 'unavailable', reason },
      ])
    }
  })

  it('freshness comes from the provider: 10 days stale, 45 days outdated', async () => {
    await open(s, 'stale-095')
    expect(
      rows(s.feature.priceCheck.getSnapshot()).rows.map((r) => [r.freshness, r.ageDays]),
    ).toEqual([
      ['stale', 10],
      ['outdated', 45],
    ])
  })

  it('leaving the screen while the provider is slow: aborted, and the late answer never appears', async () => {
    // A single-printing card: openCard starts the lookup at once (the mock delays 4 s).
    const pending = s.feature.priceCheck.openCard(C('slow-093'))
    await until(() => s.feature.priceCheck.getSnapshot().lookup.status === 'loading')
    s.feature.priceCheck.cancel()
    await pending
    await new Promise((r) => setTimeout(r, 5000))
    expect(s.feature.priceCheck.getSnapshot().lookup).toMatchObject({
      status: 'idle',
      result: null,
    })
  })

  it('READ-ONLY: the whole journey sent only allowed reads and changed no ledger row', async () => {
    const allowed =
      /^(GET \/rest\/v1\/(cards|card_variants|fx_rates)|POST \/rest\/v1\/rpc\/search_cards|POST \/functions\/v1\/search-prices|POST \/auth\/v1\/token)$/
    const seen = [...new Set(s.log.map((e) => `${e.method} ${e.path}`))]
    expect(seen.filter((x) => !allowed.test(x))).toEqual([])
    expect(seen).toContain('POST /functions/v1/search-prices')
    // Non-vacuous: at least one successful lookup and one explicit choice happened above.
    expect(ledgerHashes()).toEqual(before)
    const providerCalls = (await mockProviderCalls()) - providerCallsBefore
    measured.providerCalls = providerCalls
    expect(providerCalls).toBeLessThanOrEqual(
      s.log.filter((e) => e.path === '/functions/v1/search-prices').length,
    )
  })
})

p169Describe('P169 against the RELEASED search-prices (main d8682e0)', () => {
  let s: P169Session
  beforeAll(async () => {
    s = p169Session({ functionTarget: 'released' })
    await signIn(s, 'a')
  })
  afterAll(async () => {
    await s.runtime.auth.signOut()
  })

  it('headline only: ONE provider value per printing, labelled partial', async () => {
    await open(s, 'pika-base-025', 'reverse|')
    const raw = rows(s.feature.priceCheck.getSnapshot())
    expect(raw.contract).toBe('search_prices_headline_only')
    expect(raw.rows.map((r) => [r.observation.provider, r.observation.price.minorUnits])).toEqual([
      ['tcgdex_cardmarket', 420n],
    ])
  })

  it('an unsafe JSON number from the released function is refused whole (fail closed), never rounded', async () => {
    await open(s, 'huge-092')
    expect(s.feature.priceCheck.getSnapshot().lookup).toMatchObject({
      status: 'error',
      failure: 'malformed_response',
      retryable: false,
    })
  })
})

p169Describe('P169 released snapshot RPC and the A -> B boundary', () => {
  it('the snapshot RPC is account-specific (A: Cardmarket, B: TCGplayer) and A never leaks into B', async () => {
    const s = p169Session()
    await signIn(s, 'a')
    await s.feature.priceCheck.setSource('snapshot_rpc')
    await open(s, 'pika-base-025', 'normal|')
    expect(s.feature.priceCheck.getSnapshot().lookup.result?.raw).toMatchObject({
      status: 'snapshot',
      headlines: [{ provider: 'tcgdex_cardmarket', nok: { minorUnits: 1725n } }],
    })
    await open(s, 'zard-base-004', 'holo|')
    expect(s.feature.priceCheck.getSnapshot().lookup.result?.raw).toMatchObject({
      headlines: [{ nok: { minorUnits: 11358024692635798n, currency: 'NOK' } }],
    })

    // A -> B while A's slow provider lookup is in flight.
    await s.feature.priceCheck.setSource('search_prices')
    const inflight = s.feature.priceCheck.openCard(C('slow-093'))
    await until(() => s.feature.priceCheck.getSnapshot().lookup.status === 'loading')
    await signIn(s, 'b')
    expect(s.feature.priceCheck.getSnapshot()).toMatchObject({
      card: { status: 'idle' },
      source: 'search_prices',
    })
    expect(s.feature.search.getSnapshot()).toMatchObject({ query: '', hits: [] })
    await inflight
    await new Promise((r) => setTimeout(r, 4500))
    expect(s.feature.priceCheck.getSnapshot().lookup).toMatchObject({
      status: 'idle',
      result: null,
    })

    await s.feature.priceCheck.setSource('snapshot_rpc')
    await open(s, 'pika-base-025', 'normal|')
    const raw = s.feature.priceCheck.getSnapshot().lookup.result?.raw
    expect(raw).toMatchObject({
      status: 'snapshot',
      headlines: [{ provider: 'tcgdex_tcgplayer', nok: { minorUnits: 2205n } }],
      fromCache: false,
    })
    await s.runtime.auth.signOut()
  })
})

p169Describe('P169 stack isolation', () => {
  it('ingest cron jobs are inactive in this project and nothing was queued outbound', () => {
    expect(
      psql(
        "select string_agg(jobname || ':' || active, ',' order by jobname) from cron.job where jobname like 'm9-ingest%';",
      ),
    ).toBe('m9-ingest-fx:false,m9-ingest-prices:false')
    expect(psql('select count(*) from public.environment_ingest_config;')).toBe('0')
    expect(psql('select count(*) from net.http_request_queue;')).toBe('0')
  })

  afterAll(() => {
    console.log(`MEASURED p169 backend (Node, not Hermes) ${JSON.stringify(measured)}`)
  })
})
