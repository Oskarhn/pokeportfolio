import { deferred } from '../support/fakes'
import { backendDescribe, fixture, newSession, realRuntime, settle, until } from './support'

/**
 * Account isolation against the REAL local GoTrue + PostgREST + RLS, through the real composition
 * root and the real shared data layer. Synthetic users A (10,006 holdings) and B (40 holdings, all
 * named "Synthetic BOnly ..."), so any row rendered under the wrong identity is visible by name.
 */
backendDescribe('A -> B identity isolation against the real backend', () => {
  const { a, b } = fixture().users

  async function signedInAs(runtime: ReturnType<typeof realRuntime>, who: typeof a) {
    const result = await runtime.auth.signIn(who.email, who.password)
    expect(result).toEqual({ ok: true })
    await until(() => runtime.auth.getSnapshot().userId === who.id)
  }

  it('A sees only A, B sees only B; a DIRECT switch hides A synchronously; A -> B -> A starts clean', async () => {
    const session = newSession()
    const runtime = realRuntime(session)

    await signedInAs(runtime, a)
    await runtime.collection.load()
    const aState = runtime.collection.getSnapshot()
    expect(aState.failure).toBeNull()
    expect(aState.status).toBe('ready')
    expect(aState.counts?.uniqueHoldingCount).toBe(10006)
    expect(aState.rows.length).toBe(100)
    expect(aState.rows.every((r) => !r.title.includes('BOnly'))).toBe(true)
    const aIds = new Set(aState.rows.map((r) => r.holdingId))

    // Direct switch: A's session is replaced by B's with no signed-out state in between.
    const snapshotsAtSwitch: number[] = []
    runtime.collection.subscribe(() =>
      snapshotsAtSwitch.push(runtime.collection.getSnapshot().rows.length),
    )
    await signedInAs(runtime, b)
    expect(runtime.collection.getSnapshot().rows).toEqual([]) // gone before any fetch for B
    expect(snapshotsAtSwitch.every((n) => n === 0)).toBe(true)

    await runtime.collection.load()
    const bState = runtime.collection.getSnapshot()
    expect(bState.counts?.uniqueHoldingCount).toBe(40)
    expect(bState.rows).toHaveLength(40)
    expect(bState.rows.every((r) => r.title.startsWith('Synthetic BOnly'))).toBe(true)
    expect(bState.rows.some((r) => aIds.has(r.holdingId))).toBe(false)
    expect(bState.rows.every((r) => r.quantity === 7)).toBe(true)

    // Back to A: the previous A session's state is not reused (it must be reloaded).
    await signedInAs(runtime, a)
    expect(runtime.collection.getSnapshot().rows).toEqual([])
    expect(runtime.collection.getSnapshot().status).toBe('idle')
    await runtime.collection.load()
    expect(runtime.collection.getSnapshot().counts?.uniqueHoldingCount).toBe(10006)
  })

  it('an A request still in flight when B signs in is discarded (never rendered under B)', async () => {
    // Hold list_portfolio responses until released, so the A request is genuinely in flight.
    const gate = deferred<void>()
    let held = 0
    const baseFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/rpc/list_portfolio') && held === 0) {
        held += 1
        await gate.promise
      }
      return fetch(input, init)
    }
    const session = newSession({ baseFetch })
    const runtime = realRuntime(session)
    await signedInAs(runtime, a)
    const load = runtime.collection.load()
    await until(() => held === 1)

    await signedInAs(runtime, b) // identity changes while A's page request is pending
    gate.resolve()
    await load
    await settle(200)

    const s = runtime.collection.getSnapshot()
    expect(s.rows).toEqual([])
    expect(s.status).toBe('idle')
  })

  it('a real token refresh (same user) keeps rows and drafts', async () => {
    const session = newSession()
    const runtime = realRuntime(session)
    await signedInAs(runtime, a)
    await runtime.collection.load()
    runtime.priceCheck.setQuery('P158 Twin')
    const epoch = runtime.authority.epoch
    const events: string[] = []
    session.client.auth.onAuthStateChange((e) => {
      events.push(e)
    })
    const { error } = await session.client.auth.refreshSession()
    expect(error).toBeNull()
    await until(() => events.includes('TOKEN_REFRESHED'))
    expect(runtime.authority.epoch).toBe(epoch)
    expect(runtime.collection.getSnapshot().rows).toHaveLength(100)
    expect(runtime.priceCheck.getSnapshot().query).toBe('P158 Twin')
  })

  it('sign-out clears every store; RLS still refuses B access to an A holding by id', async () => {
    const sa = newSession()
    const ra = realRuntime(sa)
    await signedInAs(ra, a)
    await ra.collection.load()
    const aHolding = ra.collection.getSnapshot().rows[0]?.holdingId as string

    const sb = newSession()
    const rb = realRuntime(sb)
    await signedInAs(rb, b)
    await rb.holdingDetail.load(aHolding) // B asks for A's holding id directly
    const state = rb.holdingDetail.getSnapshot()
    expect(state.detail).toBeNull()
    expect(['not_found', 'error']).toContain(state.status)

    await rb.auth.signOut()
    expect(rb.collection.getSnapshot().rows).toEqual([])
    expect(rb.holdingDetail.getSnapshot().detail).toBeNull()
    expect(sb.store.data.size).toBe(0)
  })
})
