import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthCredentialsUnavailableError,
  AuthIdentityChangedError,
  IdentityAuthority,
  runWithLease,
  type IdentityLease,
} from '../../src/auth/identity-lease'
import { createLeasedDb } from '../../src/data/leased-client'
import {
  NETWORK_DOWN,
  REFRESH_TOKEN_REJECTED,
  SERVICE_UNAVAILABLE,
  json,
  makeAuthRig,
  refreshOk,
  sessionJson,
  useAuthFakeTime,
  type AuthRig,
} from '../data/p149-auth-rig'

vi.mock('../../src/data/supabase-client', () => ({
  supabase: {},
  supabaseUrl: 'http://stub.invalid',
  supabasePublishableKey: 'stub-key',
}))

const { createPurchase } = await import('../../src/data/purchases')

/**
 * P149 (closes P148-M2) - the identity lease's credential provider against the REAL auth-js.
 *
 * The session lookup here is `client.auth.getSession()` of the installed supabase-js, its network
 * scripted; the identity authority is fed from that client's own `onAuthStateChange`, exactly as
 * AuthProvider feeds it in the app. So the failures are not stand-ins: "the refresh endpoint is
 * unreachable" is a real AuthRetryableFetchError after the library's real backoff (fake clock), and
 * "the refresh token was rejected" is the library really removing the session and announcing
 * SIGNED_OUT before it answers. tests/data/p149-auth-lookup-contract.test.ts pins those library
 * behaviours on their own.
 *
 * Reproduction of the defect this closes (D-140): before the fix, the transient cases below ended with
 * AuthIdentityChangedError, a revoked lease, an authority that still said "user-a", and no message
 * for the person.
 */

const KEY = '22222222-2222-4222-8222-222222222222'

interface Tab {
  rig: AuthRig
  authority: IdentityAuthority
  dispatched: { authorization: string | null; key: string | null }[]
  db: (lease: IdentityLease) => ReturnType<typeof createLeasedDb>
  submit: (lease: IdentityLease, key?: string) => ReturnType<typeof createPurchase>
  /** Starts watching an operation without moving the clock. */
  start: <T>(operation: Promise<T>) => Promise<PromiseSettledResult<T>>
  /** Runs a started operation to its end under the fake clock (the library backs off ~25 s). */
  finish: <T>(pending: Promise<PromiseSettledResult<T>>) => Promise<PromiseSettledResult<T>>
  /** start + finish */
  settle: <T>(operation: Promise<T>) => Promise<PromiseSettledResult<T>>
}

function purchaseRow() {
  return {
    id: 'purchase-1',
    purchased_on: '2026-09-01',
    retailer_id: null,
    currency: 'NOK',
    subtotal_minor: '1200',
    shipping_minor: '0',
    customs_minor: '0',
    discount_minor: '0',
    total_minor: '1200',
    fx_rate_to_nok: 1,
    fx_rate_date: '2026-09-01',
    fx_source: 'manual',
    total_nok_minor: '1200',
    notes: null,
    voided_at: null,
  }
}

/** One browser tab: a real auth client, the AuthProvider-style authority fed from it, signed in as A. */
async function openTab(options: { expired: boolean }): Promise<Tab> {
  const rig = await makeAuthRig()
  const authority = new IdentityAuthority()
  // AuthProvider subscribes at mount, long before anything expires
  rig.client.auth.onAuthStateChange((_event, session) => {
    authority.observe(session?.user.id ?? null)
  })
  await vi.advanceTimersByTimeAsync(10)
  rig.seed(sessionJson({ expired: options.expired }))
  authority.observe('user-a') // the tab is signed in as A

  const dispatched: Tab['dispatched'] = []
  const dataFetch: typeof fetch = (_input, init) => {
    const headers = new Headers(init?.headers)
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    dispatched.push({
      authorization: headers.get('authorization'),
      key: typeof body.p_idempotency_key === 'string' ? body.p_idempotency_key : null,
    })
    return Promise.resolve(json(200, purchaseRow()))
  }
  const db = (lease: IdentityLease) =>
    createLeasedDb(lease, {
      url: 'http://stub.invalid',
      publishableKey: 'stub-key',
      fetch: dataFetch,
      getSession: () => rig.client.auth.getSession(),
    })
  const submit = (lease: IdentityLease, key = KEY) =>
    runWithLease(lease, () =>
      createPurchase(
        { purchasedOn: '2026-09-01', currency: 'NOK', lines: [], notes: 'p149' },
        key,
        db(lease),
      ),
    )
  const start = <T>(operation: Promise<T>) =>
    Promise.allSettled([operation]).then(([result]) => result as PromiseSettledResult<T>)
  const finish = async <T>(pending: Promise<PromiseSettledResult<T>>) => {
    await vi.advanceTimersByTimeAsync(40_000)
    return pending
  }
  const settle = <T>(operation: Promise<T>) => finish(start(operation))
  return { rig, authority, dispatched, db, submit, start, finish, settle }
}

