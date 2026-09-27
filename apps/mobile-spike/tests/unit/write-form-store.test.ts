import { IdentityAuthority } from '../../src/auth/identity-authority'
import type { LeasedWriteDb } from '../../src/write/leased-write-client'
import { WriteFormStore } from '../../src/state/write-form-store'

interface Draft {
  contextKey: string
  value: string
}

function draftFor(key: string): Draft {
  return { contextKey: key, value: '' }
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
