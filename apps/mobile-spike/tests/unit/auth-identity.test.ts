import { AuthController, attachForegroundRefresh } from '../../src/auth/auth-controller'
import { IdentityAuthority, isAuthIdentityChangedError } from '../../src/auth/identity-authority'
import { FakeAuth, flush, session } from '../support/fakes'

describe('IdentityAuthority (SPIKE subset of the P149 semantics)', () => {
  it('a real change (first sign-in, A -> B, sign-out) bumps the epoch and returns true', () => {
    const a = new IdentityAuthority()
    expect(a.observe('A')).toBe(true)
    expect(a.observe('B')).toBe(true)
    expect(a.observe(null)).toBe(true)
    expect(a.epoch).toBe(3)
  })

  it('a repeat of the same user (token refresh, USER_UPDATED) is NOT a change', () => {
    const a = new IdentityAuthority()
    a.observe('A')
    const epoch = a.epoch
    expect(a.observe('A')).toBe(false)
    expect(a.epoch).toBe(epoch)
  })

  it('a lease survives a same-user refresh and dies on A -> B', () => {
    const a = new IdentityAuthority()
    a.observe('A')
    const lease = a.begin('A')
    a.observe('A')
    expect(lease.isCurrent()).toBe(true)
    a.observe('B')
    expect(lease.isCurrent()).toBe(false)
    expect(() => lease.assertCurrent()).toThrow()
    try {
      lease.assertCurrent()
    } catch (e) {
      expect(isAuthIdentityChangedError(e)).toBe(true)
    }
  })

  it('A -> B -> A does NOT resurrect a lease taken in the first A session', () => {
    const a = new IdentityAuthority()
    a.observe('A')
    const first = a.begin('A')
    a.observe('B')
    a.observe('A')
    expect(first.isCurrent()).toBe(false)
    expect(a.begin('A').isCurrent()).toBe(true)
  })

  it('a lease for a user the UI was not rendered under, or a signed-out app, is already dead', () => {
    const a = new IdentityAuthority()
    expect(a.begin(null).isCurrent()).toBe(false)
    a.observe('B')
    expect(a.begin('A').isCurrent()).toBe(false)
  })

  it('retire() ends the identity ahead of the auth event, which is then a no-op', () => {
    const a = new IdentityAuthority()
    a.observe('A')
    const lease = a.begin('A')
    expect(a.retire()).toBe(true)
    expect(lease.isCurrent()).toBe(false)
    expect(a.observe(null)).toBe(false)
  })
})

function setup() {
  const auth = new FakeAuth()
  const authority = new IdentityAuthority()
  const changes: (string | null)[] = []
  let removed = 0
  const controller = new AuthController({
    auth,
    authority,
    onIdentityChange: (id) => changes.push(id),
    removeStoredSession: () => {
      removed += 1
      return Promise.resolve()
    },
  })
  controller.start()
  return { auth, authority, controller, changes, removed: () => removed }
}

