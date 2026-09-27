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
  /** Permanently ends this lease, whatever the authority itself says. Used by the write-request
   *  layer (write/leased-write-client.ts) when it finds the stored session belongs to somebody
   *  else, so a later `isCurrent()` cannot flip back to true (P149 `IdentityLease.revoke`). */
  revoke(): void
}

class Lease implements IdentityLease {
  private revoked = false

  constructor(
    private readonly authority: IdentityAuthority,
    readonly userId: string,
    private readonly epoch: number,
  ) {}

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

/**
 * Session-lookup leasing (P149's `sessionForLease` / `runWithLease` / `AuthCredentialsUnavailableError`,
 * src/auth/identity-lease.ts on the unreleased branch fix/p149-auth-refresh-failure-recovery). Ported
 * here rather than imported (P149 is web-only code coupled to nothing native), same names and
 * semantics on purpose.
 *
 * Financial writes need one more thing reads did not: a session lookup can FAIL without saying the
 * identity ended (an expired access token whose refresh could not reach the network). Treating that
 * failure as "identity changed" would show the wrong message and, worse, would let `runWithLease`'s
 * caller believe nothing more can be tried under this lease when in fact the person can just retry.
 */
export const AUTH_CREDENTIALS_UNAVAILABLE = 'auth-credentials-unavailable'

export class AuthCredentialsUnavailableError extends Error {
  readonly code = AUTH_CREDENTIALS_UNAVAILABLE
  constructor() {
    super('Could not verify your session. Check your connection and try again.')
    this.name = 'AuthCredentialsUnavailableError'
  }
}

export function isAuthCredentialsUnavailableError(
  error: unknown,
): error is AuthCredentialsUnavailableError {
  return (
    error instanceof Error && (error as { code?: unknown }).code === AUTH_CREDENTIALS_UNAVAILABLE
  )
}

/** What a session lookup answers: supabase-js's `getSession()` returns `{ session: null, error }`
 *  (it does not reject) when it cannot produce a session, and `{ session: null, error: null }`
 *  when nobody is signed in. */
export interface SessionLookupResult<S> {
  data: { session: S | null }
  error?: unknown
}

/** Leases whose most recent session lookup failed to produce credentials, without the identity
 *  itself having ended. `runWithLease` consults this to turn a bare transport error into the fixed
 *  {@link AuthCredentialsUnavailableError} text instead of leaking a raw PostgREST/library message. */
const failedLookups = new WeakSet<IdentityLease>()

function lookupFailed(lease: IdentityLease): never {
  failedLookups.add(lease)
  throw new AuthCredentialsUnavailableError()
}

/**
 * The session of the lease's own user, or a refusal saying which of three things happened:
 *
 *   identity ended   {@link AuthIdentityChangedError}, the lease revoked: it was already over (an
 *                    auth event reached the app), the lookup found nobody signed in, or it found
 *                    somebody else's session.
 *   lookup failed    {@link AuthCredentialsUnavailableError}, the lease left untouched: the lookup
 *                    rejected, or answered `{ session: null, error }`.
 *   ok               the session.
 *
 * A failed lookup does NOT revoke the lease and its error class is never consulted (P149's own
 * contract test against the real auth-js library establishes why: an expired access token that
 * cannot be refreshed answers `{ null, error }` for both a network failure — session kept — and a
 * lost cross-tab refresh race — session kept, under somebody else's fresh token). The one thing the
 * library guarantees is the other direction: a REAL removal is announced as SIGNED_OUT before the
 * lookup that triggered it answers, so by the time such a lookup returns the lease is already dead
 * and identity change takes precedence over whatever the lookup itself reports.
 */
export async function sessionForLease<S extends { user: { id: string } }>(
  lease: IdentityLease,
  lookup: () => Promise<SessionLookupResult<S>>,
): Promise<S> {
  lease.assertCurrent()
  let answer: SessionLookupResult<S>
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
    lease.revoke()
    throw new AuthIdentityChangedError()
  }
  if (session.user.id !== lease.userId) {
    lease.revoke()
    throw new AuthIdentityChangedError()
  }
  failedLookups.delete(lease)
  return session
}

/**
 * Runs one logical write under `lease`. Not started at all when the lease is already dead. A
 * failure that surfaces once the lease has ended is replaced by {@link AuthIdentityChangedError}
 * (a transport error or raw PostgREST message about data that belongs to the previous identity
 * must never reach the screen); a failure that surfaces while the lease is STILL current, whose
 * most recent credential lookup failed, is replaced by {@link AuthCredentialsUnavailableError}. A
 * result already in flight when the lease ends is returned as-is: that write happened as the user
 * it belongs to, and discarding a successful write's confirmation would be worse than showing it.
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
