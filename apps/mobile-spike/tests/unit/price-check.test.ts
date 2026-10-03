import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixturePriceCheckPort } from '../../src/price-check/fixture-adapter'
import { asCurrencyCode, mapObservationsWire } from '../../src/price-check/observation-wire'
import { resolveVariant } from '../../src/price-check/resolve-variant'
import type { PriceCheckPort, PriceLookup, VariantIdentity } from '../../src/price-check/types'
import { formatMoney } from '../../src/money/format-money'
import { deferred, flush, harness, session } from '../support/fakes'

const v = (
  id: string,
  finish: VariantIdentity['finish'] = 'normal',
  isActive = true,
): VariantIdentity => ({
  variantId: id,
  finish,
  stamp: '',
  subtype: '',
  size: 'standard',
  isActive,
})

describe('resolveVariant (same statuses as P153)', () => {
  it('one active variant is confirmed as the only variant', () => {
    expect(resolveVariant([v('n')], undefined)).toMatchObject({
      status: 'confirmed',
      basis: 'only_variant',
    })
  })
  it('several variants and none chosen -> choice_required, NO default', () => {
    expect(resolveVariant([v('n'), v('h', 'holo')], undefined).status).toBe('choice_required')
  })
  it('a chosen variant is confirmed', () => {
    const r = resolveVariant([v('n'), v('h', 'holo')], 'h')
    expect(r).toMatchObject({ status: 'confirmed', basis: 'chosen' })
    if (r.status === 'confirmed') expect(r.variant.variantId).toBe('h')
  })
  it('a requested variant that is not a variant of THIS card is a mismatch and never falls back', () => {
    expect(resolveVariant([v('n')], 'someone-elses')).toMatchObject({
      status: 'mismatch',
      requestedVariantId: 'someone-elses',
    })
  })
  it('no variants; and one active among inactive ones', () => {
    expect(resolveVariant([], undefined).status).toBe('no_variants')
    expect(resolveVariant([v('a', 'normal', false), v('b')], undefined)).toMatchObject({
      status: 'confirmed',
    })
  })
})

describe('observation wire mapper (P153 observations[] shape)', () => {
  const ok = {
    provider: 'tcgdex_cardmarket',
    priceKind: 'cm_trend',
    sourceCurrency: 'EUR',
    valueMinor: '1234',
    providerUpdatedAt: '2026-09-19T10:00:00Z',
  }
  it('keeps the exact source amount and never invents a NOK value', () => {
    const { observations } = mapObservationsWire([ok])
    expect(observations[0]?.source).toEqual({ minorUnits: 1234n, currency: 'EUR' })
    expect(observations[0]?.nok).toBeNull()
    expect(observations[0]?.kind).toBe('index')
    expect(observations[0]?.condition).toBeNull()
  })
  it('an amount above 2^53 is exact (decimal string)', () => {
    const { observations } = mapObservationsWire([{ ...ok, valueMinor: '288230376151711745' }])
    expect(observations[0]?.source?.minorUnits).toBe(288230376151711745n)
  })
  it('zero is shown only when the provider actually reported zero', () => {
    expect(
      mapObservationsWire([{ ...ok, valueMinor: '0' }]).observations[0]?.source?.minorUnits,
    ).toBe(0n)
  })
  it.each([
    ['float', 12.5],
    ['negative', '-5'],
    ['fraction', '12.50'],
    ['exponent', '1e3'],
    ['empty', ''],
    ['whitespace', ' 12'],
    ['null', null],
    ['too long', '9'.repeat(19)],
  ])('drops a malformed price (%s) instead of showing it', (_n, valueMinor) => {
    const r = mapObservationsWire([{ ...ok, valueMinor }])
    expect(r.observations).toHaveLength(0)
    expect(r.dropped[0]?.reason).toBe('malformed_price')
  })
  it('drops an unknown provider / metric and a currency that is not the provider’s own', () => {
    expect(mapObservationsWire([{ ...ok, provider: 'evil' }]).dropped[0]?.reason).toBe(
      'unknown_provider',
    )
    expect(mapObservationsWire([{ ...ok, priceKind: 'weird' }]).dropped[0]?.reason).toBe(
      'unknown_metric',
    )
    expect(mapObservationsWire([{ ...ok, sourceCurrency: 'USD' }]).dropped[0]?.reason).toBe(
      'currency_mismatch',
    )
  })
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'prototype member %s is never a provider, metric or currency',
    (name) => {
      expect(asCurrencyCode(name)).toBeNull()
      expect(mapObservationsWire([{ ...ok, provider: name }]).observations).toHaveLength(0)
      expect(mapObservationsWire([{ ...ok, priceKind: name }]).observations).toHaveLength(0)
    },
  )
})

