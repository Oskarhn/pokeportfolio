/**
 * Identity leases (P145, closes the in-flight half of P130-23 / P143 warning W1).
 *
 * P143 remounts the authenticated React subtree when the auth user changes, which destroys stale
 * FORMS. It cannot stop an async continuation that is already running: a mutation that began under
 * user A and is awaiting a later step keeps going after the remount, and every step that reads the
 * session afterwards reads B's — A's already-entered intent would be written into B's account.
 *
 * The invariant this module states and the rest of P145 enforces:
 *
 *     once a logical authenticated mutation begins under identity A, it never performs another
 *     user-scoped side effect under any other identity, and never under A's LATER sessions either.
 *
 * The identity of a tab is the pair (auth user id, epoch). The epoch is a monotonic counter owned
 * by the {@link IdentityAuthority} (which `AuthProvider` owns for the tab's whole lifetime) and
 * incremented on every real identity change: A -> B, A -> signed out, signed out -> A. Same-user
 * events (token refresh, USER_UPDATED, a repeated SIGNED_IN on refocus) do NOT change it, and an
 * access-token string is never consulted — so a lease survives token refresh, and an A -> B -> A
 * round trip does not resurrect a lease taken in the first A session, which the user id alone
 * could not tell apart.
 *
 * Pure and dependency-free (no React, no Supabase) so every rule is unit-testable without a DOM.
 */

import { UserFacingError } from '../platform/user-error'
/** Stable outcome code for "the identity changed under a running operation". Expected control
 *  flow, not a fault: nothing about the aborted operation is reported as saved. */
export const AUTH_IDENTITY_CHANGED = 'auth-identity-changed'

/**
 * Thrown (and only ever thrown) when a lease is no longer current. The message is fixed text: it
 * carries no request detail, no server error and nothing of the operation's data, so it is safe to
 * show or log whatever identity is now on screen.
 */
export class AuthIdentityChangedError extends UserFacingError {
  readonly code = AUTH_IDENTITY_CHANGED
  constructor() {
    super('Your sign-in changed before this finished, so it was not completed.', 'session_expired')
    this.name = 'AuthIdentityChangedError'
  }
}

export function isAuthIdentityChangedError(error: unknown): error is AuthIdentityChangedError {
  return error instanceof AuthIdentityChangedError
}

/** Stable outcome code for "the credentials could not be looked up just now". */
export const AUTH_CREDENTIALS_UNAVAILABLE = 'auth-credentials-unavailable'

/**
 * Thrown when the session lookup that precedes a request could not produce credentials and nothing
 * says the identity changed: the classic case is an expired access token that could not be refreshed
 * because the auth service was unreachable. Nothing was sent and the lease is left alone, so the
 * person can simply try again. Like {@link AuthIdentityChangedError} the text is fixed: no HTTP
 * detail, endpoint, token or library error class can reach the screen through it.
 */
export class AuthCredentialsUnavailableError extends UserFacingError {
  readonly code = AUTH_CREDENTIALS_UNAVAILABLE
  constructor() {
    super('Could not verify your session. Check your connection and try again.', 'connection')
    this.name = 'AuthCredentialsUnavailableError'
  }
}

export function isAuthCredentialsUnavailableError(
  error: unknown,
): error is AuthCredentialsUnavailableError {
  return error instanceof AuthCredentialsUnavailableError
}

/**
 * A claim that one logical mutation belongs to one identity. Obtained from
 * {@link IdentityAuthority.begin} at the moment the user commits to the action, then carried through
 * every later step of that action.
 */
export interface IdentityLease {
  /** The user this operation belongs to. */
  readonly userId: string
  /** True while the tab is still in the very identity epoch the lease was taken in. */
  isCurrent(): boolean
  /** Throws {@link AuthIdentityChangedError} unless {@link isCurrent}. */
  assertCurrent(): void
  /**
   * Permanently ends this lease. Called by the request layer when it finds the credentials on
   * offer belong to somebody else: whatever the observed identity says, the operation must stop.
   */
  revoke(): void
}

class Lease implements IdentityLease {
  readonly userId: string
  private readonly authority: IdentityAuthority
  private readonly epoch: number
  private revoked: boolean

  constructor(authority: IdentityAuthority, userId: string, epoch: number, startsRevoked: boolean) {
    this.authority = authority
    this.userId = userId
    this.epoch = epoch
    this.revoked = startsRevoked
  }

  isCurrent(): boolean {
    return !this.revoked && this.authority.matches(this.userId, this.epoch)
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new AuthIdentityChangedError()
  }

  revoke(): void {
    this.revoked = true
  }
}

/**
 * The single source of "which identity is this tab in, and which generation of it". It only ever
 * RECORDS what Supabase auth reported — `AuthProvider` feeds it from the same auth callback that
 * drives the cache boundary — and it is never a second source of truth about the session itself.
 */
export class IdentityAuthority {
  private currentUserId: string | null = null
  private currentEpoch = 0

  get userId(): string | null {
    return this.currentUserId
  }

  get epoch(): number {
    return this.currentEpoch
  }

  /**
   * Records the identity Supabase auth just reported. Returns true when this was a real identity
   * change (and every outstanding lease is therefore dead), false for a repeat of the same user.
   */
  observe(userId: string | null): boolean {
    if (userId === this.currentUserId) return false
    this.currentUserId = userId
    this.currentEpoch += 1
    return true
  }

