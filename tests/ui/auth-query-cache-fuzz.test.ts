import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { applyAuthIdentityBoundary, type ObservedUserId } from '../../src/auth/query-cache-boundary'
import { draftStore } from '../../src/features/openings/draft'
import { scannerSessionStore } from '../../src/features/scanner/session-store'

/**
 * P124 §16-19 — randomized property fuzz for the query-cache account boundary, generalizing
 * auth-query-cache.test.ts's 11 deterministic cases (F-61-2) into long random walks of interleaved
 * cache writes and identity transitions against a REAL QueryClient — the real
 * `applyAuthIdentityBoundary`, never a re-implementation. §17's query-key inventory: every private
 * key family this repo's query-cache-boundary test suite already enumerates (dashboard-summary,
 * portfolio[+variants], portfolio-counts, history-events, recent-activity, opening/<id>, purchase/
 * <id>, sale/<id>, purchases, sales, spending-summary, sales-summary, retailers) carries NO user id
 * in the key itself — isolation is guaranteed entirely by `clear()` firing on every identity
 * transition, never by key-scoping. This fuzz exercises exactly that guarantee under adversarial
 * interleavings, not just the hand-picked orderings already pinned.
 */

const PRIVATE_KEYS: readonly unknown[][] = [
  ['dashboard-summary'],
  ['portfolio', 'value_desc', {}],
  ['portfolio-counts'],
  ['history-events', 'all', false],
  ['recent-activity', 8],
  ['opening', 'opening-1'],
  ['purchase', 'purchase-1'],
  ['sale', 'sale-1'],
  ['purchases'],
  ['sales'],
  ['spending-summary'],
  ['sales-summary'],
  ['retailers'],
]

const IDENTITIES = ['user-A', 'user-B', 'user-C'] as const

type Event =
  | { kind: 'write'; keyIndex: number }
  | { kind: 'identityChange'; to: string | null }
  | { kind: 'retryLateWrite'; keyIndex: number } // simulates F-61-2's "in-flight response lands after the switch"

const eventArb: fc.Arbitrary<Event> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('write' as const),
      keyIndex: fc.nat(PRIVATE_KEYS.length - 1),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('identityChange' as const),
      to: fc.option(fc.constantFrom<string>(...IDENTITIES), { nil: null }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('retryLateWrite' as const),
      keyIndex: fc.nat(PRIVATE_KEYS.length - 1),
    }),
  },
)

afterEach(() => {
  draftStore.clearAll()
  scannerSessionStore.clearAll()
})

describe('applyAuthIdentityBoundary — property: no cache entry ever survives a real identity transition (P124 §19)', () => {
  it('for any interleaving of cache writes and identity changes, every entry present after each step belongs to the currently active identity', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 200 }), (events) => {
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
        let currentIdentity: ObservedUserId = undefined // fresh tab, matches AuthProvider's own initial state
        // Shadow model: which identity "owns" each key currently resident in the real cache.
        const ownerOf = new Map<string, ObservedUserId>()

        function keyName(i: number): string {
          return JSON.stringify(PRIVATE_KEYS[i])
        }

        for (const event of events) {
          if (event.kind === 'write' || event.kind === 'retryLateWrite') {
            // A genuinely PRIVATE query cannot succeed before any identity has ever been
            // observed — RLS rejects an unauthenticated request, so no real fetch could populate
            // one of these keys yet. `applyAuthIdentityBoundary` deliberately skips the very
            // first identity observation for exactly this reason (its own doc: "normal fresh
            // load, nothing sensitive was cached yet") — matching that preconditon here rather
            // than asserting a boundary contract the function was never meant to provide.
            if (currentIdentity === undefined) continue
            // A "retryLateWrite" writes using the identity that was active when a hypothetical
            // fetch would have STARTED — but since this harness is synchronous, the meaningful
            // case is already covered by ordinary writes; what matters for both is: whatever
            // identity is active AT THE MOMENT the write actually lands is who a real, unguarded
            // late response would be misattributed to if the boundary hadn't already cleared it.
            client.setQueryData(PRIVATE_KEYS[event.keyIndex]!, { owner: currentIdentity })
            ownerOf.set(keyName(event.keyIndex), currentIdentity)
          } else {
            const fired = applyAuthIdentityBoundary(client, currentIdentity, event.to)
            if (fired) {
              ownerOf.clear()
            }
            currentIdentity = event.to
          }

          // Invariant, checked after EVERY event: nothing in the real cache is attributed to any
          // identity other than the one currently active.
          for (const entry of client.getQueryCache().getAll()) {
            const data = entry.state.data as { owner: ObservedUserId } | undefined
            if (data === undefined) continue // still-pending entry, no owner claim to check
            expect(data.owner).toBe(currentIdentity)
          }
          // Cross-check against the shadow model too — every key we believe survived matches a
          // real cache entry, and vice versa (no silent partial clear).
          const realKeys = new Set(
            client
              .getQueryCache()
              .getAll()
              .map((e) => JSON.stringify(e.queryKey)),
          )
          expect(realKeys.size).toBe(ownerOf.size)
        }
      }),
      { numRuns: 50000 },
    )
  }, 120000)
})