describe('fixture adapter (synthetic, P153-shaped)', () => {
  const port = createFixturePriceCheckPort()

  it('every observation is marked synthetic-source and the fixture says so', async () => {
    expect(port.sourceKind).toBe('p153_fixture')
    const r = await port.lookup('fixture-card-twin', 'fixture-variant-twin-normal')
    expect(r.status).toBe('available')
  })

  it('two finishes of one card carry DIFFERENT prices (wrong-variant detection)', async () => {
    const normal = (await port.lookup(
      'fixture-card-twin',
      'fixture-variant-twin-normal',
    )) as Extract<PriceLookup, { status: 'available' }>
    const holo = (await port.lookup('fixture-card-twin', 'fixture-variant-twin-holo')) as Extract<
      PriceLookup,
      { status: 'available' }
    >
    expect(normal.observations.map((o) => o.source?.minorUnits)).toEqual([1234n, 1500n])
    expect(holo.observations.map((o) => o.source?.minorUnits)).toEqual([98765n])
  })

  it('NOK reference comes from the shared domain convert() and is exact above 2^53', async () => {
    const r = (await port.lookup('fixture-card-astronomical', 'fixture-variant-astro')) as Extract<
      PriceLookup,
      { status: 'available' }
    >
    // 288230376151711745 EUR-minor x 11.5 = 3314649325744685... (exact half-up), computed by the domain
    expect(r.observations[0]?.nok?.minorUnits).toBe(
      (288230376151711745n * 1150000000n + 50000000n) / 100000000n,
    )
    expect(formatMoney(r.observations[0]?.source ?? null)).toBe('€2,882,303,761,517,117.45')
  })

  it('JPY has zero decimals: 9007199254740993 minor units is 9,007,199,254,740,993 yen', async () => {
    const r = (await port.lookup('fixture-card-jpy', 'fixture-variant-jpy')) as Extract<
      PriceLookup,
      { status: 'available' }
    >
    expect(formatMoney(r.observations[0]?.source ?? null)).toBe('9,007,199,254,740,993 JPY')
    expect(r.observations[0]?.synthetic).toBe(true)
    // 9007199254740993 JPY x 0.07 NOK/JPY, JPY exponent 0 -> NOK exponent 2
    expect(r.observations[0]?.nok?.minorUnits).toBe(
      (9007199254740993n * 7000000n * 100n + 50000000n) / 100000000n,
    )
  })

  it('provider error and no-price are typed unavailable states, never a number', async () => {
    expect(await port.lookup('fixture-card-provider-error', 'fixture-variant-perr')).toMatchObject({
      status: 'unavailable',
      reason: 'provider_error',
    })
    expect(await port.lookup('fixture-card-no-price', 'fixture-variant-noprice')).toMatchObject({
      status: 'unavailable',
      reason: 'no_variant_price',
    })
    expect(await port.lookup('fixture-card-twin', 'fixture-variant-of-another-card')).toMatchObject(
      { status: 'unavailable', reason: 'not_found' },
    )
  })

  it('graded is ALWAYS unavailable (no authorized source), for every lookup', async () => {
    for (const [c, vv] of [
      ['fixture-card-twin', 'fixture-variant-twin-normal'],
      ['fixture-card-provider-error', 'fixture-variant-perr'],
    ] as const) {
      expect((await port.lookup(c, vv)).graded).toEqual({
        status: 'unavailable',
        reason: 'graded_source_not_configured',
      })
    }
  })
})

