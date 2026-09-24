import { CollectionStore } from '../../src/state/collection-store'
import { IdentityAuthority } from '../../src/auth/identity-authority'
import { deferred, FakeCollectionPort, flush, row } from '../support/fakes'
import type { CollectionPage } from '../../src/collection/types'

function make(pageSize = 3) {
  const port = new FakeCollectionPort()
  const authority = new IdentityAuthority()
  authority.observe('A')
  const store = new CollectionStore(port, authority, pageSize)
  return { port, authority, store }
}

const page = (ids: string[], next: unknown = null): CollectionPage => ({
  rows: ids.map((i) => row(i)),
  nextCursor: next,
})

describe('CollectionStore', () => {
  it('idle -> loading -> ready with the rows and the counts', async () => {
    const { port, store } = make()
    port.countsResult = {
      ...port.countsResult,
      uniqueHoldingCount: 2,
      portfolioValueMinor: 864691128455135235n,
    }
    port.pages.push(page(['a', 'b']))
    const states: string[] = []
    store.subscribe(() => states.push(store.getSnapshot().status))
    expect(store.getSnapshot().status).toBe('idle')
    await store.load()
    expect(states[0]).toBe('loading')
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', done: true })
    expect(store.getSnapshot().counts?.portfolioValueMinor).toBe(864691128455135235n)
  })

  it('an empty collection is the empty state, not an error', async () => {
    const { store } = make()
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ status: 'empty', rows: [] })
  })

  it('a first-page failure is an error state with a classified failure and can be retried', async () => {
    const { port, store } = make()
    port.listError = new TypeError('Network request failed')
    await store.load()
    expect(store.getSnapshot()).toMatchObject({
      status: 'error',
      failure: { kind: 'offline', retryable: true },
    })
    port.listError = null
    port.pages.push(page(['a']))
    await store.load()
    expect(store.getSnapshot().status).toBe('ready')
  })

  it('paginates with the server cursor and never repeats a key (overlapping pages are de-duplicated)', async () => {
    const { port, store } = make(3)
    port.pages.push(page(['a', 'b', 'c'], { after: 'c' }))
    port.pages.push(page(['c', 'd', 'e'], { after: 'e' })) // overlaps on 'c'
    port.pages.push(page(['f'], null))
    await store.load()
    await store.loadMore()
    await store.loadMore()
    const ids = store.getSnapshot().rows.map((r) => r.holdingId)
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(store.getSnapshot().done).toBe(true)
    expect(port.listCalls.map((c) => c.cursor)).toEqual([null, { after: 'c' }, { after: 'e' }])
    // Nothing more to fetch once done.
    await store.loadMore()
    expect(port.listCalls).toHaveLength(3)
  })

  it('a second loadMore while one is in flight is ignored (single flight)', async () => {
    const { port, store } = make(1)
    port.pages.push(page(['a'], 'c1'))
    await store.load()
    const d = deferred<CollectionPage>()
    port.pending.push(d)
    const first = store.loadMore()
    const second = store.loadMore()
    d.resolve(page(['b'], null))
    await Promise.all([first, second])
    expect(port.listCalls).toHaveLength(2)
  })

  it('a failed later page keeps the rows and offers a retry', async () => {
    const { port, store } = make(1)
    port.pages.push(page(['a'], 'c1'))
    await store.load()
    port.listError = new Error('HttpStatusError: HTTP 500 boom')
    await store.loadMore()
    expect(store.getSnapshot().rows).toHaveLength(1)
    expect(store.getSnapshot().failure?.kind).toBe('server')
    port.listError = null
    port.pages.push(page(['b'], null))
    await store.loadMore()
    expect(store.getSnapshot().rows.map((r) => r.holdingId)).toEqual(['a', 'b'])
    expect(store.getSnapshot().failure).toBeNull()
  })

  it('a slow older load cannot overwrite a newer refresh', async () => {
    const { port, store } = make()
    const slow = deferred<CollectionPage>()
    port.pending.push(slow)
    const first = store.load()
    await flush()
    port.pages.push(page(['fresh']))
    await store.load()
    slow.resolve(page(['stale']))
    await first
    expect(store.getSnapshot().rows.map((r) => r.holdingId)).toEqual(['fresh'])
  })

  it('an unsafe numeric response becomes an explicit unavailable state, not a rounded amount', async () => {
    const { port, store } = make()
    const e = new Error(
      'UnsafeNumericResponseError: response contains the JSON number 864691128455135235',
    )
    e.name = 'UnsafeNumericResponseError'
    port.listError = e
    await store.load()
    expect(store.getSnapshot()).toMatchObject({
      status: 'error',
      failure: { kind: 'unsafe_numeric' },
    })
  })

  it('counts failing does not block the list', async () => {
    const { port, store } = make()
    port.countsError = new Error('HttpStatusError: HTTP 500')
    port.pages.push(page(['a']))
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', counts: null })
    expect(store.getSnapshot().countsFailure?.kind).toBe('server')
  })

  it('handles 10,000 holdings: stable unique keys, bounded memory, one page at a time', async () => {
    const { port, store } = make(500)
    for (let p = 0; p < 20; p += 1) {
      const rows = Array.from({ length: 500 }, (_, i) =>
        row(`h${String(p * 500 + i).padStart(5, '0')}`, {
          holdingValueMinor: BigInt(p * 500 + i) * 1000003n,
        }),
      )
      port.pages.push({ rows, nextCursor: p < 19 ? { p } : null })
    }
    if (typeof globalThis.gc === 'function') globalThis.gc()
    const before = process.memoryUsage().heapUsed
    await store.load()
    while (!store.getSnapshot().done) await store.loadMore()
    const ids = store.getSnapshot().rows.map((r) => r.holdingId)
    expect(ids).toHaveLength(10_000)
    expect(new Set(ids).size).toBe(10_000)
    expect(port.listCalls.every((c) => c.limit === 500)).toBe(true)
    const grownMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024
    // A slim row is small. A generous ceiling that still catches "the whole shared tile, twice".
    expect(grownMb).toBeLessThan(40)
  })
})
