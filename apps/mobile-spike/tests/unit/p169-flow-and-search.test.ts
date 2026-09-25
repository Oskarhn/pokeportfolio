import type { SearchPage } from '../../src/features/catalog-search/catalog-search-port'
import { CatalogSearchStore } from '../../src/features/catalog-search/catalog-search-store'
import { deferred, flush, session } from '../support/fakes'
import { body, card, hit, obs, p169Harness, variant } from '../support/p169-fakes'

/**
 * P169 stores through the REAL composition (createRuntime + createP169Feature) with fakes for I/O.
 * Each test names the failure it exists to catch.
 */

const PIKA = card('pika-base', { name: 'P169 Pikachu', collectorNumber: '025' })
const NORMAL = variant('pika-normal')
const REVERSE = variant('pika-reverse', { finish: 'reverse' })

function withPikachu(h: ReturnType<typeof p169Harness>) {
  h.cards.set(PIKA.cardId, { card: PIKA, variants: [NORMAL, REVERSE] })
  h.invoker.answer(
    PIKA.cardId,
    body({
      [NORMAL.variantId]: [obs('tcgdex_cardmarket', '150')],
      [REVERSE.variantId]: [obs('tcgdex_cardmarket', '420')],
    }),
  )
}

describe('printing confirmation', () => {
  it('several ACTIVE printings: choice required, and NO price request until the person chooses', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    await h.feature.priceCheck.openCard(PIKA.cardId)
    const s = h.feature.priceCheck.getSnapshot()
    expect(s.resolution?.status).toBe('choice_required')
    expect(s.lookup.status).toBe('idle')
    expect(h.invoker.calls).toHaveLength(0)
    expect(h.feature.priceCheck.addToCollectionIntent()).toBeNull()

    await h.feature.priceCheck.chooseVariant(REVERSE.variantId)
    const after = h.feature.priceCheck.getSnapshot()
    expect(after.resolution).toMatchObject({ status: 'confirmed', basis: 'chosen' })
    const raw = after.lookup.result?.raw
    expect(raw?.status === 'observations' && raw.rows[0]?.observation.price.minorUnits).toBe(420n)
  })

  it('one active printing is confirmed as only_variant and looked up; an inactive one does not count', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const c = card('single')
    const active = variant('active')
    h.cards.set(c.cardId, {
      card: c,
      variants: [active, variant('old', { isActive: false, finish: 'holo' })],
    })
    h.invoker.answer(c.cardId, body({ active: [obs('tcgdex_cardmarket', '30')] }))
    await h.feature.priceCheck.openCard(c.cardId)
    expect(h.feature.priceCheck.getSnapshot().resolution).toMatchObject({
      status: 'confirmed',
      basis: 'only_variant',
    })
    expect(h.feature.priceCheck.getSnapshot().lookup.status).toBe('ready')
  })

  it('a variant id from another card is a mismatch, never a fallback', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    await h.feature.priceCheck.openCard(PIKA.cardId, 'not-a-pikachu-variant')
    expect(h.feature.priceCheck.getSnapshot().resolution?.status).toBe('mismatch')
    expect(h.invoker.calls).toHaveLength(0)
  })

  it('switching printing while a lookup is in flight drops the old answer', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    await h.feature.priceCheck.openCard(PIKA.cardId)
    const held = h.invoker.hold()
    const first = h.feature.priceCheck.chooseVariant(NORMAL.variantId)
    await flush()
    const second = h.feature.priceCheck.chooseVariant(REVERSE.variantId)
    held.resolve({
      data: body({ [NORMAL.variantId]: [obs('tcgdex_cardmarket', '150')] }),
      error: null,
    })
    await Promise.all([first, second])
    const s = h.feature.priceCheck.getSnapshot()
    expect(s.lookup.key).toBe(`search_prices:${PIKA.cardId}:${REVERSE.variantId}`)
    const raw = s.lookup.result?.raw
    expect(raw?.status === 'observations' && raw.rows[0]?.observation.price.minorUnits).toBe(420n)
    expect(h.invoker.calls[0]?.signal?.aborted).toBe(true)
  })

  it('cancel() (leaving the screen) aborts the request and a late answer is never published', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    await h.feature.priceCheck.openCard(PIKA.cardId)
    const held = h.invoker.hold()
    const p = h.feature.priceCheck.chooseVariant(NORMAL.variantId)
    await flush()
    h.feature.priceCheck.cancel()
    held.resolve({
      data: body({ [NORMAL.variantId]: [obs('tcgdex_cardmarket', '150')] }),
      error: null,
    })
    await p
    await flush()
    expect(h.feature.priceCheck.getSnapshot().lookup).toMatchObject({
      status: 'idle',
      result: null,
    })
    expect(h.invoker.calls[0]?.signal?.aborted).toBe(true)
  })

  it('a provider failure is an error state with retry, and a user-chosen fallback source is labelled', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    h.invoker.fail(PIKA.cardId, { name: 'FunctionsFetchError', context: { name: 'TypeError' } })
    await h.feature.priceCheck.openCard(PIKA.cardId, NORMAL.variantId)
    expect(h.feature.priceCheck.getSnapshot().lookup).toMatchObject({
      status: 'error',
      failure: 'network',
      retryable: true,
    })
    h.snapshots.set(NORMAL.variantId, [
      { snapshotDate: '2026-09-25', valueNokMinor: 1725n, provider: 'tcgdex_cardmarket' },
    ])
    await h.feature.priceCheck.setSource('snapshot_rpc')
    expect(h.feature.priceCheck.getSnapshot().lookup.result?.raw).toMatchObject({
      status: 'snapshot',
      contract: 'released_snapshot_rpc',
    })
  })

  it('Add to collection is an intent only: no request of any kind', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    await h.feature.priceCheck.openCard(PIKA.cardId, NORMAL.variantId)
    const calls = h.invoker.calls.length
    expect(h.feature.priceCheck.addToCollectionIntent()).toEqual({
      kind: 'add_to_collection',
      cardId: PIKA.cardId,
      variantId: NORMAL.variantId,
      requiresConfirmation: true,
    })
    expect(h.invoker.calls.length).toBe(calls)
  })
})