describe('PriceCheckStore', () => {
  function ready() {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    return h
  }

  it('a card with several variants shows NO price until the person chooses one', async () => {
    const h = ready()
    await h.runtime.priceCheck.openCard('fixture-card-twin')
    const s = h.runtime.priceCheck.getSnapshot()
    expect(s.resolution?.status).toBe('choice_required')
    expect(s.lookup.status).toBe('idle')
    expect(s.lookup.result).toBeNull()
  })

  it('choosing a variant looks up exactly that variant', async () => {
    const h = ready()
    await h.runtime.priceCheck.openCard('fixture-card-twin')
    await h.runtime.priceCheck.chooseVariant('fixture-variant-twin-holo')
    const r = h.runtime.priceCheck.getSnapshot().lookup
    expect(r.key).toBe('fixture-card-twin:fixture-variant-twin-holo')
    expect(
      r.status === 'ready' &&
        r.result?.status === 'available' &&
        r.result.observations[0]?.source?.minorUnits,
    ).toBe(98765n)
  })

  it('switching variant leaves nothing of the previous price', async () => {
    const h = ready()
    await h.runtime.priceCheck.openCard('fixture-card-twin', 'fixture-variant-twin-normal')
    expect(h.runtime.priceCheck.getSnapshot().lookup.status).toBe('ready')
    await h.runtime.priceCheck.chooseVariant('fixture-variant-twin-holo')
    const shown = h.runtime.priceCheck.getSnapshot().lookup.result
    expect(
      shown?.status === 'available' && shown.observations.map((o) => o.source?.minorUnits),
    ).toEqual([98765n])
  })

  it('a variant id from another card is a mismatch: nothing is looked up, nothing guessed', async () => {
    const h = ready()
    await h.runtime.priceCheck.openCard('fixture-card-twin', 'fixture-variant-jpy')
    const s = h.runtime.priceCheck.getSnapshot()
    expect(s.resolution?.status).toBe('mismatch')
    expect(s.lookup.status).toBe('idle')
  })

  it('a lookup that answers after the person chose ANOTHER variant is dropped', async () => {
    const lookups: Record<string, ReturnType<typeof deferred<PriceLookup>>> = {}
    const base = createFixturePriceCheckPort()
    const slowPort: PriceCheckPort = {
      ...base,
      lookup: (c, vid) => (lookups[vid] = deferred<PriceLookup>()).promise,
    }
    const h = harness({ released: slowPort, fixture: slowPort })
    h.auth.emit('SIGNED_IN', session('A'))
    await h.runtime.priceCheck.openCard('fixture-card-twin').catch(() => undefined)
    const first = h.runtime.priceCheck.chooseVariant('fixture-variant-twin-normal')
    await flush()
    const second = h.runtime.priceCheck.chooseVariant('fixture-variant-twin-holo')
    await flush()
    lookups['fixture-variant-twin-holo']?.resolve(
      await base.lookup('fixture-card-twin', 'fixture-variant-twin-holo'),
    )
    await flush()
    lookups['fixture-variant-twin-normal']?.resolve(
      await base.lookup('fixture-card-twin', 'fixture-variant-twin-normal'),
    )
    await Promise.all([first, second])
    const shown = h.runtime.priceCheck.getSnapshot().lookup
    expect(shown.key).toBe('fixture-card-twin:fixture-variant-twin-holo')
    expect(
      shown.result?.status === 'available' && shown.result.observations[0]?.source?.minorUnits,
    ).toBe(98765n)
  })

  it('a slower older SEARCH cannot overwrite a newer one', async () => {
    const slow = deferred<never[]>()
    const base = createFixturePriceCheckPort()
    let n = 0
    const port: PriceCheckPort = {
      ...base,
      searchCards: (q) => (n++ === 0 ? slow.promise : base.searchCards(q)),
    }
    const h = harness({ released: port, fixture: port })
    h.auth.emit('SIGNED_IN', session('A'))
    h.runtime.priceCheck.setQuery('fixture')
    const first = h.runtime.priceCheck.search()
    await flush()
    h.runtime.priceCheck.setQuery('fixture twin')
    await h.runtime.priceCheck.search()
    slow.resolve([])
    await first
    expect(h.runtime.priceCheck.getSnapshot().search.hits.map((x) => x.cardId)).toEqual([
      'fixture-card-twin',
    ])
  })

  it('a query shorter than the minimum does not search', async () => {
    const h = ready()
    h.runtime.priceCheck.setQuery('f')
    await h.runtime.priceCheck.search()
    expect(h.runtime.priceCheck.getSnapshot().search.status).toBe('idle')
  })

  it('a provider outage or a network failure is an error state with a retry, not "no price"', async () => {
    const base = createFixturePriceCheckPort()
    let fail = true
    const port: PriceCheckPort = {
      ...base,
      lookup: (c, vid) =>
        fail ? Promise.reject(new TypeError('Network request failed')) : base.lookup(c, vid),
    }
    const h = harness({ released: port, fixture: port })
    h.auth.emit('SIGNED_IN', session('A'))
    await h.runtime.priceCheck.openCard('fixture-card-no-price')
    expect(h.runtime.priceCheck.getSnapshot().lookup).toMatchObject({
      status: 'error',
      failure: { kind: 'offline' },
    })
    fail = false
    await h.runtime.priceCheck.retryLookup()
    expect(h.runtime.priceCheck.getSnapshot().lookup.status).toBe('ready')
  })

  it('openVariant resolves a variant id to its card and prices exactly that variant', async () => {
    const h = ready()
    await h.runtime.priceCheck.openVariant('fixture-variant-twin-holo')
    const s = h.runtime.priceCheck.getSnapshot()
    expect(s.card.data?.card.cardId).toBe('fixture-card-twin')
    expect(s.lookup.key).toBe('fixture-card-twin:fixture-variant-twin-holo')
  })

  it('an unknown variant id is "not found", not a guess', async () => {
    const h = ready()
    await h.runtime.priceCheck.openVariant('nope')
    expect(h.runtime.priceCheck.getSnapshot().card.status).toBe('not_found')
  })
})

