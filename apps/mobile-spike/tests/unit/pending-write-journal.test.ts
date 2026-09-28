import {
  hashPendingPayload,
  PendingWriteJournal,
  type PendingWriteEntry,
} from '../../src/write/pending-write-journal'
import { MemoryKeyValueStore } from '../support/fakes'

function entry(overrides: Partial<PendingWriteEntry> = {}): PendingWriteEntry {
  return {
    idempotencyKey: 'key-1',
    operationKind: 'create_purchase',
    payloadHash: hashPendingPayload({ currency: 'NOK' }),
    userId: 'A',
    createdAt: new Date('2026-09-28T10:00:00.000Z').toISOString(),
    ...overrides,
  }
}

/**
 * P180: the bounded pending-write journal behind process-death recovery. Never stores amounts,
 * never leaks across identities, and never grows without bound.
 */
describe('PendingWriteJournal', () => {
  it('record then listFor returns the entry for its own user only', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record(entry({ userId: 'A' }))
    await journal.record(entry({ idempotencyKey: 'key-2', userId: 'B' }))
    expect((await journal.listFor('A')).map((e) => e.idempotencyKey)).toEqual(['key-1'])
    expect((await journal.listFor('B')).map((e) => e.idempotencyKey)).toEqual(['key-2'])
    expect(await journal.listFor('C')).toEqual([])
  })

  it('clear removes exactly the matching entry, nothing else', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record(entry({ idempotencyKey: 'key-1' }))
    await journal.record(entry({ idempotencyKey: 'key-2' }))
    await journal.clear('key-1')
    expect((await journal.listFor('A')).map((e) => e.idempotencyKey)).toEqual(['key-2'])
  })

  it('record for the SAME idempotency key replaces, never duplicates', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record(entry({ idempotencyKey: 'key-1', operationKind: 'create_purchase' }))
    await journal.record(entry({ idempotencyKey: 'key-1', operationKind: 'create_sale' }))
    const entries = await journal.listFor('A')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.operationKind).toBe('create_sale')
  })

  it('is bounded: recording past the cap drops the OLDEST entries, keeps the most recent', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    for (let i = 0; i < 25; i += 1) {
      await journal.record(entry({ idempotencyKey: `key-${String(i)}` }))
    }
    const entries = await journal.listFor('A')
    expect(entries.length).toBeLessThanOrEqual(20)
    expect(entries.some((e) => e.idempotencyKey === 'key-24')).toBe(true)
    expect(entries.some((e) => e.idempotencyKey === 'key-0')).toBe(false)
  })

  it('expires entries older than the bounded window', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    const old = new Date('2026-01-01T00:00:00.000Z')
    await journal.record(
      entry({ idempotencyKey: 'ancient', createdAt: old.toISOString() }),
      old.getTime(),
    )
    const now = Date.parse('2026-09-28T10:00:00.000Z')
    expect(await journal.listFor('A', now)).toEqual([])
  })

  it('a corrupted stored value reads as an empty journal, never throws', async () => {
    const store = new MemoryKeyValueStore()
    await store.setItemAsync('p180.pending-writes.v1', 'not json{{{')
    const journal = new PendingWriteJournal(store)
    expect(await journal.listFor('A')).toEqual([])
  })

  it('hashPendingPayload never includes amount-shaped fields by construction (a plain string hash of a caller-supplied summary)', () => {
    const a = hashPendingPayload({ currency: 'JPY', purchasedOn: '2026-09-28' })
    const b = hashPendingPayload({ currency: 'JPY', purchasedOn: '2026-09-28' })
    const c = hashPendingPayload({ currency: 'NOK', purchasedOn: '2026-09-28' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
