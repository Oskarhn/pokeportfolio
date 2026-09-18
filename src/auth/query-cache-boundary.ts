import type { QueryClient } from '@tanstack/react-query'
import { draftStore } from '../features/openings/draft'
import { scannerSessionStore } from '../features/scanner/session-store'
import { setScannerBatchSize } from '../features/scanner/unsaved-work'
import { classifyIdentityTransition, isIdentityChange, type ObservedUserId } from './identity'

export type { ObservedUserId } from './identity'

/**
 * The cross-account privacy boundary for everything user-scoped that lives OUTSIDE the React tree
 * (F-61-2, extended by P143). Its React counterpart is `AuthIdentityBoundary`, which remounts the
 * authenticated subtree under a user-id key; a remount cannot reach the state cleared here.
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
 * Classification of the rest of this app's module/browser state (P143 audit):
 *   cleared here      draftStore, scannerSessionStore (both keyed by user id AND swept, so a stale
 *                     entry is unreachable even if a future caller forgets the key), the scanner
 *                     batch-size mirror read by the stale-deployment reload guard
 *   survives on purpose theme preference (`pp-theme`), build-freshness reload timestamp, scanner
 *                     model/OCR assets (public), the analytics injection flag — none is derived
 *                     from a person's account
 *   already user-keyed the export-reminder timestamp in localStorage (`export-reminder.ts`)
 *   unsaved-work registry holds getters registered by mounted components; the remount unregisters
 *                     them through their own effect cleanups, so it needs no sweep here
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
  if (!isIdentityChange(classifyIdentityTransition(previousUserId, nextUserId))) return false

  void queryClient.cancelQueries()
  queryClient.clear()
  // Idempotent belt-and-braces alongside AuthProvider's own explicit end-of-session clear (P56 §9):
  // private draft intent must not outlive the identity that created it, whichever auth path ends it.
  // The M15 scanner's session defaults join the same sweep (D-093 extension). Its batch and any
  // captured image live in component state, which the AuthIdentityBoundary remount now destroys on
  // a direct A→B switch as well (before P143 only a route change did).
  draftStore.clearAll()
  scannerSessionStore.clearAll()
  // The scanner page zeroes this mirror in its own unmount cleanup; doing it here too means the
  // reload guard never sees a previous identity's batch in the moment before that cleanup runs.
  setScannerBatchSize(0)
  return true
}
