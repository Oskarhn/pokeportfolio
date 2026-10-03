import {
  AuthCredentialsUnavailableError,
  AuthIdentityChangedError,
  IdentityAuthority,
  runWithLease,
  sessionForLease,
} from '../../src/auth/identity-authority'

interface FakeSession {
  user: { id: string }
}

/**
 * P175's ported `sessionForLease`/`runWithLease`/`IdentityLease.revoke` (P149's design, adversarial
 * scenarios from the mission's IDENTITY ADVERSARIAL TESTS section and mutations #4/#11/#12/#13).
 */
describe('sessionForLease', () => {
  it('returns the session when it matches the lease owner', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    const result = await sessionForLease<FakeSession>(lease, () =>
      Promise.resolve({ data: { session: { user: { id: 'A' } } } }),
    )
    expect(result.user.id).toBe('A')
    expect(lease.isCurrent()).toBe(true)
  })

  it('ends the lease when the lookup finds nobody signed in', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    await expect(
      sessionForLease<FakeSession>(lease, () => Promise.resolve({ data: { session: null } })),
    ).rejects.toThrow(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
  })

  it('ends the lease when the lookup finds SOMEBODY ELSE signed in (A -> B unheard)', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    await expect(
      sessionForLease<FakeSession>(lease, () =>
        Promise.resolve({ data: { session: { user: { id: 'B' } } } }),
      ),
    ).rejects.toThrow(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
  })

  it('a FAILED lookup (network/expired refresh) does NOT end the lease — retryable, not identity change', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    await expect(
      sessionForLease<FakeSession>(lease, () =>
        Promise.resolve({ data: { session: null }, error: new Error('network down') }),
      ),
    ).rejects.toThrow(AuthCredentialsUnavailableError)
    expect(lease.isCurrent()).toBe(true) // still alive: the person can just retry
  })

  it('a lookup that REJECTS is also a failure, not an identity change', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    await expect(
      sessionForLease<FakeSession>(lease, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow(AuthCredentialsUnavailableError)
    expect(lease.isCurrent()).toBe(true)
  })

  it('identity change heard BEFORE the lookup returns wins over a failed lookup', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    let resolveLookup!: (v: { data: { session: null }; error: Error }) => void
    const pending = new Promise<{ data: { session: null }; error: Error }>((resolve) => {
      resolveLookup = resolve
    })
    const promise = sessionForLease<FakeSession>(lease, () => pending)
    authority.observe('B') // heard while the lookup is still pending
    resolveLookup({ data: { session: null }, error: new Error('network down') })
    await expect(promise).rejects.toThrow(AuthIdentityChangedError)
  })

  it('does not even attempt the lookup when the lease is already dead', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    authority.observe('B') // A's lease is now stale before anything starts
    let called = false
    await expect(
      sessionForLease<FakeSession>(lease, () => {
        called = true
        return Promise.resolve({ data: { session: { user: { id: 'B' } } } })
      }),
    ).rejects.toThrow(AuthIdentityChangedError)
    expect(called).toBe(false)
  })

  it('A -> B -> A: the SECOND A session does not resurrect the FIRST A lease', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const firstLease = authority.begin('A')
    authority.observe('B')
    authority.observe('A') // second A, a new epoch
    await expect(
      sessionForLease<FakeSession>(firstLease, () =>
        Promise.resolve({ data: { session: { user: { id: 'A' } } } }),
      ),
    ).rejects.toThrow(AuthIdentityChangedError)
  })

  it('same-user token refresh: the lease survives (observe() is not even called for a repeat)', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    const result = await sessionForLease<FakeSession>(lease, () =>
      Promise.resolve({ data: { session: { user: { id: 'A' } } } }),
    )
    expect(result.user.id).toBe('A')
    expect(lease.isCurrent()).toBe(true)
  })
})

describe('runWithLease', () => {
  it('runs the operation and returns its result when the lease stays current', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    await expect(runWithLease(lease, () => Promise.resolve(42))).resolves.toBe(42)
  })

  it('does not even start the operation when the lease is already dead', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    authority.observe('B')
    let started = false
    await expect(
      runWithLease(lease, () => {
        started = true
        return Promise.resolve(1)
      }),
    ).rejects.toThrow(AuthIdentityChangedError)
    expect(started).toBe(false)
  })

  it('replaces a failure that surfaces after the lease ended with AuthIdentityChangedError', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    const op = () => {
      authority.observe('B') // identity changes WHILE the operation is running
      return Promise.reject(new Error('some raw transport error about A-scoped data'))
    }
    await expect(runWithLease(lease, op)).rejects.toThrow(AuthIdentityChangedError)
  })

  it('a result already produced when the identity ends is returned as-is (the write happened as A)', async () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    const op = () => {
      const value = 'write committed as A'
      authority.observe('B')
      return Promise.resolve(value)
    }
    await expect(runWithLease(lease, op)).resolves.toBe('write committed as A')
  })

  it('a lease already revoked by the write layer refuses even under the same user id/epoch', () => {
    const authority = new IdentityAuthority()
    authority.observe('A')
    const lease = authority.begin('A')
    expect(lease.isCurrent()).toBe(true)
    lease.revoke()
    expect(lease.isCurrent()).toBe(false)
    expect(() => lease.assertCurrent()).toThrow(AuthIdentityChangedError)
  })
})
