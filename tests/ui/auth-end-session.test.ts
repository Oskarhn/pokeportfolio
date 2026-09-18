import {
  AuthApiError,
  AuthClient,
  AuthRetryableFetchError,
  createClient,
} from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_REVOCATION_DEADLINE_MS,
  describeSessionEnd,
  endAuthenticatedSession,
  isRemoteRevocationConfirmed,
  type AuthSignOutApi,
  type StoredSessionAccess,
} from '../../src/auth/end-session'
import {
  authUserStorageKey,
  createAuthSessionStorage,
  deriveAuthStorageKey,
} from '../../src/auth/session-storage'

/**
 * P143 / P130-22 — deliberate sign-out ends LOCAL access whatever the Auth service does.
 *
 * Two layers, on purpose:
 *
 *   1. A scripted fake `auth` exercises every branch of `endAuthenticatedSession` deterministically
 *      (including a service that never answers, a storage that throws, and a client that throws).
 *   2. The REAL installed `AuthClient` (supabase-js 2.112.3's auth-js), wired to an in-memory
 *      storage and a stub `fetch`, proves the claim the whole design rests on — that the library
 *      alone leaves an expired session in storage when Auth is unreachable — and that this module
 *      closes exactly that gap. If a future supabase-js fixes the library, the CANARY test below
 *      fails with an explicit message so the compensation can be reconsidered rather than rot.
 */

const KEY = 'sb-p143-auth-token'
const SESSION_JSON = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1 })

class FakeStorage implements StoredSessionAccess {
  readonly map = new Map<string, string>()
  failRemove = false
  failRead = false
  readonly removed: string[] = []
  getItem(key: string): string | null {
    if (this.failRead) throw new Error('storage read blocked')
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.removed.push(key)
    if (this.failRemove) throw new Error('storage write blocked')
    this.map.delete(key)
  }
  seed(): void {
    this.map.set(KEY, SESSION_JSON)
    this.map.set(authUserStorageKey(KEY), '{"user":{}}')
  }
}

type Mode =
  | 'ok'
  | 'network-valid-token'
  | 'expired-offline'
  | 'server-500'
  | 'rejected-400'
  | 'never-answers'
  | 'throws'
  | 'throws-falsy'

/** Mimics what the installed library does in each situation (see end-session.ts's header). */
function scriptedAuth(mode: Mode, storage: FakeStorage, events: string[]): AuthSignOutApi {
  const libraryRemovesSession = () => {
    storage.map.delete(KEY)
    storage.map.delete(authUserStorageKey(KEY))
    events.push('SIGNED_OUT')
  }
  return {
    signOut: async (options) => {
      if (options?.scope === 'local') {
        // With nothing in storage the library needs no network: it just tells subscribers.
        if (storage.getItem(KEY) === null) events.push('SIGNED_OUT')
        return { error: null }
      }
      switch (mode) {
        case 'ok':
          libraryRemovesSession()
          return { error: null }
        case 'network-valid-token':
          libraryRemovesSession()
          return { error: new AuthRetryableFetchError('fetch failed', 0) }
        case 'expired-offline':
          return { error: new AuthRetryableFetchError('fetch failed', 0) }
        case 'server-500':
          libraryRemovesSession()
          return { error: new AuthApiError('upstream exploded', 500, 'unexpected_failure') }
        case 'rejected-400':
          libraryRemovesSession()
          return {
            error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found'),
          }
        case 'never-answers':
          return new Promise(() => undefined)
        case 'throws':
          throw new Error('boom')
        case 'throws-falsy':
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw undefined
      }
    },
  }
}

/** Registers fake-timer hooks for the enclosing describe only (the storage-key tests below build
 *  real clients, whose auto-refresh ticker must not run under fake timers). */
function withFakeTimers(): void {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(async () => {
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  })
}

async function run(mode: Mode, seed = true) {
  const storage = new FakeStorage()
  if (seed) storage.seed()
  const events: string[] = []
  const pending = endAuthenticatedSession({
    auth: scriptedAuth(mode, storage, events),
    storage,
    storageKey: KEY,
  })
  await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS + 1)
  return { outcome: await pending, storage, events }
}

