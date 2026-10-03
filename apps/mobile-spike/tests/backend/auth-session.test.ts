import { AuthController } from '../../src/auth/auth-controller'
import { IdentityAuthority } from '../../src/auth/identity-authority'
import { AUTH_STORAGE_KEY, removeStoredSession } from '../../src/auth/create-client'
import { classifyFailure } from '../../src/net/failure'
import { MemoryKeyValueStore } from '../support/fakes'
import { backendDescribe, fixture, newSession, publicEnv, settle, until } from './support'

/**
 * Real GoTrue (local, isolated). Proves what the unit tests can only script: that the native
 * storage adapter really holds a real session, that the session is restored without signing in
 * again, that an expired token refreshes, and that sign-out really ends the session on the server.
 */
backendDescribe('auth session lifecycle against the real local GoTrue', () => {
  const { a } = fixture().users

  it('signs in; the real stored session is within ~1% of the 2048-byte figure, so it is stored in chunks that each stay under it', async () => {
    const s = newSession() // in-memory store that REJECTS any single value above 2048 bytes
    const { data, error } = await s.client.auth.signInWithPassword({
      email: a.email,
      password: a.password,
    })
    expect(error).toBeNull()
    expect(data.session?.user.id).toBe(a.id)

    const raw = await s.storage.getItem(AUTH_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const bytes = Buffer.byteLength(raw as string, 'utf8')
    console.log(
      `MEASURED stored supabase-js session: ${String(bytes)} bytes in ${String(s.store.data.size - 1)} chunks (limit per value: 2048)`,
    )
    // Measured, not assumed: this minimal synthetic user is 2039 bytes. A user with more identities or
    // metadata (every hosted account) is larger, so a single-value store is not safe. See docs/mobile/AUTH_IDENTITY.md.
    expect(bytes).toBeGreaterThan(1800)
    for (const value of s.store.data.values())
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(2048)

    // The access token is not in the sign-in request log, and only the token endpoint was called.
    expect(s.log.map((e) => `${e.method} ${e.path}`)).toEqual(['POST /auth/v1/token'])
  })

  it('a new client (app restart) restores the SAME session from the stored chunks without signing in again', async () => {
    const first = newSession()
    await first.client.auth.signInWithPassword({ email: a.email, password: a.password })

    const restarted = newSession({ store: first.store })
    const { data } = await restarted.client.auth.getSession()
    expect(data.session?.user.id).toBe(a.id)
    expect(restarted.log.filter((e) => e.path === '/auth/v1/token')).toHaveLength(0) // no sign-in, no refresh
  })

  it('an expired access token is refreshed on restore: TOKEN_REFRESHED, storage updated, same user', async () => {
    const first = newSession()
    await first.client.auth.signInWithPassword({ email: a.email, password: a.password })
    const stored = JSON.parse((await first.storage.getItem(AUTH_STORAGE_KEY)) as string) as {
      access_token: string
      expires_at: number
    }
    const oldToken = stored.access_token
    await first.storage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 60 }),
    )

    const restarted = newSession({ store: first.store })
    const events: string[] = []
    restarted.client.auth.onAuthStateChange((event) => {
      events.push(event)
    })
    const { data, error } = await restarted.client.auth.getSession()
    expect(error).toBeNull()
    expect(data.session?.user.id).toBe(a.id)
    expect(restarted.log.some((e) => e.path === '/auth/v1/token')).toBe(true) // the refresh grant
    expect(events).toContain('TOKEN_REFRESHED')
    const after = JSON.parse((await restarted.storage.getItem(AUTH_STORAGE_KEY)) as string) as {
      access_token: string
    }
    expect(after.access_token).not.toBe(oldToken)
  })

  it('a refresh the server REJECTS (revoked/unknown refresh token) ends in a clean sign-out, not a stuck screen', async () => {
    const first = newSession()
    await first.client.auth.signInWithPassword({ email: a.email, password: a.password })
    const stored = JSON.parse((await first.storage.getItem(AUTH_STORAGE_KEY)) as string) as Record<
      string,
      unknown
    >
    await first.storage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        ...stored,
        expires_at: Math.floor(Date.now() / 1000) - 60,
        refresh_token: 'not-a-real-refresh-token',
      }),
    )
    const restarted = newSession({ store: first.store })
    const authority = new IdentityAuthority()
    const controller = new AuthController({
      auth: restarted.client.auth,
      authority,
      onIdentityChange: () => undefined,
      removeStoredSession: () => removeStoredSession(restarted.storage),
    })
    controller.start()
    await until(() => controller.getSnapshot().status !== 'initializing')
    await settle(50)
    expect(controller.getSnapshot().status).toBe('signed_out')
    expect(await restarted.storage.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })

  it('sign-out (local scope) removes the stored session AND revokes it on the server', async () => {
    const s = newSession()
    const authority = new IdentityAuthority()
    const controller = new AuthController({
      auth: s.client.auth,
      authority,
      onIdentityChange: () => undefined,
      removeStoredSession: () => removeStoredSession(s.storage),
    })
    controller.start()
    expect(await controller.signIn(a.email, a.password)).toEqual({ ok: true })
    await until(() => controller.getSnapshot().status === 'signed_in')
    const stored = JSON.parse((await s.storage.getItem(AUTH_STORAGE_KEY)) as string) as {
      refresh_token: string
    }

    await controller.signOut()
    expect(controller.getSnapshot().status).toBe('signed_out')
    expect(s.store.data.size).toBe(0)

    // The server no longer honours the refresh token of the signed-out session.
    const env = publicEnv()
    const res = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: env.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: stored.refresh_token }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('wrong credentials -> invalid_credentials; an unreachable backend -> offline (distinct states)', async () => {
    const s = newSession()
    const controller = new AuthController({
      auth: s.client.auth,
      authority: new IdentityAuthority(),
      onIdentityChange: () => undefined,
      removeStoredSession: () => Promise.resolve(),
    })
    expect(await controller.signIn(a.email, 'definitely-wrong-password')).toMatchObject({
      ok: false,
      kind: 'invalid_credentials',
    })

    const dead = newSession({ store: new MemoryKeyValueStore(2048), url: 'http://127.0.0.1:55999' })
    const c2 = new AuthController({
      auth: dead.client.auth,
      authority: new IdentityAuthority(),
      onIdentityChange: () => undefined,
      removeStoredSession: () => Promise.resolve(),
    })
    const result = await c2.signIn(a.email, a.password)
    expect(result).toMatchObject({ ok: false, kind: 'failure' })
    if (result.ok === false && result.kind === 'failure')
      expect(result.failure.kind).toBe('offline')
    expect(classifyFailure(new TypeError('fetch failed')).kind).toBe('offline')
  })
})
