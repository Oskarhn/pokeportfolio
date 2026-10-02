import type { SupabaseClient } from '@supabase/supabase-js'
import { sessionForLease, type IdentityLease } from '../auth/identity-lease'
import type { Database } from './database.types'
import type { ExactTransportOptions } from './exact-json-guard'
import { createAccessTokenSupabaseClient } from './supabase-factory'

/**
 * The request layer of an identity lease (P145).
 *
 * A {@link LeasedDb} is a Supabase client that belongs to ONE logical mutation. It differs from the
 * app's shared client in a single, documented way: the bearer token of every request it sends is
 * supplied by the `accessToken` client option, and that provider hands out a token ONLY if
 *
 *   - the lease is still current (same user, same identity epoch), and
 *   - the session Supabase holds RIGHT NOW belongs to the lease's user.
 *
 * Otherwise it revokes the lease and throws {@link AuthIdentityChangedError}, so no request is made.
 * The one exception is a session lookup that merely FAILED (P149, closes P148-M2): auth-js answers
 * `{ session: null, error }` for an expired token it could not refresh, which says nothing about who
 * is signed in. That throws {@link AuthCredentialsUnavailableError} instead, still without a request,
 * and leaves the lease alone so the person can try again; `sessionForLease` (src/auth/identity-lease.ts)
 * documents how the three outcomes are told apart.
 *
 * Why this closes the check-to-dispatch window instead of narrowing it. A step-by-step
 * `assertCurrent()` between awaits leaves the interval between the assertion and the moment
 * Supabase looks up the session (`getSession()` may refresh a token over the network, and reads
 * whatever the shared browser storage holds — which another tab may already have rewritten, ahead of
 * the BroadcastChannel event that tells this tab). Here the token is CHOSEN by the same code that
 * verified it: the value returned below is a specific user's access token, checked against the lease
 * synchronously after the last await, and supabase-js then attaches exactly that value. From that
 * point on nothing can make the request authenticate as anyone else, so whatever the identity does
 * afterwards the request completes as the user the operation belongs to — the allowed outcome.
 * Between the provider's return and `fetch()` there are only promise continuations (no task
 * boundary), so no auth event handler can even run in between.
 *
 * No token is stored, cached or replayed: every request asks the live session again, so a sign-out
 * (session gone) or a switch (someone else's session) ends the operation instead of finishing it
 * under stale credentials. Only documented supabase-js options are used (`accessToken`,
 * `auth.getSession`); the auth subsystem of a leased client is deliberately absent (supabase-js
 * makes `client.auth` throw when `accessToken` is set), which is why data functions that take a
 * lease read the user id from it instead of calling `auth.getUser()`.
 */

/** The shared Supabase client's type; a leased client has the same query surface. */
export type Db = SupabaseClient<Database>

/** A client bound to one identity lease. Data functions that take this type cannot be handed the
 *  shared client by mistake: the compiler rejects it. */
export type LeasedDb = Db & { readonly identityLease: IdentityLease }

export interface LeasedClientDeps {
  url: string
  publishableKey: string
  /** `supabase.auth.getSession`, looked up at call time. Its `error` is only ever tested for presence
   *  (see `sessionForLease`): supabase-js answers `{ session: null, error }` rather than rejecting. */
  getSession: () => Promise<{
    data: { session: { access_token: string; user: { id: string } } | null }
    error?: unknown
  }>
  /** Transport override; tests use it to stand in for the network. The app uses the default. The
   *  exact-transport guard wraps it either way (D-137): a leased client never bypasses it. */
  fetch?: typeof fetch
  /** Reporting hook of the exact-transport guard; the database suites install one. */
  transport?: ExactTransportOptions
}

export function createLeasedDb(lease: IdentityLease, deps: LeasedClientDeps): LeasedDb {
  // supabase-js calls the provider once, synchronously, while it is being constructed, to prime its
  // realtime client (which this app never uses on a leased client). Answering with the public
  // publishable key — not null — is what stops realtime from asking a second time, later. That call
  // must neither touch the session nor throw. It is answered before construction returns, so every
  // request that can ever be made is answered by the real check below.
  let constructing = true

  const accessToken = async (): Promise<string | null> => {
    if (constructing) return deps.publishableKey
    // Signed out, somebody else's session or an already-ended lease end the operation; a lookup that
    // merely FAILED (P149) is a distinct, retryable refusal that leaves the lease alone. Either way
    // this throws instead of returning: a request is never made without the lease owner's token.
    const session = await sessionForLease(lease, () => deps.getSession())
    lease.assertCurrent()
    return session.access_token
  }

  // One shared construction path with the app client (supabase-factory.ts): the same URL, key and
  // exact-money transport guard, plus this lease's token provider as the ONLY authentication.
  const client = createAccessTokenSupabaseClient(
    deps.url,
    deps.publishableKey,
    accessToken,
    deps.transport,
    deps.fetch ? { baseFetch: deps.fetch } : {},
  )
  constructing = false
  Object.defineProperty(client, 'identityLease', { value: lease, enumerable: false })
  return client as LeasedDb
}