describe('AuthController', () => {
  it('starts as initializing, then INITIAL_SESSION with a stored session signs in', () => {
    const { auth, controller, changes } = setup()
    expect(controller.getSnapshot().status).toBe('initializing')
    auth.emit('INITIAL_SESSION', session('A'))
    expect(controller.getSnapshot()).toMatchObject({ status: 'signed_in', userId: 'A' })
    expect(changes).toEqual(['A'])
  })

  it('TOKEN_REFRESHED and USER_UPDATED for the same user fire NO identity boundary', () => {
    const { auth, controller, changes } = setup()
    auth.emit('SIGNED_IN', session('A'))
    const epoch = controller.getSnapshot().epoch
    auth.emit('TOKEN_REFRESHED', session('A'))
    auth.emit('USER_UPDATED', session('A'))
    auth.emit('SIGNED_IN', session('A')) // a repeated SIGNED_IN on refocus
    expect(changes).toEqual(['A'])
    expect(controller.getSnapshot().epoch).toBe(epoch)
  })

  it('a direct A -> B switch fires the boundary synchronously, before the snapshot names B', () => {
    const { auth, controller, changes } = setup()
    auth.emit('SIGNED_IN', session('A'))
    const seenAtBoundary: string[] = []
    controller.subscribe(() => seenAtBoundary.push(controller.getSnapshot().userId ?? 'none'))
    auth.emit('SIGNED_IN', session('B'))
    expect(changes).toEqual(['A', 'B'])
    expect(controller.getSnapshot().userId).toBe('B')
    expect(seenAtBoundary).toEqual(['B'])
  })

  it('signIn success emits through auth events; invalid credentials and offline are distinct results', async () => {
    const { auth, controller } = setup()
    expect(await controller.signIn('a@x.invalid', 'pw')).toEqual({ ok: true })
    auth.signInError = { message: 'Invalid login credentials', status: 400 }
    expect(await controller.signIn('a@x.invalid', 'bad')).toMatchObject({
      ok: false,
      kind: 'invalid_credentials',
    })
    auth.signInError = null
    auth.signInWithPassword = (() =>
      Promise.reject(new TypeError('Network request failed'))) as typeof auth.signInWithPassword
    const offline = await controller.signIn('a@x.invalid', 'pw')
    expect(offline).toMatchObject({ ok: false, kind: 'failure', failure: { kind: 'offline' } })
  })

  it('signOut retires the identity BEFORE the server call, uses the local scope, and removes the stored session', async () => {
    const { auth, controller, authority, removed } = setup()
    auth.emit('SIGNED_IN', session('A'))
    const lease = authority.begin('A')
    const p = controller.signOut()
    expect(lease.isCurrent()).toBe(false) // already dead, synchronously
    expect(controller.getSnapshot().status).toBe('signed_out')
    await p
    expect(auth.signOutCalls).toEqual([{ scope: 'local' }])
    expect(removed()).toBe(1)
  })

  it('an offline sign-out still ends locally and deletes the stored session (P143: auth-js can leave it in place)', async () => {
    const { auth, controller, removed } = setup()
    auth.emit('SIGNED_IN', session('A'))
    auth.signOutError = { message: 'Network request failed', name: 'AuthRetryableFetchError' }
    await controller.signOut()
    expect(controller.getSnapshot()).toMatchObject({ status: 'signed_out', userId: null })
    expect(controller.getSnapshot().notice?.kind).toBe('offline')
    expect(removed()).toBe(1)
  })

  it('a null INITIAL_SESSION is signed-out only when the session lookup succeeded', async () => {
    jest.useFakeTimers()
    try {
      const { auth, controller } = setup()
      auth.getSessionResult = { session: null, error: null }
      auth.emit('INITIAL_SESSION', null)
      await jest.advanceTimersByTimeAsync(1)
      await flush()
      expect(controller.getSnapshot().status).toBe('signed_out')
    } finally {
      jest.useRealTimers()
    }
  })

  it('a null INITIAL_SESSION with a FAILED lookup (cold start offline) is NOT signed-out, and can be retried', async () => {
    jest.useFakeTimers()
    try {
      const { auth, controller } = setup()
      auth.getSessionResult = {
        session: null,
        error: { message: 'fetch failed', name: 'AuthRetryableFetchError' },
      }
      auth.emit('INITIAL_SESSION', null)
      await jest.advanceTimersByTimeAsync(1)
      await flush()
      expect(controller.getSnapshot().status).toBe('session_check_failed')
      auth.getSessionResult = { session: null, error: null }
      await controller.retrySessionCheck()
      expect(controller.getSnapshot().status).toBe('signed_out')
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('attachForegroundRefresh (Supabase RN pattern)', () => {
  it('refreshes only while the app is active', () => {
    const calls: string[] = []
    const auth = {
      startAutoRefresh: () => {
        calls.push('start')
        return Promise.resolve()
      },
      stopAutoRefresh: () => {
        calls.push('stop')
        return Promise.resolve()
      },
    }
    let listener: (s: string) => void = () => undefined
    const detach = attachForegroundRefresh(
      auth,
      { addEventListener: (_t, l) => ((listener = l), { remove: () => calls.push('removed') }) },
      'active',
    )
    listener('background')
    listener('active')
    listener('inactive')
    detach()
    expect(calls).toEqual(['start', 'stop', 'start', 'stop', 'removed'])
  })
})
