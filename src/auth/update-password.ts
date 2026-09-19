import { sessionForLease, type IdentityLease } from './identity-lease'

/**
 * Setting a new password is a user-scoped write to the auth service: it changes the credentials of
 * WHOEVER the browser's session belongs to when the request is made. supabase-js offers no
 * per-request credential for `auth.updateUser`, so unlike every data write (src/data/leased-client.ts,
 * D-136) it cannot be routed through a leased client. What can be done is to make the decision and
 * the call one uninterrupted step:
 *
 *   - refuse when the lease already ended (this tab has heard the identity change or sign out), and
 *   - refuse when the session the browser holds RIGHT NOW is not the lease owner's — which also
 *     covers a tab that has not been told yet (another tab already wrote B's session to the shared
 *     storage, or the browser has no BroadcastChannel and never hears about it).
 *
 * The lookup and `updateUser` are adjacent awaits on the same client with nothing between them but
 * promise continuations, so no auth event handler can run in the gap (the same argument as the
 * token provider in leased-client.ts). Without this, a recovery form typed under A and submitted
 * while the browser already held B's session would have set B's password to A's text.
 *
 * What this does NOT give, and why nothing supported can (P149 review, D-140): the data client picks
 * the token itself and the request carries exactly that token; `updateUser` picks its own. It calls
 * `_useSession()`, i.e. reads the shared storage a second time, and takes no credential argument, so
 * the identity verified here and the identity the request is made as are two reads of the same
 * storage. Another TAB writing that storage between the two reads is not excluded (its write is not
 * an event this tab has to process first). The remaining ways to bind the change to the identity are
 * a hand-made request with the stored access token (replaying a token, refused), a server-side
 * re-authentication nonce (needs `secure_password_change` and a hosted Auth setting), or an
 * undocumented parameter; none is a supported client-side option of this version.
 *
 * A lookup that merely FAILED (the auth service was unreachable while an expired token had to be
 * refreshed) is not an identity change: it throws AuthCredentialsUnavailableError, sends nothing and
 * leaves the lease alone, exactly as for a data write.
 */

export interface PasswordAuthClient {
  getSession: () => Promise<{
    data: { session: { user: { id: string } } | null }
    error?: unknown
  }>
  updateUser: (attributes: { password: string }) => Promise<{ error: unknown }>
}

/** Resolves with the auth service's error (or null) for the lease owner's own password change.
 *  Throws AuthIdentityChangedError, having sent nothing, when the identity is not the lease's, and
 *  AuthCredentialsUnavailableError, having sent nothing, when the session could not be looked up. */
export async function updatePasswordForLease(
  lease: IdentityLease,
  password: string,
  auth: PasswordAuthClient,
): Promise<{ error: unknown }> {
  await sessionForLease(lease, () => auth.getSession())
  lease.assertCurrent()
  return auth.updateUser({ password })
}
