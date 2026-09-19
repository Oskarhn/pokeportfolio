import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_CREDENTIALS_UNAVAILABLE,
  AUTH_IDENTITY_CHANGED,
  AuthCredentialsUnavailableError,
  AuthIdentityChangedError,
  isAuthCredentialsUnavailableError,
  runWithLease,
} from '../../src/auth/identity-lease'
import { createLeasedDb } from '../../src/data/leased-client'
import {
  KEY,
  SESSION_TEXT,
  makeWorld,
  retryableFetchError,
  serverError,
  sessionOf,
} from './p149-lookup-world'

// The data modules import the shared client, which reads `import.meta.env`; every function under
// test here takes the LEASED client, so the shared one is never used and a placeholder is enough.
vi.mock('../../src/data/supabase-client', () => ({
  supabase: {},
  supabaseUrl: 'http://stub.invalid',
  supabasePublishableKey: 'stub-key',
}))

/**
 * P149 (closes P148-M2) — what the identity lease's credential provider makes of every answer the
 * session lookup can give. The lookup is a scripted stand-in here, so each answer can be produced on
 * demand; tests/ui/p149-credential-lookup-real-auth.test.ts produces the same answers with the real
 * auth-js.
 *
 * Three outcomes are told apart, and every test names its outcome and asserts BOTH the error and the
 * lease:
 *
 *   IDENTITY ENDED   the lease is revoked and AuthIdentityChangedError is thrown: another user's
 *                    session, no session at all, or the identity was already announced as changed.
 *   LOOKUP FAILED    the lookup could not produce a session (it answered `{ null, error }` or
 *                    rejected) and nothing says the identity changed: AuthCredentialsUnavailableError,
 *                    the lease is left alone, no request is made.
 *   CONFIRMED END    the auth client tells the tab the session is gone (SIGNED_OUT reaches the
 *                    authority) before the lookup answers: that is an identity change, and it takes
 *                    precedence over whatever error the lookup then reports.
 *
 * Nothing is asserted through a bare `rejects.toBeDefined()`: an unrelated exception must not be able
 * to satisfy a test about a specific failure.
 */

describe('LOOKUP FAILED - the credential lookup could not produce a session and the identity did not change', () => {
  let ctx: ReturnType<typeof makeWorld>
  beforeEach(() => {
    ctx = makeWorld()
  })

  it.each([
    ['a network failure (status 0)', retryableFetchError],
    ['a retryable auth-service failure (503)', serverError],
    ['an error object of a class this app has never seen', new Error('something else')],
  ])(
    '%s: nothing is sent, the lease survives, and the person gets the fixed session message',
    async (_name, error) => {
      ctx.world.lookup = () => Promise.resolve({ data: { session: null }, error })
      const lease = ctx.world.authority.begin('user-a')

      const outcome = ctx.submit(lease)
      await expect(outcome).rejects.toBeInstanceOf(AuthCredentialsUnavailableError)
      await expect(outcome).rejects.toMatchObject({
        code: AUTH_CREDENTIALS_UNAVAILABLE,
        message: SESSION_TEXT,
      })
      expect(ctx.world.dispatched).toEqual([]) // no request without valid credentials
      expect(lease.isCurrent()).toBe(true) // not an identity change
    },
  )

  it('the lookup REJECTING (a storage or programming failure) is handled the same way', async () => {
    ctx.world.lookup = () => Promise.reject(new TypeError('storage exploded'))
    const lease = ctx.world.authority.begin('user-a')
    const outcome = ctx.submit(lease)
    await expect(outcome).rejects.toBeInstanceOf(AuthCredentialsUnavailableError)
    expect(ctx.world.dispatched).toEqual([])
    expect(lease.isCurrent()).toBe(true)
  })

  it('the message shown carries nothing of the underlying failure: no class name, no HTTP detail, no token', async () => {
    ctx.world.lookup = () =>
      Promise.resolve({
        data: { session: null },
        error: Object.assign(
          new Error('POST http://127.0.0.1:54321/auth/v1/token failed for SECRET-BEARER-VALUE'),
          {
            name: 'AuthRetryableFetchError',
            status: 0,
          },
        ),
      })
    const lease = ctx.world.authority.begin('user-a')
    const thrown = await ctx.submit(lease).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AuthCredentialsUnavailableError)
    const text = (thrown as Error).message
    expect(text).toBe(SESSION_TEXT)
    expect(text).not.toMatch(/AuthRetryableFetchError|127\.0\.0\.1|eyJ|token|stack/i)
    expect(text).not.toContain('SECRET-BEARER-VALUE')
    expect((thrown as Error).stack ?? '').not.toContain('SECRET-BEARER-VALUE')
  })

  it('the SAME lease works after the failure once the lookup recovers: one request, as A, carrying the original key', async () => {
    ctx.world.lookup = () =>
      Promise.resolve({ data: { session: null }, error: retryableFetchError })
    const lease = ctx.world.authority.begin('user-a')
    await expect(ctx.submit(lease)).rejects.toBeInstanceOf(AuthCredentialsUnavailableError)
    expect(ctx.world.dispatched).toEqual([])

    ctx.world.lookup = () => Promise.resolve({ data: { session: sessionOf('a', 2) } })
    const purchase = await ctx.submit(lease)
    expect(purchase.id).toBe('purchase-1')
    expect(ctx.world.dispatched).toEqual([
      { owner: 'user-a', authorization: 'Bearer token-a-2', key: KEY },
    ])
    expect(lease.isCurrent()).toBe(true)
  })

  it('a FRESH lease (what the next click takes) works after the failure, with the same key and no duplicate request', async () => {
    ctx.world.lookup = () => Promise.resolve({ data: { session: null }, error: serverError })
    const first = ctx.world.authority.begin('user-a')
    await expect(ctx.submit(first)).rejects.toBeInstanceOf(AuthCredentialsUnavailableError)

    ctx.world.lookup = () => Promise.resolve({ data: { session: sessionOf('a') } })
    const second = ctx.world.authority.begin('user-a')
    await ctx.submit(second)
    expect(ctx.world.dispatched.map((d) => [d.owner, d.key])).toEqual([['user-a', KEY]])
  })

  it('a failure that is later followed by a success does not colour an unrelated later error of the same operation', async () => {
    ctx.world.lookup = () =>
      Promise.resolve({ data: { session: null }, error: retryableFetchError })
    const lease = ctx.world.authority.begin('user-a')
    const client = createLeasedDb(lease, ctx.deps)
    await expect(client.rpc('create_purchase', {} as never)).resolves.toMatchObject({
      error: { message: expect.stringContaining('Could not verify your session') as string },
    })
    ctx.world.lookup = () => Promise.resolve({ data: { session: sessionOf('a') } })
    await client.rpc('create_purchase', {} as never)
    // the operation now fails for its OWN reason, after a healthy lookup: it must surface as itself
    const own = new Error('Every line needs a positive quantity.')
    await expect(
      runWithLease(lease, async () => {
        await client.rpc('create_purchase', {} as never)
        throw own
      }),
    ).rejects.toBe(own)
  })
})

