/**
 * Identity pinning for multi-request exports.
 *
 * An export is many sequential requests, and every one of them must run as the account it was
 * started under. If the tab (or another tab, through the shared session storage) switches from
 * account A to account B mid-export, the remaining requests would be answered as B: the file
 * would silently mix A's early sections with B's later ones, or hand A's captured data to B's UI.
 * The identity boundary (query-cache-boundary.ts, AuthIdentityBoundary) clears caches and
 * remounts the UI, but an export is plain async code, not a query, so it survives both and must
 * pin its own identity.
 *
 * THE AUTHORITY IS THE IDENTITY LEASE (P145, src/auth/identity-lease.ts). The app always exports
 * through a leased client (data/leased-client.ts), which carries the lease it was created for. The
 * guard of such a client is the lease itself: `assertUnchanged()` is `lease.assertCurrent()`.
 * Two things follow that a user-id comparison cannot give:
 *
 *   - A -> B -> A is detected. The lease is bound to the identity EPOCH, so an old A generation
 *     does not come back to life when the same user id reappears.
 *   - A same-user token refresh, USER_UPDATED or a repeated SIGNED_IN does not end the lease, so
 *     a legitimate refresh mid-export does not abort it.
 *
 * On top of that, the leased client itself refuses to attach a bearer token unless the session it
 * finds in storage right now belongs to the lease's user, so a request cannot even be SENT as
 * anybody else. What the lease check adds here is the other side of the request: it runs before
 * AND after every request, so a page that came back while the identity ended is discarded rather
 * than kept, and once more before the snapshot leaves the fetch layer. This is detection at
 * request granularity, not isolation or an atomic snapshot (D-077, D-141).
 *
 * A plain client (no lease) is not used by the app: artifacts.ts accepts only a leased client and
 * tests/ui/export-identity-lease-coverage.test.ts fails if a production module hands the shared
 * client to the export. The DB harnesses that read a signed-in test client directly get the
 * session-based fallback below, which is per-request detection on the user id only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthIdentityChangedError, type IdentityLease } from '../../auth/identity-lease'
import type { Database } from '../database.types'

export interface ExportIdentityGuard {
  /** The user the export started under. Diagnostic only — never sent to the server. */
  readonly userId: string
  /** Rejects with {@link AuthIdentityChangedError} unless the export is still its own identity. */
  assertUnchanged(): Promise<void>
}

/** The guard of a leased client: the lease is the whole answer. */
export function exportIdentityFromLease(lease: IdentityLease): ExportIdentityGuard {
  lease.assertCurrent()
  return {
    userId: lease.userId,
    assertUnchanged() {
      lease.assertCurrent()
      return Promise.resolve()
    },
  }
}

function leaseOf(client: SupabaseClient<Database>): IdentityLease | undefined {
  return (client as { identityLease?: IdentityLease }).identityLease
}

/**
 * Resolves the exporting identity of `client`: the lease of a leased client, else the verified
 * session of a plain one. Throws if there is none.
 */
export async function beginExportIdentity(
  client: SupabaseClient<Database>,
): Promise<ExportIdentityGuard> {
  const lease = leaseOf(client)
  if (lease !== undefined) return exportIdentityFromLease(lease)

  const auth = await client.auth.getUser()
  const userId: string | undefined = auth.data.user?.id
  if (auth.error !== null || userId === undefined) {
    throw new Error('Export requires an authenticated session')
  }
  return {
    userId,
    async assertUnchanged() {
      const { data, error } = await client.auth.getSession()
      if (error !== null || data.session?.user.id !== userId) {
        throw new AuthIdentityChangedError()
      }
    },
  }
}