describe('Price Check is read-only (static guard)', () => {
  const FORBIDDEN_IMPORTS =
    /from\s+['"][^'"]*(purchases|sales|opening|reset|sealedProducts|customCollections|retailers|portfolioExport|collection)['"]/
  const FORBIDDEN_CALLS =
    /\.(insert|update|upsert|delete)\s*\(|\.rpc\(\s*['"](create_|update_|delete_|add_|record_|set_|reset_|void_|remove_|import_)/
  const files = [
    ...readdirSync(join(__dirname, '../../src/price-check')).map((f) => join('src/price-check', f)),
    'src/state/price-check-store.ts',
  ]

  it.each(files)('%s imports no ledger data module and calls no write', (file) => {
    const text = readFileSync(join(__dirname, '../..', file), 'utf8')
    expect(text).not.toMatch(FORBIDDEN_IMPORTS)
    expect(text).not.toMatch(FORBIDDEN_CALLS)
  })

  it('the only shared data modules Price Check touches are catalog and pricing', () => {
    const imports = files.flatMap((f) =>
      [
        ...readFileSync(join(__dirname, '../..', f), 'utf8').matchAll(
          /from\s+'(@shared\/data\/[^']+)'/g,
        ),
      ].map((m) => m[1]),
    )
    expect([...new Set(imports)].sort()).toEqual(['@shared/data/catalog', '@shared/data/pricing'])
  })
})
