/**
 * Which identity is this app in, and which generation of it. SPIKE subset of P149's
 * `IdentityAuthority` (src/auth/identity-lease.ts on branch fix/p149-auth-refresh-failure-recovery,
 * unreleased at 7fb83c2). The names and semantics are deliberately the same so that adopting the
 * released implementation is an import swap:
 *
 *   observe(userId)   record what Supabase auth reported; true when it is a REAL identity change
 *                     (A -> B, A -> signed out, signed out -> A); false for a repeat of the same
 *                     user, i.e. a token refresh or USER_UPDATED, which must keep unsaved work.
 *   retire()          end the identity NOW (deliberate sign-out), ahead of the auth event.
 *   begin(userId)     a lease for the identity the UI was rendered under; dead if that is not the
 *                     current identity.
 *
 * The epoch is a monotonic counter incremented on every real change, and an access token is never
 * consulted: a lease survives token refresh, and an A -> B -> A round trip does not resurrect a lease
 * taken in the first A session (which comparing user ids alone could not tell apart).
 *
 * This class only RECORDS what auth reported. It is never a second source of truth about the
 * session, and it must not grow one (see docs/mobile/AUTH_IDENTITY.md).
 */

export const AUTH_IDENTITY_CHANGED = 'auth-identity-changed'

export class AuthIdentityChangedError extends Error {
  readonly code = AUTH_IDENTITY_CHANGED
  constructor() {
    super('Your sign-in changed before this finished, so it was not completed.')
    this.name = 'AuthIdentityChangedError'
  }
}

export function isAuthIdentityChangedError(error: unknown): error is AuthIdentityChangedError {
  return error instanceof Error && (error as { code?: unknown }).code === AUTH_IDENTITY_CHANGED
}

export interface IdentityLease {
  readonly userId: string
  isCurrent(): boolean
  assertCurrent(): void
}

class Lease implements IdentityLease {
  constructor(
    private readonly authority: IdentityAuthority,
    readonly userId: string,
    private readonly epoch: number,
  ) {}

  isCurrent(): boolean {
    return this.authority.matches(this.userId, this.epoch)
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new AuthIdentityChangedError()
  }
}

export class IdentityAuthority {
  private currentUserId: string | null = null
  private currentEpoch = 0

  get userId(): string | null {
    return this.currentUserId
  }

  get epoch(): number {
    return this.currentEpoch
  }

  observe(userId: string | null): boolean {
    if (userId === this.currentUserId) return false
    this.currentUserId = userId
    this.currentEpoch += 1
    return true
  }

  retire(): boolean {
    return this.observe(null)
  }

  /** @internal */
  matches(userId: string, epoch: number): boolean {
    return this.currentUserId === userId && this.currentEpoch === epoch
  }

  /**
   * A lease for the identity the UI was rendered under. A signed-out app, or a rendered user that is
   * not the current one, yields a lease that is already dead (epoch -1 never matches).
   */
  begin(renderedUserId: string | null): IdentityLease {
    if (renderedUserId === null || renderedUserId !== this.currentUserId) {
      return new Lease(this, renderedUserId ?? '', -1)
    }
    return new Lease(this, renderedUserId, this.currentEpoch)
  }
}
