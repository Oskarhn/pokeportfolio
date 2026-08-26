import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyAuthIdentityBoundary } from '../../src/auth/query-cache-boundary'
import { draftStore, initialDraft } from '../../src/features/openings/draft'

/**
 * F-61-2 regression: the module-lifetime QueryClient carries no user identity in its keys, so an
 * authenticated identity change must clear it (queries AND mutations) before the next user's UI
 * can render, while a same-user token refresh must keep it. Exercised here against REAL
 * QueryClient instances with obviously-synthetic A-only values — no DOM renderer exists in this
 * repo's unit environment, so AuthProvider's own wiring (three calls around the helper, see
 * src/auth/AuthProvider.tsx) stays covered by inspection; every behavioural property of the
 * boundary itself is executed for real.
 */

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

/** Every private query-key family output_61 listed as exposed, seeded with A-only values. */
function seedUserACache(client: QueryClient): void {
  client.setQueryData(['dashboard-summary'], { headlineMinorText: '111100', owner: 'A' })
  client.setQueryData(['portfolio', 'value_desc', {}], { rows: ['A-holding'] })
  client.setQueryData(['portfolio-counts'], { owner: 'A', total: 7 })
  client.setQueryData(['history-events', 'all', false], [{ id: 'A-event' }])
  client.setQueryData(['recent-activity', 8], [{ description: 'A bought a card' }])
  client.setQueryData(['opening', 'opening-A'], { id: 'opening-A', costMinorText: '222200' })
}

function expectCacheEmpty(client: QueryClient): void {
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  expect(client.getQueryState(['dashboard-summary'])).toBeUndefined()
  expect(client.getQueryState(['portfolio', 'value_desc', {}])).toBeUndefined()
  expect(client.getQueryState(['portfolio-counts'])).toBeUndefined()
  expect(client.getQueryState(['history-events', 'all', false])).toBeUndefined()
  expect(client.getQueryState(['recent-activity', 8])).toBeUndefined()
  expect(client.getQueryState(['opening', 'opening-A'])).toBeUndefined()
}

function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

let client: QueryClient

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  draftStore.clearAll()
})

afterEach(() => {
  client.clear()
  draftStore.clearAll()
})

describe('auth identity boundary — cross-account privacy (F-61-2)', () => {
  it('clears every cached user-private entry when A signs out (A → null)', () => {
    seedUserACache(client)
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0)

    const fired = applyAuthIdentityBoundary(client, A, null)

    expect(fired).toBe(true)
    expectCacheEmpty(client)
    expect(client.getMutationCache().getAll()).toHaveLength(0)
  })

  it('clears everything on a DIRECT A → B replacement without an intermediate signed-out state', () => {
    seedUserACache(client)

    const fired = applyAuthIdentityBoundary(client, A, B)

    expect(fired).toBe(true)
    expectCacheEmpty(client)
  })

  it('keeps nothing renderable across the full walk A → signed out → B', () => {
    seedUserACache(client)
    applyAuthIdentityBoundary(client, A, null)
    expectCacheEmpty(client)

    // While signed out only public data could have been re-warmed — dropping it at sign-in is
    // the deliberate tradeoff (§15): B's session never inherits pre-existing cache content,
    // whichever paths led here.
    client.setQueryData(['sets-showcase'], [{ id: 'public-set' }])
    const firedAgain = applyAuthIdentityBoundary(client, null, B)
    expect(firedAgain).toBe(true)
    expectCacheEmpty(client)

    // Whatever B fetches lands in a cache A never contributed to.
    client.setQueryData(['dashboard-summary'], { headlineMinorText: '999', owner: 'B' })
    expect(client.getQueryData(['dashboard-summary'])).toEqual({
      headlineMinorText: '999',
      owner: 'B',
    })
  })

  it('does NOT churn on the first identity observation of a tab lifetime', () => {
    client.setQueryData(['sets-showcase'], [{ id: 'public-set' }])

    // Fresh load straight into a session, or into a signed-out tab: not account switches.
    expect(applyAuthIdentityBoundary(client, undefined, A)).toBe(false)
    expect(applyAuthIdentityBoundary(client, undefined, null)).toBe(false)
    expect(client.getQueryData(['sets-showcase'])).toEqual([{ id: 'public-set' }])
  })

  it('preserves the whole cache when the SAME user refreshes their token (A → A)', () => {
    seedUserACache(client)

    // TOKEN_REFRESHED and USER_UPDATED both re-deliver the identical session.
    const refreshed = applyAuthIdentityBoundary(client, A, A)
    const updated = applyAuthIdentityBoundary(client, A, A)

    expect(refreshed).toBe(false)
    expect(updated).toBe(false)
    expect(client.getQueryData(['dashboard-summary'])).toEqual({
      headlineMinorText: '111100',
      owner: 'A',
    })
    expect(client.getQueryData(['opening', 'opening-A'])).toEqual({
      id: 'opening-A',
      costMinorText: '222200',
    })
    expect(client.getQueryCache().getAll()).toHaveLength(6)
  })

  it('drops a late response that was still in flight during the switch (real race)', async () => {
    let resolveInFlight!: (value: unknown) => void
    const gated = new Promise<unknown>((resolve) => {
      resolveInFlight = resolve
    })
    void client
      .fetchQuery({ queryKey: ['dashboard-summary'], queryFn: () => gated })
      .catch(() => undefined)
    await expect
      .poll(() => client.getQueryState(['dashboard-summary'])?.fetchStatus, { timeout: 1000 })
      .toBe('fetching')

    applyAuthIdentityBoundary(client, A, B)
    expectCacheEmpty(client)

    // A's network answer arrives AFTER the boundary: it must be discarded by the cancelled
    // fetcher, never repopulating the cache B now reads from.
    resolveInFlight({ headlineMinorText: '111100', owner: 'A' })
    await flushMacrotasks()

    expectCacheEmpty(client)
  })

  it('empties the mutation cache and cannot leak a pending mutation result across identities', async () => {
    let resolveMutation!: (value: string) => void
    const gated = new Promise<string>((resolve) => {
      resolveMutation = resolve
    })
    const observer = new MutationObserver(client, { mutationFn: () => gated })
    void observer.mutate().catch(() => undefined)
    await expect.poll(() => client.getMutationCache().getAll().length, { timeout: 1000 }).toBe(1)

    applyAuthIdentityBoundary(client, A, null)
    expect(client.getMutationCache().getAll()).toHaveLength(0)

    resolveMutation('A-late-mutation-result')
    await flushMacrotasks()

    // The settled mutation resurrects neither the mutation cache nor any query entry.
    expect(client.getMutationCache().getAll()).toHaveLength(0)
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it('drops every user-scoped opening draft at the boundary (P56 draft privacy still holds)', () => {
    draftStore.save(A, { ...initialDraft(), productName: 'A-private-box' })
    draftStore.save(B, { ...initialDraft(), productName: 'B-private-box' })

    applyAuthIdentityBoundary(client, A, null)

    expect(draftStore.load(A)).toBeNull()
    expect(draftStore.load(B)).toBeNull()
    expect(draftStore.load(null)).toBeNull()
  })
})
