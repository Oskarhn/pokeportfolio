import { AuthIdentityChangedError, type IdentityLease } from './identity-lease'

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
 */

export interface PasswordAuthClient {
  getSession: () => Promise<{ data: { session: { user: { id: string } } | null } }>
  updateUser: (attributes: { password: string }) => Promise<{ error: unknown }>
}

/** Resolves with the auth service's error (or null) for the lease owner's own password change.
 *  Throws {@link AuthIdentityChangedError}, having sent nothing, when the identity is not the lease's. */
export async function updatePasswordForLease(
  lease: IdentityLease,
  password: string,
  auth: PasswordAuthClient,
): Promise<{ error: unknown }> {
  lease.assertCurrent()
  const { data } = await auth.getSession()
  if (data.session === null || data.session.user.id !== lease.userId) {
    lease.revoke()
    throw new AuthIdentityChangedError()
  }
  lease.assertCurrent()
  return auth.updateUser({ password })
}