describe('IDENTITY ENDED - the lookup answers, and the answer is that this lease is over', () => {
  let ctx: ReturnType<typeof makeWorld>
  beforeEach(() => {
    ctx = makeWorld()
  })

  it('SIGNED OUT: no session and no error means nobody is signed in', async () => {
    ctx.world.lookup = () => Promise.resolve({ data: { session: null } })
    const lease = ctx.world.authority.begin('user-a')
    const outcome = ctx.submit(lease)
    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    await expect(outcome).rejects.toMatchObject({ code: AUTH_IDENTITY_CHANGED })
    expect(ctx.world.dispatched).toEqual([])
    expect(lease.isCurrent()).toBe(false)
  })

  it('A -> B heard before the click: the lease is dead and not even a lookup is made', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.authority.observe('user-b')
    await expect(ctx.submit(lease)).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.lookups).toBe(0)
    expect(ctx.world.dispatched).toEqual([])
    expect(lease.isCurrent()).toBe(false)
  })

  it('A -> B NOT heard yet (the shared storage already holds B): the lease is revoked from the credentials, nothing is sent as B', async () => {
    ctx.world.lookup = () => Promise.resolve({ data: { session: sessionOf('b') } })
    const lease = ctx.world.authority.begin('user-a')
    await expect(ctx.submit(lease)).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.dispatched).toEqual([])
    expect(lease.isCurrent()).toBe(false)
  })

  it('A -> B -> A while the lookup is pending: the answer is A again, and the lease stays dead', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.lookup = () => {
      ctx.world.authority.observe('user-b')
      ctx.world.authority.observe('user-a')
      return Promise.resolve({ data: { session: sessionOf('a', 2) } })
    }
    await expect(ctx.submit(lease)).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.dispatched).toEqual([])
    expect(lease.isCurrent()).toBe(false)
  })

  it('the identity changes while the lookup is pending and the lookup then answers with B: still nothing is sent', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.lookup = () => {
      ctx.world.authority.observe('user-b')
      return Promise.resolve({ data: { session: sessionOf('b') } })
    }
    await expect(ctx.submit(lease)).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.dispatched).toEqual([])
  })
})

