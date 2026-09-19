import { describe, expect, it } from 'vitest'
import { AuthIdentityChangedError, IdentityAuthority } from '../../src/auth/identity-lease'
import { updatePasswordForLease, type PasswordAuthClient } from '../../src/auth/update-password'

/**
 * P148 - the password change is a user-scoped write to the auth service that supabase-js cannot
 * route through a leased client (auth.updateUser takes no per-request credential). It must still
 * never change the password of an account other than the one the typed value belongs to.
 * The fake auth client models the BROWSER's shared session: whoever it holds when the call is made
 * is the account that gets the new password.
 */

interface Recorded {
  updates: { forUser: string | null; password: string }[]
}

function browser(initial: string | null): {
  auth: PasswordAuthClient
  recorded: Recorded
  holds: { set: (userId: string | null) => void }
} {
  let holds = initial
  const recorded: Recorded = { updates: [] }
  const auth: PasswordAuthClient = {
    getSession: () =>
      Promise.resolve({ data: { session: holds === null ? null : { user: { id: holds } } } }),
    updateUser: ({ password }) => {
      recorded.updates.push({ forUser: holds, password })
      return Promise.resolve({ error: null })
    },
  }
  return {
    auth,
    recorded,
    holds: {
      set: (userId) => {
        holds = userId
      },
    },
  }
}

describe('updatePasswordForLease', () => {
  it('sets the password for the lease owner and only then', async () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const { auth, recorded } = browser('a')
    await updatePasswordForLease(authority.begin('a'), 'correct horse battery', auth)
    expect(recorded.updates).toEqual([{ forUser: 'a', password: 'correct horse battery' }])
  })

  it('a token refresh (same user, no epoch change) does not block it', async () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const lease = authority.begin('a')
    authority.observe('a')
    const { auth, recorded } = browser('a')
    await updatePasswordForLease(lease, 'pw-pw-pw-pw-pw', auth)
    expect(recorded.updates).toHaveLength(1)
  })

  it("EVENT GAP: the browser already holds B's session but this tab has not heard: nothing is sent", async () => {
    const authority = new IdentityAuthority()
    authority.observe('a') // the tab still believes it is A
    const lease = authority.begin('a')
    const { auth, recorded } = browser('b') // ... but shared storage moved on
    await expect(updatePasswordForLease(lease, "A's new password", auth)).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect(recorded.updates).toEqual([])
    expect(lease.isCurrent()).toBe(false)
  })

  it('the tab heard A -> B before the click: nothing is sent', async () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const lease = authority.begin('a')
    authority.observe('b')
    const { auth, recorded } = browser('b')
    await expect(updatePasswordForLease(lease, 'x'.repeat(14), auth)).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect(recorded.updates).toEqual([])
  })

  it('signed out in another tab: nothing is sent', async () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const lease = authority.begin('a')
    const { auth, recorded } = browser(null)
    await expect(updatePasswordForLease(lease, 'x'.repeat(14), auth)).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect(recorded.updates).toEqual([])
  })

  it('A -> B -> A: a lease from the first A session stays dead although the browser holds A again', async () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const lease = authority.begin('a')
    authority.observe('b')
    authority.observe('a')
    const { auth, recorded } = browser('a')
    await expect(updatePasswordForLease(lease, 'x'.repeat(14), auth)).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect(recorded.updates).toEqual([])
  })

  it('the identity changes WHILE the session lookup is pending: nothing is sent', async () => {
    const authority = new IdentityAuthority()
    authority.observe('a')
    const lease = authority.begin('a')
    const { auth, recorded } = browser('a')
    const lookup = auth.getSession
    auth.getSession = async () => {
      const result = await lookup()
      authority.observe('b') // the auth event lands while the lookup resolves
      return result
    }
    await expect(updatePasswordForLease(lease, 'x'.repeat(14), auth)).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect(recorded.updates).toEqual([])
  })

  it('a lease that was dead from the start (rendered user differs from the authority) sends nothing', async () => {
    const authority = new IdentityAuthority()
    authority.observe('b')
    const lease = authority.begin('a') // the form on screen was A's, the tab is already B's
    const { auth, recorded } = browser('b')
    await expect(updatePasswordForLease(lease, 'x'.repeat(14), auth)).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect(recorded.updates).toEqual([])
  })
})
