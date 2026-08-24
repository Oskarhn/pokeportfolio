import { supabase } from './supabase-client'

/**
 * Defensive backstop for the P27 owner report: Search errored once on a cold start, then worked
 * on the second attempt. That failure was never reproduced, and the installed
 * @supabase/auth-js@2.112.3 already narrows the plausible causes considerably — concurrent token
 * refreshes are single-flighted (`_callRefreshToken`), and `__loadSession()` proactively
 * refreshes a near-expiry stored session BEFORE any request attaches its token. What remains
 * plausible but unconfirmed is a server-side rejection of a token the client still considered
 * valid (e.g. cross-tab rotation timing), which would produce exactly the reported
 * error-once-then-worked shape.
 *
 * This wrapper hedges that residual case only: on an auth-class failure it forces exactly one
 * `refreshSession()` and replays the operation exactly once. Everything else — RLS/permission
 * denial, network down, provider outage, client misconfiguration — propagates untouched: no
 * blanket catch, no retry storm, no second auth state machine. A signed-out or revoked session
 * fails closed (the refresh cannot invent a valid one); the query's Try again control remains
 * the recovery path.
 */

/** Structured PostgREST code meaning the session token itself was rejected (401-class). */
const AUTH_RECOVERABLE_CODE = 'PGRST301'

/**
 * Message fallback, used ONLY when an error reaches this layer without structured information
 * (e.g. a non-JSON error body collapsed to `{ message }` upstream). Scoped to session-token
 * rejection wording. Deliberately NOT classified as recoverable: permission/RLS denials, network
 * failures, provider failures, and configuration failures such as an invalid project API key —
 * `refreshSession()` cannot repair the client's configured key, so that error must surface
 * immediately rather than trigger a pointless round trip.
 */
const AUTH_FAILURE_MESSAGE = /\b(jw[ts]|401)\b|pgrst301/i

export function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  // Structured first: when the query layer preserved the PostgREST code, it alone decides —
  // keeping e.g. 42501 permission denials distinct from token rejections whatever the message
  // says. The regex below only covers errors that arrive without a code.
  if (typeof code === 'string' && code !== '') return code === AUTH_RECOVERABLE_CODE
  return AUTH_FAILURE_MESSAGE.test(error.message)
}

export async function withAuthRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const { error: refreshError } = await supabase.auth.refreshSession()
    // Refresh failed too — including signed-out/revoked sessions, where there is nothing left
    // to refresh. The original rejection is the more honest one to surface, and the query's own
    // error state (with its Try again control) remains the recovery path.
    if (refreshError) throw error
    return await operation()
  }
}
