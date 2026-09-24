import { classifyFailure, type Failure } from '../net/failure'
import { AuthIdentityChangedError, type IdentityAuthority } from '../auth/identity-authority'

/**
 * Runs an async load under the identity that was current when it STARTED and reports whether that
 * identity is still current when it finishes. A response that comes back after the identity changed
 * (A -> B, A -> signed out) is `stale` and must be discarded by the caller: it is never committed to
 * a store, so a late answer for user A can never appear under user B.
 *
 * Same idea as P149's `runWithLease`, over the same `IdentityAuthority` semantics; the network
 * request itself is not aborted (the shared data wrappers take no AbortSignal), its RESULT is
 * discarded.
 */
export type LeaseOutcome<T> =
  { kind: 'ok'; value: T } | { kind: 'failed'; failure: Failure } | { kind: 'stale' }

export async function runUnderIdentity<T>(
  authority: IdentityAuthority,
  work: () => Promise<T>,
): Promise<LeaseOutcome<T>> {
  const lease = authority.begin(authority.userId)
  try {
    lease.assertCurrent()
    const value = await work()
    if (!lease.isCurrent()) return { kind: 'stale' }
    return { kind: 'ok', value }
  } catch (error) {
    // An error that arrives after the identity changed belongs to the old identity: drop it too.
    if (!lease.isCurrent()) return { kind: 'stale' }
    if (error instanceof AuthIdentityChangedError) return { kind: 'stale' }
    return { kind: 'failed', failure: classifyFailure(error) }
  }
}