describe('identity boundary (A -> B, A -> B -> A, same-user refresh)', () => {
  it('A -> B during an in-flight price request: A state gone at once, the late answer is dropped', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    await h.feature.priceCheck.openCard(PIKA.cardId)
    const held = h.invoker.hold()
    const p = h.feature.priceCheck.chooseVariant(NORMAL.variantId)
    await flush()
    h.auth.emit('SIGNED_IN', session('B'))
    expect(h.feature.priceCheck.getSnapshot().card.status).toBe('idle')
    held.resolve({
      data: body({ [NORMAL.variantId]: [obs('tcgdex_cardmarket', '150')] }),
      error: null,
    })
    await p
    await flush()
    expect(h.feature.priceCheck.getSnapshot()).toMatchObject({
      lookup: { status: 'idle', result: null },
    })
  })

  it('A -> B during an in-flight SEARCH: results cleared, A answer dropped, B searches fresh', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.catalog.corpus = [hit('a-card', { name: 'P169 Pikachu' })]
    h.feature.search.setQuery('Pikachu')
    await flush(10)
    expect(h.feature.search.getSnapshot().hits).toHaveLength(1)
    const d = deferred<SearchPage>()
    h.catalog.pending.push(d)
    h.feature.search.setQuery('Pikachu 25')
    await flush(10)
    h.auth.emit('SIGNED_IN', session('B'))
    expect(h.feature.search.getSnapshot()).toMatchObject({ query: '', hits: [], status: 'idle' })
    d.resolve({ hits: [], totalCount: 0 })
    await flush(10)
    expect(h.feature.search.getSnapshot()).toMatchObject({ query: '', hits: [], status: 'idle' })
    h.feature.search.setQuery('Pikachu')
    await flush(10)
    expect(h.catalog.calls.at(-1)?.query).toBe('Pikachu')
    expect(h.feature.search.getSnapshot().status).toBe('ready')
  })

  it('A -> B -> A: the second A session does not reuse the first one (cache reset, new request)', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    await h.feature.priceCheck.openCard(PIKA.cardId, NORMAL.variantId)
    expect(h.invoker.calls).toHaveLength(1)
    h.auth.emit('SIGNED_IN', session('B'))
    h.auth.emit('SIGNED_IN', session('A'))
    expect(h.feature.priceCheck.getSnapshot().card.status).toBe('idle')
    await h.feature.priceCheck.openCard(PIKA.cardId, NORMAL.variantId)
    expect(h.invoker.calls).toHaveLength(2)
    expect(h.feature.priceCheck.getSnapshot().lookup.result?.raw.fromCache).toBe(false)
  })

  it('same-user token refresh keeps the draft query, results and the confirmed printing', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    withPikachu(h)
    h.catalog.corpus = [hit('x', { name: 'P169 Pikachu' })]
    h.feature.search.setQuery('Pikachu')
    await flush(10)
    await h.feature.priceCheck.openCard(PIKA.cardId, NORMAL.variantId)
    h.auth.emit('TOKEN_REFRESHED', session('A'))
    expect(h.feature.search.getSnapshot()).toMatchObject({ query: 'Pikachu', status: 'ready' })
    expect(h.feature.priceCheck.getSnapshot().lookup.status).toBe('ready')
  })
})

