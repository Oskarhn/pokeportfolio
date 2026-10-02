import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  AUTH_IDENTITY_CHANGED,
  AuthIdentityChangedError,
  IdentityAuthority,
  isAuthIdentityChangedError,
  runWithLease,
} from '../../src/auth/identity-lease'
import { leaseFor } from './lease-support'

/**
 * P145: the identity lease rules, without a DOM. The properties below are the security invariant
 * itself: once a logical mutation began under identity A it never continues under another identity,
 * and never under a LATER session of the same user (the epoch, not the user id, tells them apart).
 */

describe('IdentityAuthority', () => {
  it('starts signed out at epoch 0; a first sign-in is an identity change', () => {
    const authority = new IdentityAuthority()
    expect(authority.userId).toBeNull()
    expect(authority.epoch).toBe(0)
    expect(authority.observe(null)).toBe(false)
    expect(authority.observe('a')).toBe(true)
    expect(authority.userId).toBe('a')
    expect(authority.epoch).toBe(1)
  })

  it('same-user events (token refresh, USER_UPDATED, repeated SIGNED_IN) never change the epoch', () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const epoch = authority.epoch
    for (let i = 0; i < 25; i += 1) expect(authority.observe('a')).toBe(false)
    expect(authority.epoch).toBe(epoch)
  })

  it('every real transition bumps the epoch exactly once: A->B, A->out, out->A', () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    authority.observe('b')
    authority.observe(null)
    authority.observe('a')
    expect(authority.epoch).toBe(4)
  })

  it('retire() ends the identity ahead of the auth event; the event that follows changes nothing', () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    authority.retire()
    expect(authority.userId).toBeNull()
    const epoch = authority.epoch
    expect(authority.observe(null)).toBe(false)
    expect(authority.epoch).toBe(epoch)
  })
})

describe('IdentityLease', () => {
  it('is current for the identity it was taken in, and survives same-user events', () => {
    const { authority, lease } = leaseFor('a')
    authority.observe('a') // TOKEN_REFRESHED / USER_UPDATED / repeated SIGNED_IN
    authority.observe('a')
    expect(lease.isCurrent()).toBe(true)
    expect(() => {
      lease.assertCurrent()
    }).not.toThrow()
  })

  it('A -> B ends the lease', () => {
    const { authority, lease } = leaseFor('a')
    authority.observe('b')
    expect(lease.isCurrent()).toBe(false)
    expect(() => {
      lease.assertCurrent()
    }).toThrow(AuthIdentityChangedError)
  })

  it('A -> signed out ends the lease, and so does retire()', () => {
    const one = leaseFor('a')
    one.authority.observe(null)
    expect(one.lease.isCurrent()).toBe(false)
    const two = leaseFor('a')
    two.authority.retire()
    expect(two.lease.isCurrent()).toBe(false)
  })

  it('A -> B -> A does NOT resurrect a lease taken in the first A session (user id alone could not tell)', () => {
    const { authority, lease } = leaseFor('a')
    authority.observe('b')
    authority.observe('a')
    expect(authority.userId).toBe('a')
    expect(lease.isCurrent()).toBe(false)
    // ...while a lease taken in the SECOND session is live.
    expect(authority.begin('a').isCurrent()).toBe(true)
  })

  it('A -> signed out -> A does not resurrect it either', () => {
    const { authority, lease } = leaseFor('a')
    authority.observe(null)
    authority.observe('a')
    expect(lease.isCurrent()).toBe(false)
  })

  it('a lease is dead from the start when the UI was rendered under an identity the tab has already left', () => {
    // React has not committed the remount yet; a click on the stale form must not adopt B.
    const authority = new IdentityAuthority()
    authority.observe('a')
    authority.observe('b')
    const stale = authority.begin('a')
    expect(stale.isCurrent()).toBe(false)
    expect(stale.userId).toBe('a')
  })

  it('a signed-out tab yields only dead leases', () => {
    const authority = new IdentityAuthority()
    expect(authority.begin(null).isCurrent()).toBe(false)
    authority.observe('a')
    authority.observe(null)
    expect(authority.begin('a').isCurrent()).toBe(false)
  })

  it('revoke() ends a lease permanently even though the observed identity is unchanged', () => {
    const { lease } = leaseFor('a')
    lease.revoke()
    expect(lease.isCurrent()).toBe(false)
  })

  it('leases are independent of each other', () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const first = authority.begin('a')
    const second = authority.begin('a')
    first.revoke()
    expect(second.isCurrent()).toBe(true)
  })

  it('PROPERTY: a lease is current exactly while every identity observed since it began was its own user', () => {
    const observeArb = fc
      .constantFrom<string | null>('a', 'b', 'c', null)
      .map((id) => ({ kind: 'observe' as const, id }))
    const eventArb = fc.oneof(observeArb, fc.constant({ kind: 'retire' as const }))
    fc.assert(
      fc.property(
        fc.constantFrom('a', 'b', 'c'),
        fc.array(eventArb, { maxLength: 40 }),
        (owner, events) => {
          const authority = new IdentityAuthority()
          authority.observe(owner)
          const lease = authority.begin(owner)
          let modelAlive = true
          for (const event of events) {
            if (event.kind === 'retire') {
              authority.retire()
              modelAlive = false
            } else {
              authority.observe(event.id)
              // Anything other than the owner ends the lease FOREVER; the owner coming back cannot
              // revive it, and observing the owner again while still alive changes nothing.
              if (event.id !== owner) modelAlive = false
            }
            expect(lease.isCurrent()).toBe(modelAlive)
          }
        },
      ),
      { numRuns: 500 },
    )
  })

  it('PROPERTY: epochs only ever increase, by one per real change', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<string | null>('a', 'b', null), { maxLength: 60 }),
        (ids) => {
          const authority = new IdentityAuthority()
          let expected = 0
          let last: string | null = null
          for (const id of ids) {
            if (id !== last) {
              expected += 1
              last = id
            }
            authority.observe(id)
            expect(authority.epoch).toBe(expected)
          }
        },
      ),
    )
  })
})

