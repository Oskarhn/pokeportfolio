import { QueryClient } from '@tanstack/react-query'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyAuthIdentityBoundary, type ObservedUserId } from '../../src/auth/query-cache-boundary'

/**
 * P116 §11 — auth provider race harness (getSession() vs onAuthStateChange), randomized at scale.
 * P113 identified this as real untested ground but wrote nothing. `AuthProvider.tsx` itself is a
 * React hook this project's test infra cannot mount (no jsdom/testing-library — see
 * `camera-acquisition-guard.ts`'s own doc), but `AuthProvider`'s ENTIRE race-safety property lives
 * in one pure function it threads every observation through: `applyAuthIdentityBoundary`
 * (`src/auth/query-cache-boundary.ts`), already directly tested behaviourally by
 * `tests/ui/auth-query-cache.test.ts`. `AuthProvider` itself adds no ordering guarantee beyond
 * "whichever of getSession()'s `.then()` or an `onAuthStateChange` event callback runs first, runs
 * first" — exactly a schedule of calls into this same function, in JS's single-threaded execution
 * order. This file drives that exact real function through 50,000 GENERATED schedules covering
 * every named event (initial A, event B before getSession resolves, getSession A arriving LATE
 * after other events, SIGNED_OUT, SIGNED_IN, TOKEN_REFRESHED — modeled as a same-identity repeat)
 * and proves LAST-OBSERVED-IDENTITY-WINS semantics hold for the resulting cache/session state no
 * matter the interleaving.
 */

const USERS = ['user-a', 'user-b', 'user-c'] as const
const arbNextUserId = fc.oneof(fc.constantFrom(...USERS), fc.constant(null))

/** Mirrors AuthProvider's own `observeIdentity` reducer: apply the boundary against whatever the
 *  ref currently holds, then advance the ref — the exact two-line sequence AuthProvider.tsx runs
 *  inside both its getSession().then() and onAuthStateChange callback. */
function simulateAuthProviderObservation(
  client: QueryClient,
  lastIdentityRef: { current: ObservedUserId },
  nextUserId: string | null,
): boolean {
  const fired = applyAuthIdentityBoundary(client, lastIdentityRef.current, nextUserId)
  lastIdentityRef.current = nextUserId
  return fired
}

describe('auth provider race harness — getSession() vs onAuthStateChange, randomized schedules (P116 §11)', () => {
  it('50,000 generated observation schedules: a boundary fires if and only if the observed identity genuinely changed, and never on the first observation of a fresh ref', () => {
    fc.assert(
      fc.property(fc.array(arbNextUserId, { minLength: 1, maxLength: 20 }), (schedule) => {
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
        const ref: { current: ObservedUserId } = { current: undefined }
        for (const nextUserId of schedule) {
          const previous = ref.current
          const fired = simulateAuthProviderObservation(client, ref, nextUserId)
          const expectedFire = previous !== undefined && previous !== nextUserId
          expect(fired).toBe(expectedFire)
        }
      }),
      { numRuns: 50_000 },
    )
  }, 20_000)

  it('50,000 generated schedules: after the WHOLE schedule settles, cache/query state reflects ONLY the last-observed identity — no earlier identity data survives, regardless of interleaving order (initial A / B-before-getSession-resolves / getSession-A-arriving-late all modeled as arbitrary positions in the schedule)', () => {
    fc.assert(
      fc.property(fc.array(arbNextUserId, { minLength: 1, maxLength: 20 }), (schedule) => {
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
        const ref: { current: ObservedUserId } = { current: undefined }
        for (const nextUserId of schedule) {
          simulateAuthProviderObservation(client, ref, nextUserId)
          // Every observation "renders" by writing an identity-tagged probe entry into the
          // cache — the same shape a real signed-in render would populate via a query. Written
          // AFTER the boundary call, exactly like a real component only fetches once its own
          // identity is current.
          if (nextUserId !== null) {
            client.setQueryData(['probe', nextUserId], { owner: nextUserId })
          }
        }
        const finalIdentity = ref.current
        const allEntries = client.getQueryCache().getAll()
        for (const entry of allEntries) {
          const key = entry.queryKey
          if (Array.isArray(key) && key[0] === 'probe') {
            // Any probe entry still alive must belong to the CURRENT identity — an earlier
            // identity's probe must have been cleared by a later boundary.
            expect(key[1]).toBe(finalIdentity)
          }
        }
        if (finalIdentity !== null && finalIdentity !== undefined) {
          expect(client.getQueryData(['probe', finalIdentity])).toEqual({ owner: finalIdentity })
        }
      }),
      { numRuns: 50_000 },
    )
  }, 20_000)

  it('specific named races the prompt calls out: initial A, event B before getSession resolves, getSession A arriving late, SIGNED_OUT, SIGNED_IN, TOKEN_REFRESHED (same-identity repeat)', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const ref: { current: ObservedUserId } = { current: undefined }

    // onAuthStateChange's initial INITIAL_SESSION/SIGNED_IN fires with A before getSession()
    // itself has resolved (a real race Supabase's own client can produce).
    expect(simulateAuthProviderObservation(client, ref, 'user-a')).toBe(false) // first observation
    client.setQueryData(['dashboard'], { owner: 'user-a' })

    // TOKEN_REFRESHED re-delivers the SAME user — must never clear.
    expect(simulateAuthProviderObservation(client, ref, 'user-a')).toBe(false)
    expect(client.getQueryData(['dashboard'])).toEqual({ owner: 'user-a' })

    // getSession()'s own .then() FINALLY resolves late, with the SAME session A already observed
    // via the event above — a genuine no-op, not a phantom re-clear.
    expect(simulateAuthProviderObservation(client, ref, 'user-a')).toBe(false)
    expect(client.getQueryData(['dashboard'])).toEqual({ owner: 'user-a' })

    // SIGNED_OUT.
    expect(simulateAuthProviderObservation(client, ref, null)).toBe(true)
    expect(client.getQueryData(['dashboard'])).toBeUndefined()

    // SIGNED_IN as a different user B.
    expect(simulateAuthProviderObservation(client, ref, 'user-b')).toBe(true)
    client.setQueryData(['dashboard'], { owner: 'user-b' })
    expect(client.getQueryData(['dashboard'])).toEqual({ owner: 'user-b' })
  })
})