function rejection(result: PromiseSettledResult<unknown>): unknown {
  if (result.status !== 'rejected') throw new Error('expected the operation to fail')
  return result.reason
}

beforeEach(() => {
  useAuthFakeTime()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the refresh cannot be completed for a reason that says nothing about who is signed in', () => {
  it.each([
    ['the network is down', NETWORK_DOWN],
    ['the auth service answers 503', SERVICE_UNAVAILABLE],
  ])(
    '%s: nothing is sent, the lease survives, the person is told; the session is still stored',
    async (_name, answer) => {
      const tab = await openTab({ expired: true })
      tab.rig.refresh = answer
      const lease = tab.authority.begin('user-a')

      const result = await tab.settle(tab.submit(lease))
      const thrown = rejection(result)
      expect(thrown).toBeInstanceOf(AuthCredentialsUnavailableError)
      expect(tab.rig.refreshAttempts).toBeGreaterThanOrEqual(5) // the refresh really was attempted and failed
      expect(tab.dispatched).toEqual([]) // no request without valid credentials
      expect(lease.isCurrent()).toBe(true)
      expect(tab.authority.userId).toBe('user-a') // and the tab agrees it is still A
      expect(tab.rig.stored()?.user.id).toBe('user-a')
      expect(tab.rig.events.map((e) => e.event)).not.toContain('SIGNED_OUT')
    },
  )

  it("SUCCESSFUL SUBSEQUENT RETRY under A once the service is back (after the library's cooldown): one request, A's new token, the same key, the same lease", async () => {
    const tab = await openTab({ expired: true })
    tab.rig.refresh = SERVICE_UNAVAILABLE
    const lease = tab.authority.begin('user-a')
    expect(rejection(await tab.settle(tab.submit(lease)))).toBeInstanceOf(
      AuthCredentialsUnavailableError,
    )

    // a retry right away is answered from the library's failure cache, without a request
    tab.rig.refresh = refreshOk('access-2', 'refresh-2')
    const attempts = tab.rig.refreshAttempts
    expect(rejection(await tab.settle(tab.submit(lease)))).toBeInstanceOf(
      AuthCredentialsUnavailableError,
    )
    expect(tab.rig.refreshAttempts).toBe(attempts)
    expect(tab.dispatched).toEqual([])

    await vi.advanceTimersByTimeAsync(61_000)
    const retried = await tab.settle(tab.submit(lease))
    expect(retried.status).toBe('fulfilled')
    expect(tab.dispatched).toEqual([{ authorization: 'Bearer access-2', key: KEY }])
    expect(lease.isCurrent()).toBe(true)
  })

  it('SAME-USER REFRESH: an expired token that CAN be refreshed is refreshed and used, the lease untouched', async () => {
    const tab = await openTab({ expired: true })
    tab.rig.refresh = refreshOk('access-2', 'refresh-2')
    const lease = tab.authority.begin('user-a')
    const result = await tab.settle(tab.submit(lease))
    expect(result.status).toBe('fulfilled')
    expect(tab.dispatched).toEqual([{ authorization: 'Bearer access-2', key: KEY }])
    expect(tab.rig.events.map((e) => e.event)).toContain('TOKEN_REFRESHED')
    expect(lease.isCurrent()).toBe(true)
    expect(tab.authority.userId).toBe('user-a')
  })

  it('SUCCESS without any refresh: an unexpired session is used as it is', async () => {
    const tab = await openTab({ expired: false })
    const lease = tab.authority.begin('user-a')
    const result = await tab.settle(tab.submit(lease))
    expect(result.status).toBe('fulfilled')
    expect(tab.dispatched).toEqual([{ authorization: 'Bearer access-1', key: KEY }])
    expect(tab.rig.refreshAttempts).toBe(0)
  })

  it("ANOTHER TAB WON THE REFRESH (auth-js answers { null, AuthApiError } although A is still signed in): reported as a failed lookup, the lease survives, and the retry finds the other tab's session", async () => {
    const tab = await openTab({ expired: true })
    tab.rig.refresh = () => {
      tab.rig.seed(sessionJson({ access: 'access-other-tab', refresh: 'refresh-other-tab' }))
      return json(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'used' })
    }
    const lease = tab.authority.begin('user-a')
    expect(rejection(await tab.settle(tab.submit(lease)))).toBeInstanceOf(
      AuthCredentialsUnavailableError,
    )
    expect(lease.isCurrent()).toBe(true)
    expect(tab.dispatched).toEqual([])

    const retried = await tab.settle(tab.submit(lease))
    expect(retried.status).toBe('fulfilled')
    expect(tab.dispatched).toEqual([{ authorization: 'Bearer access-other-tab', key: KEY }])
  })
})

