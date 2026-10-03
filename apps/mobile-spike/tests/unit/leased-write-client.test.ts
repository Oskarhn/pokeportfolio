import { IdentityAuthority } from '../../src/auth/identity-authority'
import { createLeasedWriteDb } from '../../src/write/leased-write-client'

/**
 * `createLeasedWriteDb`'s identity check, without Docker: a scripted `getSession` and a scripted
 * `fetch` that records the Authorization header of every request it is asked to send. Mutation #4
 * in output_175.txt (an identity-lease bypass) targets this file: removing the `sessionForLease`
 * check from the accessToken provider makes this suite fail because a stale lease's request would
 * actually be attempted (and carry a token) instead of never being sent.
 */
function sessionFor(userId: string) {
  return {
    data: { session: { access_token: `token-for-${userId}`, user: { id: userId } } },
  }
}

describe('createLeasedWriteDb', () => {
  it('a CURRENT lease sends its own token, once per request', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    const headers: (string | null)[] = []
    const db = createLeasedWriteDb(lease, {
      url: 'http://127.0.0.1:9', // no real network reached — fetch is stubbed below
      publishableKey: 'sb_publishable_test',
      getSession: () => Promise.resolve(sessionFor('A')),
      fetch: (input, init) => {
        headers.push(new Headers(init?.headers).get('authorization'))
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      },
    })
    await db.rpc('add_card_acquisition', { p_quantity: 1 })
    expect(headers).toContain('Bearer token-for-A')
  })

  it('a lease that is already STALE never sends any request (no token is even chosen for the wrong user)', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    authority.observe('B') // identity moved on before this write ever starts
    let fetchCalled = false
    const db = createLeasedWriteDb(lease, {
      url: 'http://127.0.0.1:9',
      publishableKey: 'sb_publishable_test',
      getSession: () => Promise.resolve(sessionFor('B')), // the ambient session is now B's
      fetch: () => {
        fetchCalled = true
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    })
    // postgrest-js never rejects: a thrown accessToken error becomes a RESOLVED
    // `{ data: null, error }` (the same behaviour net/spike-fetch.ts documents for the read-only
    // client). The important fact is fetchCalled stays false: no request ever reached the network.
    const { data, error } = await db.rpc('add_card_acquisition', { p_quantity: 1 })
    expect(data).toBeNull()
    expect(error).toBeTruthy()
    expect(fetchCalled).toBe(false)
  })

  it('a lease whose session lookup now belongs to someone ELSE refuses, even if the lease object itself is still "current" by epoch', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    let fetchCalled = false
    const db = createLeasedWriteDb(lease, {
      url: 'http://127.0.0.1:9',
      publishableKey: 'sb_publishable_test',
      // The authority was never told about the switch (an unheard storage rewrite by another tab),
      // but the session itself now answers for B — sessionForLease must still refuse.
      getSession: () => Promise.resolve(sessionFor('B')),
      fetch: () => {
        fetchCalled = true
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    })
    const { data, error } = await db.rpc('add_card_acquisition', { p_quantity: 1 })
    expect(data).toBeNull()
    expect(error).toBeTruthy()
    expect(fetchCalled).toBe(false)
    expect(lease.isCurrent()).toBe(false) // the lease is revoked by the mismatch
  })

  it('exposes the lease on `writeLease` for tests/tooling, never as an enumerable property', () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    const db = createLeasedWriteDb(lease, {
      url: 'http://127.0.0.1:9',
      publishableKey: 'sb_publishable_test',
      getSession: () => Promise.resolve(sessionFor('A')),
    })
    expect(db.writeLease).toBe(lease)
    expect(Object.keys(db)).not.toContain('writeLease')
  })
})
