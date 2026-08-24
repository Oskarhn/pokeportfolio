import { supabase } from './supabase-client'

/**
 * One-shot recovery for the cold-start expired-token failure class (P27 owner report: Search
 * errored on first visit, worked on the second attempt).
 *
 * Mechanism: supabase-js restores the persisted session from local storage before any network
 * round trip has validated it, and rotates an expired access token in the background. A catalog
 * query issued inside that window carries the not-yet-rotated token and PostgREST rejects it
 * ("JWT expired" / PGRST301 / 401-class failures) — once. By the second navigation the rotation
 * has finished, which is exactly the reported error-once-then-works shape.
 *
 * This is deliberately narrow: only messages matching that failure class trigger a forced
 * `refreshSession()` and exactly one replay of the operation. Every other error (RLS denial,
 * network down, provider 5xx) propagates untouched — no blanket catch, no retry storm.
 */
const AUTH_FAILURE = /(jw[ts]|pgrst301|\b401\b|invalid api key)/i

export function isAuthFailure(error: unknown): boolean {
  return error instanceof Error && AUTH_FAILURE.test(error.message)
}

export async function withAuthRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const { error: refreshError } = await supabase.auth.refreshSession()
    // Refresh failed too — the original rejection is the more honest one to surface, and the
    // query's own error state (with its Try again control) remains the recovery path.
    if (refreshError) throw error
    return await operation()
  }
}
