import { IdentityAuthority } from '../../src/auth/identity-authority'
import type { LeasedWriteDb } from '../../src/write/leased-write-client'
import { PendingWriteJournal } from '../../src/write/pending-write-journal'
import { WriteFormStore } from '../../src/state/write-form-store'
import { MemoryKeyValueStore } from '../support/fakes'

interface Draft {
  contextKey: string
  value: string
}

function draftFor(key: string): Draft {
  return { contextKey: key, value: '' }
}

/** classifyFailure (net/failure.ts) reads `.name`/`.status` structurally — a real Error with these
 *  set reproduces an HttpStatusError without importing net/spike-fetch.ts's own class here. */
function httpError(status: number): Error & { status: number } {
  const error = new Error(`HTTP ${String(status)}`) as Error & { status: number }
  error.name = 'HttpStatusError'
  error.status = status
  return error
}

const FAKE_DB = { fake: true } as unknown as LeasedWriteDb

/**
 * P175's generic write-form store: idempotency-key lifecycle, identity leasing at the moment of
 * confirm, and the draft-persistence rules from the mission's FORMS / IDEMPOTENCY sections.
 * Mutations #5/#6/#11/#12/#13/#17 in output_175.txt.
 */
describe('WriteFormStore', () => {
  it('no write happens merely by constructing the store', () => {
    const authority = new IdentityAuthority()
    let dbCalls = 0
    new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => {
        dbCalls += 1
        return FAKE_DB
      },
    )
    expect(dbCalls).toBe(0)
  })

  it('updateDraft never touches the network', () => {
    const authority = new IdentityAuthority()
    let dbCalls = 0
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => {
        dbCalls += 1
        return FAKE_DB
      },
    )
    store.updateDraft({ value: 'typing...' })
    expect(store.getSnapshot().draft.value).toBe('typing...')
    expect(dbCalls).toBe(0)
  })

  it('ensureContext keeps an in-progress draft for the SAME entity', () => {
    const authority = new IdentityAuthority()
    const store = new WriteFormStore(
      authority,
      () => draftFor('card-1'),
      () => FAKE_DB,
    )
    store.updateDraft({ value: 'typed' })
    store.ensureContext(() => draftFor('card-1'))
    expect(store.getSnapshot().draft.value).toBe('typed')
  })

  it('ensureContext starts fresh for a DIFFERENT entity', () => {
    const authority = new IdentityAuthority()
    const store = new WriteFormStore(
      authority,
      () => draftFor('card-1'),
      () => FAKE_DB,
    )
    store.updateDraft({ value: 'typed for card 1' })
    const keyBefore = store.getSnapshot().idempotencyKey
    store.ensureContext(() => draftFor('card-2'))
    expect(store.getSnapshot().draft.value).toBe('')
    expect(store.getSnapshot().draft.contextKey).toBe('card-2')
    expect(store.getSnapshot().idempotencyKey).not.toBe(keyBefore)
  })

  it('submit rotates the idempotency key on SUCCESS', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    const keyBefore = store.getSnapshot().idempotencyKey
    let usedKey: string | undefined
    const result = await store.submit('A', (_db, _draft, key) => {
      usedKey = key
      return Promise.resolve('ok')
    })
    expect(result).toEqual({ ok: true, value: 'ok' })
    expect(usedKey).toBe(keyBefore)
    expect(store.getSnapshot().idempotencyKey).not.toBe(keyBefore)
    expect(store.getSnapshot().status).toBe('success')
  })

  it('submit keeps the SAME idempotency key on FAILURE (a retry is a retry of the same attempt)', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    const keyBefore = store.getSnapshot().idempotencyKey
    const result = await store.submit('A', () => Promise.reject(new Error('server error')))
    expect(result.ok).toBe(false)
    expect(store.getSnapshot().idempotencyKey).toBe(keyBefore)
    expect(store.getSnapshot().status).toBe('error')
  })

  it('a draft under A survives a same-user token refresh (reset() not called)', () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    store.updateDraft({ value: 'still typing' })
    authority.observe('A') // a repeat of the same user id: NOT a real change, no-op on the authority
    expect(store.getSnapshot().draft.value).toBe('still typing')
  })

  it('reset() clears the draft AND rotates the idempotency key (the registry calls this on identity change)', () => {
    const authority = new IdentityAuthority()
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    store.updateDraft({ value: 'A had typed this' })
    const keyBefore = store.getSnapshot().idempotencyKey
    store.reset()
    expect(store.getSnapshot().draft.value).toBe('')
    expect(store.getSnapshot().idempotencyKey).not.toBe(keyBefore)
    expect(store.getSnapshot().status).toBe('editing')
  })

  it('A -> B -> A: reset() between them means the second A never sees the first A draft or key', () => {
    const authority = new IdentityAuthority()
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    store.updateDraft({ value: 'first A draft' })
    const firstKey = store.getSnapshot().idempotencyKey
    store.reset() // simulates the registry's onIdentityChange for A -> B
    store.reset() // and again for B -> A
    expect(store.getSnapshot().draft.value).toBe('')
    expect(store.getSnapshot().idempotencyKey).not.toBe(firstKey)
  })

  it('submit under a lease that is already stale (renderedUserId no longer current) never calls the action', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    authority.observe('B') // the screen still thinks it is A, but the authority has moved on
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    let called = false
    const result = await store.submit('A', () => {
      called = true
      return Promise.resolve('should not happen')
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
  })

  it('a second submit is refused outright while the first is still in flight (no concurrent writes)', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    let releaseFirst!: (v: string) => void
    const first = store.submit(
      'A',
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = resolve
        }),
    )
    let secondCalled = false
    const second = await store.submit('A', () => {
      secondCalled = true
      return Promise.resolve('second')
    })
    expect(secondCalled).toBe(false)
    expect(second.ok).toBe(false)
    releaseFirst('first')
    await expect(first).resolves.toEqual({ ok: true, value: 'first' })
  })

  it('a reset() DURING an in-flight submit supersedes it: the late result never overwrites the fresh draft', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    )
    let releaseFirst!: (v: string) => void
    const pending = store.submit(
      'A',
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = resolve
        }),
    )
    store.reset() // e.g. the registry resetting this store on an identity change mid-write
    const keyAfterReset = store.getSnapshot().idempotencyKey
    releaseFirst('late result')
    const result = await pending
    expect(result.ok).toBe(false) // superseded — never surfaces as a success the UI would show
    expect(store.getSnapshot().status).toBe('editing') // reset()'s state, not overwritten
    expect(store.getSnapshot().idempotencyKey).toBe(keyAfterReset)
  })
})