describe('catalog search', () => {
  function scheduled() {
    const timers: (() => void)[] = []
    return {
      timers,
      schedule: (fn: () => void) => {
        timers.push(fn)
        return timers.length - 1
      },
      cancelSchedule: (handle: unknown) => {
        timers[handle as number] = () => undefined
      },
    }
  }

  it('debounces: typing five characters makes ONE request; fewer than two characters make none', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const t = scheduled()
    const store = new CatalogSearchStore(h.catalog, h.runtime.authority, t)
    store.setQuery('P')
    for (const q of ['Pi', 'Pik', 'Pika', 'Pikac']) store.setQuery(q)
    t.timers.forEach((fn) => fn())
    await flush(10)
    expect(h.catalog.calls.map((c) => c.query)).toEqual(['Pikac'])
  })

  it('a slow answer for an older query never replaces the newer one', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const slow = deferred<SearchPage>()
    h.catalog.pending.push(slow)
    h.catalog.corpus = [hit('new', { name: 'Charizard' })]
    h.feature.search.setQuery('Pikachu')
    const first = h.feature.search.submit()
    h.feature.search.setQuery('Charizard')
    const second = h.feature.search.submit()
    await second
    slow.resolve({ hits: [hit('old', { name: 'Pikachu' })], totalCount: 1 })
    await first
    expect(h.feature.search.getSnapshot().hits.map((x) => x.cardId)).toEqual(['new'])
  })

  it('same name is flagged (set and number tell them apart); nothing is auto-selected', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.catalog.corpus = [
      hit('base', { name: 'P169 Pikachu', setName: 'P169 Base Set', collectorNumber: '025' }),
      hit('reprint', {
        name: 'P169 Pikachu',
        setName: 'P169 Legends Reprint',
        collectorNumber: '025',
      }),
      hit('zard', { name: 'P169 Charizard' }),
    ]
    h.feature.search.setQuery('P169')
    await h.feature.search.submit()
    const s = h.feature.search.getSnapshot()
    expect(s.hits.map((x) => [x.cardId, x.sharesName])).toEqual([
      ['base', true],
      ['reprint', true],
      ['zard', false],
    ])
    expect(h.feature.priceCheck.getSnapshot().card.status).toBe('idle')
  })

  it('pages are bounded, de-duplicated by card id, and capped at maxResults', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.catalog.corpus = Array.from({ length: 120 }, (_, i) =>
      hit(`b${String(i)}`, { name: `Bulk ${String(i)}` }),
    )
    const events: { type: string; count?: number }[] = []
    const store = new CatalogSearchStore(h.catalog, h.runtime.authority, {
      debounceMs: 0,
      pageSize: 25,
      maxResults: 60,
      onEvent: (e) => events.push(e),
    })
    store.setQuery('Bulk')
    await store.submit()
    // The server repeats a tie on the next page (offset paging over a non-unique order).
    const realPage = h.catalog.searchPage.bind(h.catalog)
    h.catalog.searchPage = async (p) => {
      const page = await realPage(p)
      return { ...page, hits: [h.catalog.corpus[p.offset - 1]!, ...page.hits] }
    }
    await store.loadMore()
    await store.loadMore()
    await store.loadMore()
    const s = store.getSnapshot()
    expect(new Set(s.hits.map((x) => x.cardId)).size).toBe(s.hits.length)
    expect(s.hits).toHaveLength(60)
    expect(s.reachedLimit).toBe(true)
    expect(h.catalog.calls.map((c) => c.limit)).toEqual([25, 25, 25])
    expect(events.filter((e) => e.type === 'search_deduped').length).toBeGreaterThan(0)
  })

  it('repeating a query is served from the cache; the cache is dropped with the identity', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.catalog.corpus = [hit('x', { name: 'Pikachu' })]
    h.feature.search.setQuery('Pikachu')
    await h.feature.search.submit()
    h.feature.search.setQuery('Pikachu ')
    await h.feature.search.submit()
    expect(h.catalog.calls).toHaveLength(1)
    h.auth.emit('SIGNED_IN', session('B'))
    h.feature.search.setQuery('Pikachu')
    await h.feature.search.submit()
    expect(h.catalog.calls).toHaveLength(2)
  })

  it('language filter is sent to the server; an error is retryable and shows no stale hits', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.catalog.corpus = [
      hit('jp', { name: 'Pikachu JP', language: 'ja' }),
      hit('en', { name: 'Pikachu' }),
    ]
    h.feature.search.setQuery('Pikachu')
    h.feature.search.setLanguage('ja')
    await flush(10)
    expect(h.catalog.calls.at(-1)?.language).toBe('ja')
    expect(h.feature.search.getSnapshot().hits.map((x) => x.cardId)).toEqual(['jp'])
    h.catalog.searchPage = () => Promise.reject(new TypeError('Network request failed'))
    h.feature.search.setQuery('Pikachu X')
    await h.feature.search.submit()
    expect(h.feature.search.getSnapshot()).toMatchObject({
      status: 'error',
      hits: [],
      failure: { kind: 'offline', retryable: true },
    })
  })
})
