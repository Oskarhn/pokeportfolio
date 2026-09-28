import { IdentityAuthority } from '../../src/auth/identity-authority'
import { PendingWritesStore } from '../../src/state/pending-writes-store'
import { hashPendingPayload, PendingWriteJournal } from '../../src/write/pending-write-journal'
import { flush, MemoryKeyValueStore } from '../support/fakes'

/**
 * P180 §13: the store that decides which unresolved pending writes a screen shows — the isolation
 * boundary itself (A -> B must never see A's pending entry, not even for one frame; A -> B -> A
 * must still be able to reconcile its own).
 */
describe('PendingWritesStore', () => {
  it("reset() synchronously clears to the new identity BEFORE reconciliation resolves — never shows a stale identity's list, even for one frame", async () => {
    const authority = new IdentityAuthority()
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'a-key',
      operationKind: 'create_purchase',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    let releaseCheck!: (exists: boolean) => void
    const store = new PendingWritesStore(authority, journal, {
      create_purchase: () => new Promise((resolve) => (releaseCheck = resolve)),
      create_sale: () => Promise.resolve(false),
    })
    authority.observe('A')
    store.reset()
    // Reconciliation for A is still pending (the checker hasn't resolved) — the snapshot must
    // already be A's own EMPTY list, synchronously, not the entry it is still checking.
    expect(store.getSnapshot().userId).toBe('A')
    expect(store.getSnapshot().unresolved).toEqual([])
    await flush()
    releaseCheck(false)
  })

  it("A never sees B's pending entry, and B never sees A's (A -> B)", async () => {
    const authority = new IdentityAuthority()
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'a-key',
      operationKind: 'create_purchase',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    const store = new PendingWritesStore(authority, journal, {
      create_purchase: () => Promise.resolve(false), // confirmed absent -> stays unresolved
      create_sale: () => Promise.resolve(false),
    })
    authority.observe('A')
    store.reset()
    await flush()
    expect(store.getSnapshot().unresolved.map((e) => e.idempotencyKey)).toEqual(['a-key'])

    authority.observe('B') // A -> B
    store.reset()
    expect(store.getSnapshot().userId).toBe('B')
    expect(store.getSnapshot().unresolved).toEqual([]) // B never sees A's entry, sync or async
    await flush()
    expect(store.getSnapshot().unresolved).toEqual([])
  })

  it('A -> B -> A: the second A still reconciles and can see its OWN still-unresolved entry', async () => {
    const authority = new IdentityAuthority()
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'a-key',
      operationKind: 'create_purchase',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    const store = new PendingWritesStore(authority, journal, {
      create_purchase: () => Promise.resolve(false),
      create_sale: () => Promise.resolve(false),
    })
    authority.observe('A')
    store.reset()
    authority.observe('B')
    store.reset()
    authority.observe('A')
    store.reset()
    await flush()
    expect(store.getSnapshot().userId).toBe('A')
    expect(store.getSnapshot().unresolved.map((e) => e.idempotencyKey)).toEqual(['a-key'])
  })

  it('hasUnresolved is scoped by operation kind', async () => {
    const authority = new IdentityAuthority()
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'a-key',
      operationKind: 'create_sale',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    const store = new PendingWritesStore(authority, journal, {
      create_purchase: () => Promise.resolve(false),
      create_sale: () => Promise.resolve(false),
    })
    authority.observe('A')
    store.reset()
    await flush()
    expect(store.hasUnresolved('create_sale')).toBe(true)
    expect(store.hasUnresolved('create_purchase')).toBe(false)
  })

  it('a LATER reset supersedes an in-flight reconciliation from an earlier one', async () => {
    const authority = new IdentityAuthority()
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'a-key',
      operationKind: 'create_purchase',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    let releaseFirst!: (exists: boolean) => void
    let calls = 0
    const store = new PendingWritesStore(authority, journal, {
      create_purchase: () => {
        calls += 1
        if (calls === 1) return new Promise((resolve) => (releaseFirst = resolve))
        return Promise.resolve(false)
      },
      create_sale: () => Promise.resolve(false),
    })
    authority.observe('A')
    store.reset() // first reconciliation starts
    // Let the async journal.listFor() resolve so the held existsChecker call actually starts (and
    // releaseFirst gets assigned) BEFORE the second reset moves to B.
    await flush()
    authority.observe('B')
    store.reset() // second reset moves to B before the first resolves
    releaseFirst(true) // the STALE first reconciliation now resolves ("resolved" for A)
    await flush()
    // Must still be B's own (empty) state — the stale A-scoped result never overwrites it.
    expect(store.getSnapshot().userId).toBe('B')
    expect(store.getSnapshot().unresolved).toEqual([])
  })
})
