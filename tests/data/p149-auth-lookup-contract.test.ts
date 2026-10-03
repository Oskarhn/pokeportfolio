import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAuthApiError,
  isAuthRefreshDiscardedError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
} from '@supabase/supabase-js'
import {
  NETWORK_DOWN,
  REFRESH_TOKEN_REJECTED,
  SERVICE_UNAVAILABLE,
  json,
  makeAuthRig,
  sessionJson,
  useAuthFakeTime,
  type AuthRig,
} from './p149-auth-rig'

/**
 * P149 — the contract of `supabase.auth.getSession()` that the identity-lease credential provider
 * (src/data/leased-client.ts) depends on, pinned against the REAL installed auth-js (2.112.3) with a
 * scripted network. Nothing about the application is asserted here: these tests state what the
 * library does, so that an upgrade which changes it is noticed before the provider's reading of it
 * goes stale.
 *
 * What the provider needs to know, and where it is proven below:
 *
 *   returns a session              unexpired (no request), or expired and refreshed (TOKEN_REFRESHED)
 *   returns { null, null }         the storage holds no session at all
 *   returns { null, error }        an EXPIRED access token could not be refreshed. The error class does
 *                                  NOT say whether the person is still signed in:
 *                                    - AuthRetryableFetchError (network failure, 5xx/52x): the stored
 *                                      session is KEPT, no event fires. Still signed in.
 *                                    - AuthApiError / AuthSessionMissingError from the refresh endpoint:
 *                                      the library REMOVES the session and awaits SIGNED_OUT before it
 *                                      answers. Signed out - and the event is the proof.
 *                                    - the same non-retryable AuthApiError while ANOTHER TAB has just
 *                                      stored a fresh session: the session is kept, no event fires.
 *                                      Still signed in, with the error class of a dead session.
 *                                    - AuthRefreshDiscardedError: another tab changed the storage
 *                                      under the refresh; whatever is stored now is not ours to guess.
 *   throws                         a storage failure, or a stored session with an empty refresh token
 *                                  (AuthSessionMissingError) - the promise rejects, nothing is returned
 *
 * The lookup also keeps a per-refresh-token failure cache for one minute, and a retryable failure is
 * retried with exponential backoff for roughly 25 s before it is reported.
 */

const makeRig = makeAuthRig
type Rig = AuthRig

/** Runs `getSession()` to completion under fake time (the library backs off for ~25 s). */
async function lookup(rig: Rig) {
  const settled = rig.client.auth.getSession().then(
    (value) => ({ returned: value }) as const,
    (thrown: unknown) => ({ thrown }) as const,
  )
  await vi.advanceTimersByTimeAsync(40_000)
  return settled
}

