import { hashPendingPayload, PendingWriteJournal } from '../../src/write/pending-write-journal'
import { reconcilePendingWrites } from '../../src/write/pending-write-reconciliation'
import { MemoryKeyValueStore } from '../support/fakes'

/**
 * P180 mission §9/§13: "reconcile before blindly repeating" and A/B isolation, at the module that
 * actually decides what happens to a pending entry on restart.
 */
describe('reconcilePendingWrites', () => {
  it('an entry whose operation already exists is cleared and reported resolved', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'k1',
      operationKind: 'create_purchase',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    const outcome = await reconcilePendingWrites(journal, 'A', {
      create_purchase: () => Promise.resolve(true),
      create_sale: () => Promise.resolve(true),
    })
    expect(outcome.resolved).toHaveLength(1)
    expect(outcome.unresolved).toHaveLength(0)
    expect(await journal.listFor('A')).toEqual([])
  })

  it('an entry confirmed ABSENT stays in the journal and is reported unresolved — never auto-retried', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'k1',
      operationKind: 'create_sale',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    const outcome = await reconcilePendingWrites(journal, 'A', {
      create_purchase: () => Promise.resolve(false),
      create_sale: () => Promise.resolve(false),
    })
    expect(outcome.resolved).toHaveLength(0)
    expect(outcome.unresolved).toHaveLength(1)
    expect(await journal.listFor('A')).toHaveLength(1)
  })

  it('a failed existence check (offline) leaves the entry alone rather than guessing', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'k1',
      operationKind: 'create_purchase',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    const outcome = await reconcilePendingWrites(journal, 'A', {
      create_purchase: () => Promise.reject(new Error('network down')),
      create_sale: () => Promise.resolve(false),
    })
    expect(outcome.resolved).toHaveLength(0)
    expect(outcome.unresolved).toHaveLength(1)
    expect(await journal.listFor('A')).toHaveLength(1)
  })

  it('never reconciles or reports another identity’s entries (A -> B isolation)', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record({
      idempotencyKey: 'a-key',
      operationKind: 'create_purchase',
      payloadHash: hashPendingPayload({ currency: 'NOK' }),
      userId: 'A',
      createdAt: new Date().toISOString(),
    })
    let checkedForB = false
    const outcome = await reconcilePendingWrites(journal, 'B', {
      create_purchase: () => {
        checkedForB = true
        return Promise.resolve(true)
      },
      create_sale: () => Promise.resolve(true),
    })
    expect(checkedForB).toBe(false)
    expect(outcome.resolved).toHaveLength(0)
    expect(outcome.unresolved).toHaveLength(0)
    // A's entry is untouched — still there for A's own eventual reconciliation.
    expect(await journal.listFor('A')).toHaveLength(1)
  })
})
