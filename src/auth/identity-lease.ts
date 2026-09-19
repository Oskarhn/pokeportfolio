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

/** Stable outcome code for "the identity changed under a running operation". Expected control
 *  flow, not a fault: nothing about the aborted operation is reported as saved. */
export const AUTH_IDENTITY_CHANGED = 'auth-identity-changed'

/**
 * Thrown (and only ever thrown) when a lease is no longer current. The message is fixed text: it
 * carries no request detail, no server error and nothing of the operation's data, so it is safe to
 * show or log whatever identity is now on screen.
 */
export class AuthIdentityChangedError extends Error {
  readonly code = AUTH_IDENTITY_CHANGED
  constructor() {
    super('Your sign-in changed before this finished, so it was not completed.')
    this.name = 'AuthIdentityChangedError'
  }
}

export function isAuthIdentityChangedError(error: unknown): error is AuthIdentityChangedError {
  return error instanceof AuthIdentityChangedError
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

/**
 * Runs one logical operation under `lease`. The operation is not started at all when the lease is
 * already dead, and any failure that surfaces once the lease has ended is REPLACED by
 * {@link AuthIdentityChangedError}: what would otherwise leak out is a transport error, a raw
 * PostgREST message or a validation message about data that belongs to the previous identity.
 * A result that comes back from a step that was already dispatched is returned as it is — that
 * write happened as the user the operation belongs to.
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
    throw error
  }
}