beforeEach(() => {
  useAuthFakeTime()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getSession() — what it returns, per situation (auth-js 2.112.3)', () => {
  it('an unexpired stored session is returned as it is, with no request', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({}))
    const result = await lookup(rig)
    expect('returned' in result && result.returned.data.session?.access_token).toBe('access-1')
    expect('returned' in result && result.returned.error).toBeNull()
    expect(rig.refreshAttempts).toBe(0)
  })

  it('an expired session with a working refresh returns the NEW session and announces TOKEN_REFRESHED', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    const result = await lookup(rig)
    expect('returned' in result && result.returned.data.session?.access_token).toBe('access-2')
    expect('returned' in result && result.returned.data.session?.user.id).toBe('user-a')
    expect(rig.events).toContainEqual({ event: 'TOKEN_REFRESHED', user: 'user-a' })
    expect(rig.stored()?.refresh_token).toBe('refresh-2')
  })

  it('an empty storage returns { session: null, error: null } - no error is how "nobody is signed in" looks', async () => {
    const rig = await makeRig()
    const result = await lookup(rig)
    expect('returned' in result && result.returned).toEqual({
      data: { session: null },
      error: null,
    })
    expect(rig.refreshAttempts).toBe(0)
  })

  it('a network failure of the refresh returns { null, AuthRetryableFetchError }, after backoff, and KEEPS the session without announcing anything', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    rig.refresh = NETWORK_DOWN
    const before = Date.now()
    const result = await lookup(rig)
    expect('returned' in result).toBe(true)
    if (!('returned' in result)) return
    expect(result.returned.data.session).toBeNull()
    expect(isAuthRetryableFetchError(result.returned.error)).toBe(true)
    expect((result.returned.error as { status: number }).status).toBe(0)
    // several attempts, spread over most of the library's 30 s window: the person waits for this
    expect(rig.refreshAttempts).toBeGreaterThanOrEqual(5)
    expect(Date.now() - before).toBeGreaterThan(20_000)
    // still signed in as far as the stored session goes, and nobody was told otherwise
    expect(rig.stored()?.refresh_token).toBe('refresh-1')
    expect(rig.events.map((e) => e.event)).not.toContain('SIGNED_OUT')
  })

  it('a 503 from the refresh endpoint is the same: retryable, session kept, no event', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    rig.refresh = SERVICE_UNAVAILABLE
    const result = await lookup(rig)
    if (!('returned' in result)) throw new Error('getSession threw')
    expect(result.returned.data.session).toBeNull()
    expect(isAuthRetryableFetchError(result.returned.error)).toBe(true)
    expect((result.returned.error as { status: number }).status).toBe(503)
    expect(rig.stored()?.refresh_token).toBe('refresh-1')
    expect(rig.events.map((e) => e.event)).not.toContain('SIGNED_OUT')
  })

  it('the failure is cached for the same refresh token for one minute: a second lookup makes NO request; after the minute it asks again and can succeed', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    let serviceUp = false
    rig.refresh = () =>
      serviceUp
        ? json(200, sessionJson({ access: 'access-2', refresh: 'refresh-2' }))
        : json(503, { message: 'down' })
    const first = await lookup(rig)
    if (!('returned' in first)) throw new Error('getSession threw')
    expect(isAuthRetryableFetchError(first.returned.error)).toBe(true)
    const attemptsAfterFirst = rig.refreshAttempts

    serviceUp = true
    const soon = await lookup(rig) // service is back, but the cooldown is still running
    if (!('returned' in soon)) throw new Error('getSession threw')
    expect(soon.returned.data.session).toBeNull()
    expect(isAuthRetryableFetchError(soon.returned.error)).toBe(true)
    expect(rig.refreshAttempts).toBe(attemptsAfterFirst)

    await vi.advanceTimersByTimeAsync(61_000)
    const later = await lookup(rig)
    if (!('returned' in later)) throw new Error('getSession threw')
    expect(later.returned.data.session?.access_token).toBe('access-2')
    expect(later.returned.error).toBeNull()
  })

  it('a refresh token the service rejects (400) returns { null, AuthApiError }, REMOVES the session and has announced SIGNED_OUT before it answers', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    rig.refresh = REFRESH_TOKEN_REJECTED
    let eventsWhenAnswered = 0
    const settled = rig.client.auth.getSession().then((value) => {
      eventsWhenAnswered = rig.events.filter((e) => e.event === 'SIGNED_OUT').length
      return value
    })
    await vi.advanceTimersByTimeAsync(40_000)
    const value = await settled
    expect(value.data.session).toBeNull()
    expect(isAuthApiError(value.error)).toBe(true)
    expect(isAuthRetryableFetchError(value.error)).toBe(false)
    expect(eventsWhenAnswered).toBe(1) // the event was delivered BEFORE the lookup answered
    expect(rig.stored()).toBeNull()
    // and from then on nobody is signed in: no error, no session
    const next = await lookup(rig)
    expect('returned' in next && next.returned).toEqual({ data: { session: null }, error: null })
  })

  it('session_not_found (the session was revoked on the server) is AuthSessionMissingError: removed, SIGNED_OUT announced', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    rig.refresh = () => json(403, { code: 403, error_code: 'session_not_found', msg: 'gone' })
    const result = await lookup(rig)
    if (!('returned' in result)) throw new Error('getSession threw')
    expect(result.returned.data.session).toBeNull()
    expect(isAuthSessionMissingError(result.returned.error)).toBe(true)
    expect(rig.stored()).toBeNull()
    expect(rig.events.map((e) => e.event)).toContain('SIGNED_OUT')
  })

  it('OTHER TAB WON THE REFRESH: a non-retryable refusal while another tab has just stored a fresh session answers { null, AuthApiError } but the person is STILL signed in - nothing removed, no SIGNED_OUT', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    rig.refresh = () => {
      // the other tab rotated the token first: the storage now holds its fresh session for the same user
      rig.seed(sessionJson({ access: 'access-other-tab', refresh: 'refresh-other-tab' }))
      return json(400, {
        code: 400,
        error_code: 'refresh_token_already_used',
        msg: 'Invalid Refresh Token: Already Used',
      })
    }
    const result = await lookup(rig)
    if (!('returned' in result)) throw new Error('getSession threw')
    expect(result.returned.data.session).toBeNull()
    expect(isAuthApiError(result.returned.error)).toBe(true)
    // the error class of a dead session, on a session that is alive
    expect(rig.stored()?.access_token).toBe('access-other-tab')
    expect(rig.events.map((e) => e.event)).not.toContain('SIGNED_OUT')
    // the next lookup finds it
    const retry = await lookup(rig)
    expect('returned' in retry && retry.returned.data.session?.access_token).toBe(
      'access-other-tab',
    )
  })

  it("a refresh that succeeds after another tab changed the storage is discarded: { null, AuthRefreshDiscardedError }, the other tab's storage is left alone", async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true }))
    rig.refresh = () => {
      rig.seed(sessionJson({ user: 'user-b', access: 'access-b', refresh: 'refresh-b' }))
      return json(200, sessionJson({ access: 'access-2', refresh: 'refresh-2' }))
    }
    const result = await lookup(rig)
    if (!('returned' in result)) throw new Error('getSession threw')
    expect(result.returned.data.session).toBeNull()
    expect(isAuthRefreshDiscardedError(result.returned.error)).toBe(true)
    expect(rig.stored()?.user.id).toBe('user-b')
  })

  it('REJECTS (does not return) when the storage cannot be read', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({}))
    rig.storage.failReads = true
    const result = await lookup(rig)
    expect('thrown' in result).toBe(true)
  })

  it('REJECTS with AuthSessionMissingError for an expired stored session that has no refresh token', async () => {
    const rig = await makeRig()
    rig.seed(sessionJson({ expired: true, refresh: '' }))
    const result = await lookup(rig)
    expect('thrown' in result).toBe(true)
    if (!('thrown' in result)) return
    expect(isAuthSessionMissingError(result.thrown)).toBe(true)
    expect(rig.refreshAttempts).toBe(0)
  })
})
