import { deferred, detail, flush, harness, row, session, type Deferred } from '../support/fakes'
import type { CollectionPage } from '../../src/collection/types'

/**
 * The account-isolation contract of the native client, tested through the REAL composition root
 * (createRuntime) with fakes for I/O only. Each test names the failure it exists to catch; the same
 * behaviours are re-proved against a real GoTrue in tests/backend/identity.test.ts.
 */

function pageOf(...ids: string[]): CollectionPage {
  return { rows: ids.map((id) => row(id)), nextCursor: null }
}

describe('A -> B isolation', () => {
  it('user A rows are gone the instant B is signed in, not after a fetch completes', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.collection.pages.push(pageOf('a1', 'a2'))
    await h.runtime.collection.load()
    expect(h.runtime.collection.getSnapshot().rows.map((r) => r.holdingId)).toEqual(['a1', 'a2'])

    const seen: string[][] = []
    h.runtime.collection.subscribe(() =>
      seen.push(h.runtime.collection.getSnapshot().rows.map((r) => r.holdingId)),
    )
    h.auth.emit('SIGNED_IN', session('B')) // direct switch, no signed-out state in between

    expect(h.runtime.collection.getSnapshot().rows).toEqual([])
    expect(h.runtime.collection.getSnapshot().status).toBe('idle')
    expect(seen.every((rows) => rows.length === 0)).toBe(true)
  })

  it('a response for A that arrives AFTER B signed in is discarded (never shown under B)', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const inflight: Deferred<CollectionPage> = deferred()
    h.collection.pending.push(inflight)
    const load = h.runtime.collection.load()
    await flush()

    h.auth.emit('SIGNED_IN', session('B'))
    inflight.resolve(pageOf('a-late'))
    await load
    await flush()

    const state = h.runtime.collection.getSnapshot()
    expect(state.rows).toEqual([])
    expect(state.status).toBe('idle')
  })

  it('a FAILURE for A that arrives after B signed in is discarded too', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const inflight: Deferred<CollectionPage> = deferred()
    h.collection.pending.push(inflight)
    const load = h.runtime.collection.load()
    await flush()
    h.auth.emit('SIGNED_IN', session('B'))
    inflight.reject(new Error('boom'))
    await load
    expect(h.runtime.collection.getSnapshot().status).toBe('idle')
    expect(h.runtime.collection.getSnapshot().failure).toBeNull()
  })

  it('a holding-detail response for A after B signed in is discarded', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const d = deferred<ReturnType<typeof detail> | null>()
    h.collection.detailPending.set('a1', d)
    const load = h.runtime.holdingDetail.load('a1')
    await flush()
    h.auth.emit('SIGNED_IN', session('B'))
    d.resolve(detail('a1'))
    await load
    expect(h.runtime.holdingDetail.getSnapshot()).toMatchObject({ status: 'idle', detail: null })
  })

  it('A -> B -> A: the second A session starts empty (the first session state is not reused)', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.collection.pages.push(pageOf('a1'))
    await h.runtime.collection.load()
    h.auth.emit('SIGNED_IN', session('B'))
    h.collection.pages.push(pageOf('b1'))
    await h.runtime.collection.load()
    expect(h.runtime.collection.getSnapshot().rows.map((r) => r.holdingId)).toEqual(['b1'])
    h.auth.emit('SIGNED_IN', session('A'))
    expect(h.runtime.collection.getSnapshot().rows).toEqual([])
    expect(h.runtime.authority.epoch).toBe(3)
  })

  it('A -> B -> A: an operation started in the FIRST A session cannot land in the second', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const first: Deferred<CollectionPage> = deferred()
    h.collection.pending.push(first)
    const load = h.runtime.collection.load()
    await flush()
    h.auth.emit('SIGNED_IN', session('B'))
    h.auth.emit('SIGNED_IN', session('A'))
    first.resolve(pageOf('a-first-session'))
    await load
    expect(h.runtime.collection.getSnapshot().rows).toEqual([])
  })

  it('sign-out clears every user-scoped store, drafts and the photo', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.collection.pages.push(pageOf('a1'))
    await h.runtime.collection.load()
    h.runtime.priceCheck.setQuery('pikachu')
    h.photo.outcome = {
      status: 'picked',
      image: {
        kind: 'local_image',
        uri: 'file:///cache/a.jpg',
        width: 10,
        height: 20,
        source: 'library',
        acquiredAt: 't',
      },
    }
    await h.runtime.photo.acquire('library')
    expect(h.runtime.photo.getSnapshot().status).toBe('ready')

    await h.runtime.auth.signOut()

    expect(h.runtime.collection.getSnapshot().rows).toEqual([])
    expect(h.runtime.priceCheck.getSnapshot().query).toBe('')
    expect(h.runtime.photo.getSnapshot().image).toBeNull()
    await flush()
    expect(h.photo.deleted).toEqual(['file:///cache/a.jpg'])
    expect(h.removed()).toBe(1)
  })

  it('an image that arrives after the identity changed is deleted, never kept', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.photo.pending = deferred()
    const p = h.runtime.photo.acquire('camera')
    await flush()
    h.auth.emit('SIGNED_IN', session('B'))
    h.photo.pending.resolve({
      status: 'picked',
      image: {
        kind: 'local_image',
        uri: 'file:///cache/late.jpg',
        width: 1,
        height: 1,
        source: 'camera',
        acquiredAt: 't',
      },
    })
    await p
    expect(h.runtime.photo.getSnapshot().image).toBeNull()
    expect(h.photo.deleted).toEqual(['file:///cache/late.jpg'])
  })
})

describe('same-user token refresh preserves unsaved work', () => {
  it('rows, the typed query and the chosen variant survive TOKEN_REFRESHED / USER_UPDATED / repeated SIGNED_IN', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.collection.pages.push(pageOf('a1', 'a2'))
    await h.runtime.collection.load()
    h.runtime.priceCheck.setQuery('fixture twin')
    await h.runtime.priceCheck.search()
    await h.runtime.priceCheck.openCard('fixture-card-twin')
    await h.runtime.priceCheck.chooseVariant('fixture-variant-twin-holo')
    const before = h.runtime.priceCheck.getSnapshot()

    h.auth.emit('TOKEN_REFRESHED', session('A'))
    h.auth.emit('USER_UPDATED', session('A'))
    h.auth.emit('SIGNED_IN', session('A'))

    expect(h.runtime.collection.getSnapshot().rows).toHaveLength(2)
    const after = h.runtime.priceCheck.getSnapshot()
    expect(after.query).toBe('fixture twin')
    expect(after.requestedVariantId).toBe('fixture-variant-twin-holo')
    expect(after).toBe(before) // not even re-created
  })

  it('a load that is in flight across a token refresh still lands', async () => {
    const h = harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const inflight: Deferred<CollectionPage> = deferred()
    h.collection.pending.push(inflight)
    const load = h.runtime.collection.load()
    await flush()
    h.auth.emit('TOKEN_REFRESHED', session('A'))
    inflight.resolve(pageOf('a1'))
    await load
    expect(h.runtime.collection.getSnapshot().rows.map((r) => r.holdingId)).toEqual(['a1'])
  })
})