  /**
   * Ends the identity NOW, ahead of the auth event, when this tab itself is signing out: a deliberate
   * sign-out can take seconds to reach the server, and no operation may start a new step in that
   * time. The later `observe(null)` is then a no-op.
   */
  retire(): void {
    this.observe(null)
  }

  /** @internal used by leases */
  matches(userId: string, epoch: number): boolean {
    return this.currentUserId === userId && this.currentEpoch === epoch
  }

  /**
   * Starts a lease for the identity the UI was RENDERED under. Passing the rendered user id (not
   * reading the authority's own) is deliberate: if the identity already changed but React has not
   * yet committed the remount, a click on the stale form must not silently adopt the new identity.
   * Any mismatch, and a signed-out tab, yields a lease that is already dead: the first
   * `assertCurrent()` throws, so callers need no special case.
   */
  begin(renderedUserId: string | null): IdentityLease {
    if (renderedUserId === null || renderedUserId !== this.currentUserId) {
      return new Lease(this, renderedUserId ?? '', -1, true)
    }
    return new Lease(this, renderedUserId, this.currentEpoch, false)
  }
}

/** What a session lookup answers: `getSession()` of supabase-js returns `{ session: null, error }` (it
 *  does not reject) when it cannot produce a session, and `{ session: null, error: null }` when
 *  nobody is signed in. */
export interface SessionLookup<S> {
  data: { session: S | null }
  error?: unknown
}

/** Leases whose most recent session lookup failed to produce credentials. */
const failedLookups = new WeakSet<IdentityLease>()

function lookupFailed(lease: IdentityLease): never {
  failedLookups.add(lease)
  throw new AuthCredentialsUnavailableError()
}

/**
 * The session of the lease's own user, or a refusal that says which of three things happened. This
 * is the one place that reads a session lookup on behalf of a lease (the data requests of
 * src/data/leased-client.ts and the password change of src/auth/update-password.ts both use it).
 *
 *   identity ended   {@link AuthIdentityChangedError}, the lease revoked: the lease was already over
 *                    (an auth event reached this tab), or the lookup found NOBODY signed in (no
 *                    session, no error), or found SOMEBODY ELSE's session.
 *   lookup failed    {@link AuthCredentialsUnavailableError}, the lease untouched: the lookup
 *                    rejected, or answered `{ session: null, error }`.
 *   ok               the session.
 *
 * Why a failed lookup does not end the lease, and why its error class is not consulted. auth-js
 * answers `{ null, error }` for an expired access token it could not refresh, and the error class
 * does not say whether the person is still signed in (tests/data/p149-auth-lookup-contract.test.ts):
 * a network failure or a 5xx leaves the stored session in place and announces nothing, and even a
 * definitive-looking AuthApiError is returned to the caller that lost a refresh race to another tab,
 * whose fresh session is already stored. What auth-js does guarantee is the other direction: when it
 * really removes a session it awaits `SIGNED_OUT` before answering. That event is what ends the
 * lease, through {@link IdentityAuthority.observe}, so by the time such a lookup answers the lease
 * is already dead and identity change takes precedence over whatever error came back (the first
 * `assertCurrent` after the lookup). A lookup failure with the lease still current is therefore
 * never proof of anything except that nothing can be sent right now: fail closed, say so, keep the
 * lease, and let the next attempt read the storage again.
 */
export async function sessionForLease<S extends { user: { id: string } }>(
  lease: IdentityLease,
  lookup: () => Promise<SessionLookup<S>>,
): Promise<S> {
  lease.assertCurrent()
  let answer: SessionLookup<S>
  try {
    answer = await lookup()
  } catch {
    lease.assertCurrent() // an identity change heard meanwhile is what the person must be told about
    return lookupFailed(lease)
  }
  lease.assertCurrent()
  const session = answer.data.session
  if (session === null) {
    if (answer.error !== undefined && answer.error !== null) return lookupFailed(lease)
    // Nobody is signed in: this operation is over.
    lease.revoke()
    throw new AuthIdentityChangedError()
  }
  if (session.user.id !== lease.userId) {
    // The browser now holds somebody else's session, possibly before this tab has heard about it.
    lease.revoke()
    throw new AuthIdentityChangedError()
  }
  failedLookups.delete(lease)
  return session
}

/**
 * Runs one logical operation under `lease`. The operation is not started at all when the lease is
 * already dead, and any failure that surfaces once the lease has ended is REPLACED by
 * {@link AuthIdentityChangedError}: what would otherwise leak out is a transport error, a raw
 * PostgREST message or a validation message about data that belongs to the previous identity.
 * A result that comes back from a step that was already dispatched is returned as it is — that
 * write happened as the user the operation belongs to.
 *
 * A failure that surfaces while the lease is STILL current, and whose most recent credential lookup
 * failed, is replaced by {@link AuthCredentialsUnavailableError}: the data layer rebuilds every
 * request error from a message string (`new Error(error.message)`), so the class thrown by the
 * provider does not survive to here, and its text would arrive prefixed with the internal class name.
 */
export async function runWithLease<T>(
  lease: IdentityLease,
  operation: () => Promise<T>,
): Promise<T> {
  lease.assertCurrent()
  try {
    return await operation()
  } catch (error) {
    if (!lease.isCurrent()) throw new AuthIdentityChangedError()
    if (failedLookups.has(lease)) throw new AuthCredentialsUnavailableError()
    throw error
  }
}