describe('PRECEDENCE - when the identity changed AND the lookup failed, the identity change is what is reported', () => {
  let ctx: ReturnType<typeof makeWorld>
  beforeEach(() => {
    ctx = makeWorld()
  })

  it('lookup fails, and during it A -> B is announced: no stale A-specific error, the lease is dead', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.lookup = () => {
      ctx.world.authority.observe('user-b') // B's sign-in reaches this tab while the refresh is failing
      return Promise.resolve({ data: { session: null }, error: retryableFetchError })
    }
    const thrown = await ctx.submit(lease).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AuthIdentityChangedError)
    expect(isAuthCredentialsUnavailableError(thrown)).toBe(false)
    expect(ctx.world.dispatched).toEqual([])
    expect(lease.isCurrent()).toBe(false)
  })

  it('the same when the lookup REJECTS instead of answering', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.lookup = () => {
      ctx.world.authority.observe('user-b')
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    const thrown = await ctx.submit(lease).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
  })

  it('A signs out during the failing lookup (SIGNED_OUT announced, then the error): the identity ended, not "could not verify"', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.lookup = () => {
      ctx.world.authority.observe(null)
      return Promise.resolve({ data: { session: null }, error: serverError })
    }
    const thrown = await ctx.submit(lease).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
  })

  it('A -> B -> A during the failing lookup: the old lease stays dead although the user is A again', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.lookup = () => {
      ctx.world.authority.observe('user-b')
      ctx.world.authority.observe('user-a')
      return Promise.resolve({ data: { session: null }, error: retryableFetchError })
    }
    const thrown = await ctx.submit(lease).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
    // and the new A generation is unaffected: its own lease works
    ctx.world.lookup = () => Promise.resolve({ data: { session: sessionOf('a', 3) } })
    const fresh = ctx.world.authority.begin('user-a')
    await ctx.submit(fresh)
    expect(ctx.world.dispatched.map((d) => d.owner)).toEqual(['user-a'])
  })

  it('A -> B announced BEFORE the lookup starts, then the lookup would have failed: it is never asked', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.authority.observe('user-b')
    ctx.world.lookup = () =>
      Promise.resolve({ data: { session: null }, error: retryableFetchError })
    const thrown = await ctx.submit(lease).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.lookups).toBe(0)
  })

  it('an UNHEARD switch while the lookup fails is safe: the failure is reported, nothing is sent, and the next attempt finds B and ends the lease', async () => {
    const lease = ctx.world.authority.begin('user-a')
    ctx.world.lookup = () =>
      Promise.resolve({ data: { session: null }, error: retryableFetchError })
    await expect(ctx.submit(lease)).rejects.toBeInstanceOf(AuthCredentialsUnavailableError)
    expect(lease.isCurrent()).toBe(true)
    // the failed refresh had left B's session in the shared storage; the retry reads it
    ctx.world.lookup = () => Promise.resolve({ data: { session: sessionOf('b') } })
    await expect(ctx.submit(lease)).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
    expect(ctx.world.dispatched).toEqual([])
  })
})

describe('the credential provider itself', () => {
  it('SUCCESS and SAME-USER REFRESH: the token of the live session is used, whichever generation it is', async () => {
    const ctx = makeWorld()
    const lease = ctx.world.authority.begin('user-a')
    await ctx.submit(lease)
    ctx.world.lookup = () => Promise.resolve({ data: { session: sessionOf('a', 2) } }) // refreshed
    ctx.world.authority.observe('user-a') // TOKEN_REFRESHED: same user, no epoch change
    await ctx.submit(lease)
    expect(ctx.world.dispatched.map((d) => [d.owner, d.authorization])).toEqual([
      ['user-a', 'Bearer token-a-1'],
      ['user-a', 'Bearer token-a-2'],
    ])
    expect(lease.isCurrent()).toBe(true)
  })

  it('constructing the client still neither reads the session nor throws (supabase-js primes realtime once)', () => {
    const ctx = makeWorld()
    ctx.world.lookup = () => Promise.reject(new Error('must not be called'))
    const lease = ctx.world.authority.begin('user-a')
    expect(() => createLeasedDb(lease, ctx.deps)).not.toThrow()
    expect(ctx.world.lookups).toBe(0)
  })

  it('an error that is not about the lookup passes through runWithLease untouched while the lease is current', async () => {
    const ctx = makeWorld()
    const lease = ctx.world.authority.begin('user-a')
    const own = new Error('Enter a unit price.')
    await expect(runWithLease(lease, () => Promise.reject(own))).rejects.toBe(own)
    expect(lease.isCurrent()).toBe(true)
  })
})
