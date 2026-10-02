import type { IdentityLease } from '../auth/identity-lease'
import type { DeletionProbe } from './account-deletion'
import { supabase } from './supabase-client'

/**
 * Asks Auth whether the lease owner's account still exists, for the one situation where the
 * deletion request's answer was lost. Only the session of the lease's own user is consulted, and
 * only Auth's explicit `user_not_found` counts as "gone": an expired or revoked session, a network
 * failure or somebody else's session all answer `false` (we do not know), never `true`.
 */
export function authAccountProbe(lease: IdentityLease): DeletionProbe {
  return {
    async accountIsGone() {
      try {
        const { data } = await supabase.auth.getSession()
        const session = data.session
        if (!session || session.user.id !== lease.userId) return false
        const { error } = await supabase.auth.getUser(session.access_token)
        return (error as { code?: string } | null)?.code === 'user_not_found'
      } catch {
        return false
      }
    },
  }
}