describe('runWithLease', () => {
  it('does not start the operation at all when the lease is already dead', async () => {
    const { authority, lease } = leaseFor('a')
    authority.observe('b')
    let started = false
    await expect(
      runWithLease(lease, () => {
        started = true
        return Promise.resolve(1)
      }),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(started).toBe(false)
  })

  it('returns the result of an operation that finished while its lease was live', async () => {
    const { lease } = leaseFor('a')
    await expect(runWithLease(lease, () => Promise.resolve('done'))).resolves.toBe('done')
  })

  it('returns a result that was already dispatched even if the identity changed while it ran', async () => {
    // "An already-dispatched A request completes as A": its result is real and is not discarded.
    const { authority, lease } = leaseFor('a')
    await expect(
      runWithLease(lease, () => {
        authority.observe('b')
        return Promise.resolve('completed as A')
      }),
    ).resolves.toBe('completed as A')
  })

  it('replaces ANY failure that surfaces after the lease ended with the stable domain outcome', async () => {
    const { authority, lease } = leaseFor('a')
    const rejected = runWithLease(lease, () => {
      authority.observe('b')
      return Promise.reject(
        new Error('PostgrestError: duplicate key value violates A-SECRET-marker'),
      )
    })
    await expect(rejected).rejects.toBeInstanceOf(AuthIdentityChangedError)
    const error = await rejected.catch((e: unknown) => e)
    expect(isAuthIdentityChangedError(error)).toBe(true)
    expect((error as AuthIdentityChangedError).code).toBe(AUTH_IDENTITY_CHANGED)
    // No raw server text, no stack from the failed step, nothing of A's data.
    expect((error as Error).message).not.toMatch(/duplicate key|A-SECRET/)
  })

  it('leaves a failure of a still-live operation untouched', async () => {
    const { lease } = leaseFor('a')
    const failure = new Error('Every line needs a positive quantity.')
    await expect(runWithLease(lease, () => Promise.reject(failure))).rejects.toBe(failure)
  })
})