/**
 * P180: process-death-after-commit reliability. Only exercised when a `PendingWriteConfig` is
 * supplied (purchase/sale in the real app) — every test above this point passes no config and is
 * proof that the pre-P180 behaviour (plain 'error' status, no journal calls) is unchanged when the
 * feature is not wired in.
 */
describe('WriteFormStore pending-write journal', () => {
  it('records a pending entry BEFORE the action runs, and clears it on success', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
      {
        journal,
        operationKind: 'create_purchase',
        summarize: (draft) => ({ value: draft.value }),
      },
    )
    let entriesDuringAction = -1
    const result = await store.submit('A', async () => {
      entriesDuringAction = (await journal.listFor('A')).length
      return 'ok'
    })
    expect(result.ok).toBe(true)
    expect(entriesDuringAction).toBe(1)
    expect(await journal.listFor('A')).toEqual([])
  })

  it('a definite failure (e.g. server-side rejection) clears the entry and status is "error"', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
      {
        journal,
        operationKind: 'create_purchase',
        summarize: () => ({}),
      },
    )
    const result = await store.submit('A', () => Promise.reject(httpError(400)))
    expect(result.ok).toBe(false)
    expect(store.getSnapshot().status).toBe('error')
    expect(await journal.listFor('A')).toEqual([])
  })

  it('an uncertain failure (offline) KEEPS the pending entry and status is "uncertain", never "error"', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
      {
        journal,
        operationKind: 'create_purchase',
        summarize: () => ({}),
      },
    )
    const keyBefore = store.getSnapshot().idempotencyKey
    const result = await store.submit('A', () =>
      Promise.reject(new TypeError('network request failed')),
    )
    expect(result.ok).toBe(false)
    expect(store.getSnapshot().status).toBe('uncertain')
    // The key is NOT rotated: a manual retry from this same instance reuses it, so the RPC's own
    // idempotent-replay rule protects against a duplicate if the first attempt actually committed.
    expect(store.getSnapshot().idempotencyKey).toBe(keyBefore)
    expect(await journal.listFor('A')).toHaveLength(1)
  })

  it('a 5xx (server) failure is also uncertain, not a definite error', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
      {
        journal,
        operationKind: 'create_sale',
        summarize: () => ({}),
      },
    )
    const result = await store.submit('A', () => Promise.reject(httpError(503)))
    expect(result.ok).toBe(false)
    expect(store.getSnapshot().status).toBe('uncertain')
    expect(await journal.listFor('A')).toHaveLength(1)
  })

  it('without a pending config, the pre-P180 status is unchanged: "unknown"-kind failures stay "error"', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const store = new WriteFormStore(
      authority,
      () => draftFor('x'),
      () => FAKE_DB,
    ) // no pending config
    const result = await store.submit('A', () => Promise.reject(new Error('server error')))
    expect(result.ok).toBe(false)
    expect(store.getSnapshot().status).toBe('error')
  })
})