describe('endAuthenticatedSession — every failure shape still ends local access', () => {
  withFakeTimers()
  it.each<[Mode, 'confirmed' | 'unconfirmed']>([
    ['ok', 'confirmed'],
    ['network-valid-token', 'unconfirmed'],
    ['expired-offline', 'unconfirmed'],
    ['server-500', 'unconfirmed'],
    ['rejected-400', 'confirmed'],
    ['never-answers', 'unconfirmed'],
    ['throws', 'unconfirmed'],
    ['throws-falsy', 'unconfirmed'],
  ])('%s: session gone from storage, SIGNED_OUT emitted, remote %s', async (mode, remote) => {
    const { outcome, storage, events } = await run(mode)
    expect(outcome).toEqual({ local: 'ended', remote })
    expect(storage.map.size).toBe(0)
    expect(events).toContain('SIGNED_OUT')
  })

  it('removes the session AND its companion user entry when the library left them behind', async () => {
    const { storage } = await run('expired-offline')
    expect(storage.removed).toEqual([KEY, authUserStorageKey(KEY)])
  })

  it('does not touch storage when the library already removed the session', async () => {
    const { storage } = await run('ok')
    expect(storage.removed).toEqual([])
  })

  it('an already-signed-out tab still ends cleanly and still tells subscribers', async () => {
    const { outcome, events } = await run('ok', false)
    expect(outcome).toEqual({ local: 'ended', remote: 'confirmed' })
    expect(events).toContain('SIGNED_OUT')
  })

  it('waits no longer than the deadline for an unresponsive service', async () => {
    const storage = new FakeStorage()
    storage.seed()
    const events: string[] = []
    let settled = false
    const pending = endAuthenticatedSession({
      auth: scriptedAuth('never-answers', storage, events),
      storage,
      storageKey: KEY,
      deadlineMs: 500,
    }).then((o) => {
      settled = true
      return o
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect((await pending).remote).toBe('unconfirmed')
  })
})

describe('endAuthenticatedSession — the page going away mid sign-out', () => {
  withFakeTimers()

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubPageLifecycle() {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('addEventListener', (type: string, handler: () => void) => {
      listeners.set(type, handler)
    })
    vi.stubGlobal('removeEventListener', (type: string) => {
      listeners.delete(type)
    })
    return listeners
  }

  it('a pagehide while the request is still pending removes the stored session synchronously', async () => {
    const listeners = stubPageLifecycle()
    const storage = new FakeStorage()
    storage.seed()
    const pending = endAuthenticatedSession({
      auth: scriptedAuth('never-answers', storage, []),
      storage,
      storageKey: KEY,
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(storage.map.size).toBe(2) // still waiting on the service

    listeners.get('pagehide')?.() // the tab is closed / navigated away right now

    expect(storage.map.size).toBe(0)
    await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS)
    await pending
  })

  it('the listener is removed once the sign-out settles (no leak across sign-ins)', async () => {
    const listeners = stubPageLifecycle()
    const storage = new FakeStorage()
    storage.seed()
    const pending = endAuthenticatedSession({
      auth: scriptedAuth('ok', storage, []),
      storage,
      storageKey: KEY,
    })
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(listeners.has('pagehide')).toBe(false)
  })
})

describe('endAuthenticatedSession — storage that misbehaves is reported, never thrown', () => {
  withFakeTimers()
  it('a storage that refuses removal yields local:incomplete (and never throws)', async () => {
    const storage = new FakeStorage()
    storage.seed()
    storage.failRemove = true
    const pending = endAuthenticatedSession({
      auth: scriptedAuth('expired-offline', storage, []),
      storage,
      storageKey: KEY,
    })
    await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS + 1)
    expect(await pending).toEqual({ local: 'incomplete', remote: 'unconfirmed' })
  })

  it('an unreadable storage is never mistaken for an empty one', async () => {
    const storage = new FakeStorage()
    storage.seed()
    storage.failRead = true
    const pending = endAuthenticatedSession({
      auth: scriptedAuth('ok', storage, []),
      storage,
      storageKey: KEY,
    })
    await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS + 1)
    expect((await pending).local).toBe('incomplete')
  })
})

describe('the person is only ever shown fixed, safe text', () => {
  withFakeTimers()
  it('says nothing when both halves succeeded', () => {
    expect(describeSessionEnd({ local: 'ended', remote: 'confirmed' })).toBeNull()
  })

  it('separates "signed out here" from "server confirmation missing"', () => {
    const text = describeSessionEnd({ local: 'ended', remote: 'unconfirmed' })
    expect(text).toMatch(/signed out on this device/i)
    expect(text).toMatch(/couldn't confirm/i)
    expect(text).not.toMatch(/all sessions|securely revoked|successfully revoked/i)
  })

  it('warns differently when the local cleanup itself could not be verified', () => {
    expect(describeSessionEnd({ local: 'incomplete', remote: 'unconfirmed' })).toMatch(
      /clear this site's data/i,
    )
  })

  it('leaks nothing from the failure: the outcome carries two enums and the text has no technical detail', async () => {
    const storage = new FakeStorage()
    storage.seed()
    const secret = 'eyJ-secret-token-value'
    const pending = endAuthenticatedSession({
      auth: {
        signOut: () =>
          Promise.resolve({
            error: new AuthApiError(`GET https://internal.example/auth/v1 ${secret}`, 500, 'x'),
          }),
      },
      storage,
      storageKey: KEY,
    })
    await vi.advanceTimersByTimeAsync(10)
    const outcome = await pending
    expect(Object.keys(outcome).sort()).toEqual(['local', 'remote'])
    for (const text of [
      describeSessionEnd(outcome),
      describeSessionEnd({ local: 'incomplete', remote: 'unconfirmed' }),
    ]) {
      expect(text).not.toMatch(/https?:|token|bearer|internal\.example|eyJ/i)
    }
  })

  it('classifies real supabase-js error classes correctly', () => {
    expect(isRemoteRevocationConfirmed(null)).toBe(true)
    expect(isRemoteRevocationConfirmed(new AuthApiError('m', 401, 'c'))).toBe(true)
    expect(isRemoteRevocationConfirmed(new AuthApiError('m', 404, 'c'))).toBe(true)
    expect(isRemoteRevocationConfirmed(new AuthApiError('m', 500, 'c'))).toBe(false)
    expect(isRemoteRevocationConfirmed(new AuthApiError('m', 429, 'c'))).toBe(false)
    expect(isRemoteRevocationConfirmed(new AuthRetryableFetchError('m', 0))).toBe(false)
    expect(isRemoteRevocationConfirmed(new Error('anything else'))).toBe(false)
  })
})

// ── Layer 2: the REAL installed auth-js ────────────────────────────────────────────────────────

function seededRealClient(options: {
  expired: boolean
  fetch: (url: string) => Promise<Response>
}) {
  const storage = new FakeStorage()
  const now = Math.floor(Date.now() / 1000)
  storage.map.set(
    KEY,
    JSON.stringify({
      access_token: 'access-token-value',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: options.expired ? now - 600 : now + 3600,
      refresh_token: 'refresh-token-value',
      user: { id: 'user-a', aud: 'authenticated', app_metadata: {}, user_metadata: {} },
    }),
  )
  const events: string[] = []
  const requests: string[] = []
  const client = new AuthClient({
    url: 'http://127.0.0.1:9/auth/v1',
    headers: { apikey: 'p143-test-key' },
    storageKey: KEY,
    storage,
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    fetch: (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      requests.push(url)
      return options.fetch(url)
    },
  })
  client.onAuthStateChange((event) => {
    events.push(event)
  })
  return { client, storage, events, requests }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

const unreachable = () => Promise.reject(new TypeError('fetch failed'))
const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )

describe('the REAL installed auth-js', () => {
  withFakeTimers()
  it('CANARY: the library alone leaves an EXPIRED session in storage when Auth is unreachable (the gap end-session.ts closes)', async () => {
    const { client, storage } = seededRealClient({ expired: true, fetch: unreachable })

    const pending = client.signOut()
    // The library retries the refresh with exponential backoff for up to ~25 s.
    await vi.advanceTimersByTimeAsync(40_000)
    const { error } = await pending

    expect(
      storage.map.has(KEY),
      'supabase-js now removes an expired session on a failed sign-out by itself — ' +
        'reconsider the compensation in src/auth/end-session.ts (P130-22)',
    ).toBe(true)
    expect(error).not.toBeNull()
  })

  it('expired token + unreachable Auth: end-session removes the session, emits SIGNED_OUT, and reports remote as unconfirmed', async () => {
    const { client, storage, events } = seededRealClient({ expired: true, fetch: unreachable })

    const pending = endAuthenticatedSession({ auth: client, storage, storageKey: KEY })
    await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS + 1)
    const outcome = await pending

    expect(outcome).toEqual({ local: 'ended', remote: 'unconfirmed' })
    expect(storage.map.size).toBe(0)
    expect(events).toContain('SIGNED_OUT')
    expect((await client.getSession()).data.session).toBeNull()
  })

  it('the forced local sign-out makes no network request of its own', async () => {
    const { client, storage, requests } = seededRealClient({ expired: true, fetch: unreachable })

    const pending = endAuthenticatedSession({ auth: client, storage, storageKey: KEY })
    await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS + 1)
    await pending
    const requestsAtDeadline = requests.length
    // Drain the abandoned request's own backoff; nothing ELSE may be sent afterwards for logout.
    await vi.advanceTimersByTimeAsync(40_000)

    expect(requests.every((url) => url.includes('/token?grant_type=refresh_token'))).toBe(true)
    expect(requests.some((url) => url.includes('/logout'))).toBe(false)
    expect(requests.length).toBeGreaterThanOrEqual(requestsAtDeadline)
  })

  it('valid token + unreachable Auth: the library removes the session itself; remote is unconfirmed', async () => {
    const { client, storage, events } = seededRealClient({ expired: false, fetch: unreachable })

    const pending = endAuthenticatedSession({ auth: client, storage, storageKey: KEY })
    await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS + 1)

    expect(await pending).toEqual({ local: 'ended', remote: 'unconfirmed' })
    expect(storage.map.size).toBe(0)
    expect(events).toContain('SIGNED_OUT')
  })

  it('valid token + server confirms (204): confirmed, nothing extra done', async () => {
    const { client, storage } = seededRealClient({
      expired: false,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    })

    const pending = endAuthenticatedSession({ auth: client, storage, storageKey: KEY })
    await vi.advanceTimersByTimeAsync(10)

    expect(await pending).toEqual({ local: 'ended', remote: 'confirmed' })
    expect(storage.map.size).toBe(0)
  })

  it('valid token + HTTP 500 on logout: ended locally, unconfirmed remotely', async () => {
    const { client, storage } = seededRealClient({
      expired: false,
      fetch: () => json(500, { message: 'upstream detail' }),
    })

    const pending = endAuthenticatedSession({ auth: client, storage, storageKey: KEY })
    await vi.advanceTimersByTimeAsync(10)

    expect(await pending).toEqual({ local: 'ended', remote: 'unconfirmed' })
    expect(storage.map.size).toBe(0)
  })

  it('expired token whose refresh token the server rejects (400): the session is dead server-side; confirmed', async () => {
    const { client, storage } = seededRealClient({
      expired: true,
      fetch: () => json(400, { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' }),
    })

    const pending = endAuthenticatedSession({ auth: client, storage, storageKey: KEY })
    await vi.advanceTimersByTimeAsync(10)

    expect(await pending).toEqual({ local: 'ended', remote: 'confirmed' })
    expect(storage.map.size).toBe(0)
  })

  it('no reload resurrection: a NEW client on the same storage finds no session and never asks Auth to refresh', async () => {
    const first = seededRealClient({ expired: true, fetch: unreachable })
    const pending = endAuthenticatedSession({
      auth: first.client,
      storage: first.storage,
      storageKey: KEY,
    })
    await vi.advanceTimersByTimeAsync(REMOTE_REVOCATION_DEADLINE_MS + 1)
    await pending
    await vi.advanceTimersByTimeAsync(40_000)

    // "Reload": a fresh client over the SAME storage, with Auth reachable again and willing to
    // accept the old refresh token (it was never revoked server-side).
    const secondRequests: string[] = []
    const second = new AuthClient({
      url: 'http://127.0.0.1:9/auth/v1',
      headers: { apikey: 'p143-test-key' },
      storageKey: KEY,
      storage: first.storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      fetch: (input: RequestInfo | URL) => {
        secondRequests.push(requestUrl(input))
        return json(200, {
          access_token: 'resurrected',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'rotated',
          user: { id: 'user-a', aud: 'authenticated', app_metadata: {}, user_metadata: {} },
        })
      },
    })
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await second.getSession()).data.session).toBeNull()
    expect(secondRequests).toEqual([])
    await second.stopAutoRefresh()
  })
})

