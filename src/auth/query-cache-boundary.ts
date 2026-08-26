import type { QueryClient } from '@tanstack/react-query'
import { draftStore } from '../features/openings/draft'

/**
 * `undefined` until this tab has observed any authenticated identity at all (fresh page load);
 * `null` once a signed-in user has been observed and then signed out; otherwise the last signed-in
 * user id. Only the step from one OBSERVED identity to a different one is an account switch.
 */
export type ObservedUserId = string | null | undefined

/**
 * The cross-account privacy boundary for the TanStack Query cache (F-61-2).
 *
 * The QueryClient lives for the whole tab (src/main.tsx creates it once) and no query key carries
 * a user id — keys like ['dashboard-summary'] or ['portfolio'] name the data, not its owner. On a
 * same-tab account switch the previous user's cached Home/Portfolio/History/activity values would
 * therefore render under the new identity until refetches resolve. RLS blocks every read and
 * write after sign-out, but the stale in-memory render alone leaks private financial data.
 *
 * So when the authenticated identity CHANGES, drop everything:
 *
 *   - `cancelQueries()` first, so a response still in flight for the previous identity is rejected
 *     synchronously inside the fetch retryer (query-core's cancel resolves the retryer thenable;
 *     the late network result then hits the resolved guard and is discarded) and can neither
 *     repopulate the cleared cache nor surface under the next identity;
 *   - `clear()` second, which empties BOTH the query cache and the mutation cache
 *     (query-core 5.101.4: QueryClient.clear → queryCache.clear + mutationCache.clear), so no
 *     cached result or pending mutation context of the old user survives into the new session.
 *
 * Deliberate tradeoff: clear() also discards harmless public/catalog entries, costing a few extra
 * refetches per account switch. Scoping thousands of distributed query keys by user id would buy
 * nothing at this product's scale while leaving the isolation invariant to human discipline; the
 * blanket clear makes "no A-data renders under B" structural. Same-user events (token refresh,
 * USER_UPDATED) compare equal and keep the cache intact.
 *
 * Returns true when a boundary fired, so callers can update their own identity tracking.
 */
export function applyAuthIdentityBoundary(
  queryClient: QueryClient,
  previousUserId: ObservedUserId,
  nextUserId: string | null,
): boolean {
  // No boundary on the FIRST observation of a tab lifetime (initial load into one user with an
  // empty application session) and none when the identity did not actually change. Every other
  // change between observed identity states — A→signed-out, signed-out→B, direct A→B — clears,
  // so a signing-in session never inherits pre-existing cache content regardless of history.
  if (previousUserId === undefined || previousUserId === nextUserId) return false

  void queryClient.cancelQueries()
  queryClient.clear()
  // Idempotent belt-and-braces alongside AuthProvider.signOut's explicit call (P56 §9): private
  // draft intent must not outlive the identity that created it, whichever auth path ends it.
  draftStore.clearAll()
  return true
}
