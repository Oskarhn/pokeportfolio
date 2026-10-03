import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@shared/data/database.types'
import { sessionForLease, type IdentityLease } from '../auth/identity-authority'
import { createWriteFetch, type WriteFetchOptions } from './write-fetch'

/**
 * THE single write seam (P175). A {@link LeasedWriteDb} is a Supabase client bound to ONE logical
 * financial write. It differs from the app's shared client (`seam/supabase-client.ts`) in every way
 * that matters here:
 *
 *   - its bearer token is supplied by the `accessToken` client option, which is asked FRESH for
 *     every request and hands out a token only if the lease is still current AND the session
 *     Supabase holds right now belongs to the lease's user (`sessionForLease`);
 *   - its fetch allows only the finance write RPCs (`write/write-policy.ts`), nothing else;
 *   - it has no usable `auth` subsystem (supabase-js makes `client.auth` throw once `accessToken`
 *     is set) and persists nothing: no token is stored, cached or replayed.
 *
 * Why this closes the window instead of narrowing it (ported reasoning, P149 `leased-client.ts`):
 * a step-by-step `assertCurrent()` between awaits leaves the interval between the check and the
 * moment the request is actually built open — an identity change (or a same-tab, same-user token
 * refresh racing a slow write) could still land in it. Here the token is CHOSEN by the same code
 * that just verified it, synchronously after the last await, and supabase-js attaches exactly that
 * value; from that point on nothing can make the request authenticate as anyone else. A write
 * already on its way to the network when the identity changes therefore still completes as the
 * user it belongs to (never as the new identity) — the one allowed outcome under the mission's
 * "may finish as A, must never continue as B" rule.
 */

export type Db = SupabaseClient<Database>

/** A client bound to one identity lease. Functions that take this type cannot be handed the
 *  ambient shared client by mistake — the compiler rejects it (structurally distinct nominal tag). */
export type LeasedWriteDb = Db & { readonly writeLease: IdentityLease }

export interface LeasedWriteClientDeps {
  url: string
  publishableKey: string
  /** `supabase.auth.getSession`, looked up at call time — never cached here. */
  getSession: () => Promise<{
    data: { session: { access_token: string; user: { id: string } } | null }
    error?: unknown
  }>
  /** Transport override; tests stand in for the network. The app uses the platform `fetch`. */
  fetch?: typeof fetch
  fetchOptions?: WriteFetchOptions
}

export function createLeasedWriteDb(
  lease: IdentityLease,
  deps: LeasedWriteClientDeps,
): LeasedWriteDb {
  // supabase-js calls the accessToken provider once, synchronously, during construction (to prime
  // realtime, which this client never uses). Answering with the publishable key here — never
  // touching the session — is what stops a second, unwanted call later; every REQUEST this client
  // can ever make goes through the real check below, once construction has returned.
  let constructing = true

  const accessToken = async (): Promise<string | null> => {
    if (constructing) return deps.publishableKey
    const session = await sessionForLease(lease, () => deps.getSession())
    lease.assertCurrent()
    return session.access_token
  }

  const client = createClient<Database>(deps.url, deps.publishableKey, {
    accessToken,
    global: { fetch: createWriteFetch(deps.fetch ?? fetch, deps.fetchOptions) },
  })
  constructing = false
  Object.defineProperty(client, 'writeLease', { value: lease, enumerable: false })
  return client as LeasedWriteDb
}