// ── The explicit storage key and adapter ───────────────────────────────────────────────────────

describe('explicit storage key and adapter (session-storage.ts)', () => {
  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'https://abcdefghijklmnopqrst.supabase.co',
    'https://custom-domain.example.com',
  ])('derives exactly the key supabase-js would have chosen by default: %s', (url) => {
    const client = createClient(url, 'sb_publishable_p143_test')
    const defaultKey = (client.auth as unknown as { storageKey: string }).storageKey
    expect(deriveAuthStorageKey(url)).toBe(defaultKey)
    // Existing signed-in browsers keep their session across the change because the key is unchanged.
  })

  it('an explicit storageKey is what the client then uses', () => {
    const client = createClient('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_p143', {
      auth: { storageKey: 'sb-explicit-auth-token' },
    })
    expect((client.auth as unknown as { storageKey: string }).storageKey).toBe(
      'sb-explicit-auth-token',
    )
  })

  it('falls back to an in-memory map when localStorage is unavailable, and it still removes', () => {
    const storage = createAuthSessionStorage()
    void storage.setItem('k', 'v')
    expect(storage.getItem('k')).toBe('v')
    void storage.removeItem('k')
    expect(storage.getItem('k')).toBeNull()
  })

  it('uses localStorage when it works, and falls back when it throws (blocked site data)', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
      removeItem: (k: string) => backing.delete(k),
    })
    const viaLocal = createAuthSessionStorage()
    void viaLocal.setItem('k', 'v')
    expect(backing.get('k')).toBe('v')
    void viaLocal.removeItem('k')
    expect(backing.has('k')).toBe(false)

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    })
    const fallback = createAuthSessionStorage()
    void fallback.setItem('k', 'v')
    expect(fallback.getItem('k')).toBe('v')
    vi.unstubAllGlobals()
  })
})