describe("the session is really gone, or really somebody else's", () => {
  it('CONFIRMED INVALID SESSION: the service rejects the refresh token; the library removes the session and announces SIGNED_OUT, which ends the lease - nothing is sent', async () => {
    const tab = await openTab({ expired: true })
    tab.rig.refresh = REFRESH_TOKEN_REJECTED
    const lease = tab.authority.begin('user-a')

    const result = await tab.settle(tab.submit(lease))
    expect(rejection(result)).toBeInstanceOf(AuthIdentityChangedError)
    expect(tab.rig.events.map((e) => e.event)).toContain('SIGNED_OUT')
    expect(tab.authority.userId).toBeNull() // the app's normal path: the tab is signed out
    expect(lease.isCurrent()).toBe(false)
    expect(tab.rig.stored()).toBeNull()
    expect(tab.dispatched).toEqual([])
  })

  it('SIGNED-OUT STATE: nothing stored, nobody signed in: identity ended, nothing is sent', async () => {
    const tab = await openTab({ expired: false })
    const lease = tab.authority.begin('user-a')
    tab.rig.storage.removeItem(tab.rig.key) // the session vanished from storage without an event reaching this tab
    const result = await tab.settle(tab.submit(lease))
    expect(rejection(result)).toBeInstanceOf(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
    expect(tab.dispatched).toEqual([])
  })

  it('GENUINE A -> B (storage holds B, this tab has not heard yet): the lease is revoked, nothing is sent as B', async () => {
    const tab = await openTab({ expired: false })
    const lease = tab.authority.begin('user-a')
    tab.rig.seed(sessionJson({ user: 'user-b', access: 'access-b', refresh: 'refresh-b' }))
    const result = await tab.settle(tab.submit(lease))
    expect(rejection(result)).toBeInstanceOf(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
    expect(tab.dispatched).toEqual([])
  })

  it('A -> B -> A while the refresh keeps failing: the old lease is dead, the new A generation is not', async () => {
    const tab = await openTab({ expired: true })
    tab.rig.refresh = NETWORK_DOWN
    const lease = tab.authority.begin('user-a')
    const pending = tab.start(tab.submit(lease))
    await vi.advanceTimersByTimeAsync(5_000) // the lookup is mid-backoff
    // the other tab signs in as B, then as A again; this tab hears both
    tab.rig.seed(sessionJson({ user: 'user-b', access: 'access-b', refresh: 'refresh-b' }))
    tab.authority.observe('user-b')
    tab.rig.seed(sessionJson({ user: 'user-a', access: 'access-a2', refresh: 'refresh-a2' }))
    tab.authority.observe('user-a')

    expect(rejection(await tab.finish(pending))).toBeInstanceOf(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
    expect(tab.dispatched).toEqual([])

    const fresh = tab.authority.begin('user-a')
    const result = await tab.settle(tab.submit(fresh))
    expect(result.status).toBe('fulfilled')
    expect(tab.dispatched).toEqual([{ authorization: 'Bearer access-a2', key: KEY }])
  })

  it('LOOKUP FAILURE FOLLOWED BY A -> B: the failing refresh is still backing off when B signs in; the identity change wins', async () => {
    const tab = await openTab({ expired: true })
    tab.rig.refresh = NETWORK_DOWN
    const lease = tab.authority.begin('user-a')
    const pending = tab.start(tab.submit(lease))
    await vi.advanceTimersByTimeAsync(5_000)
    tab.rig.seed(sessionJson({ user: 'user-b', access: 'access-b', refresh: 'refresh-b' }))
    tab.authority.observe('user-b')

    const thrown = rejection(await tab.finish(pending))
    expect(thrown).toBeInstanceOf(AuthIdentityChangedError)
    expect(thrown).not.toBeInstanceOf(AuthCredentialsUnavailableError)
    expect(lease.isCurrent()).toBe(false)
    expect(tab.dispatched).toEqual([])
  })

  it('A -> B FOLLOWED BY A LOOKUP FAILURE: the lease died first, so the lookup is never made and the failure cannot surface', async () => {
    const tab = await openTab({ expired: true })
    tab.rig.refresh = NETWORK_DOWN
    const lease = tab.authority.begin('user-a')
    tab.authority.observe('user-b')
    const result = await tab.settle(tab.submit(lease))
    expect(rejection(result)).toBeInstanceOf(AuthIdentityChangedError)
    expect(tab.rig.refreshAttempts).toBe(0)
    expect(tab.dispatched).toEqual([])
  })
})
