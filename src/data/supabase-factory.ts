import { createClient, type SupabaseClient, type SupabaseClientOptions } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { createExactTransportFetch, type ExactTransportOptions } from './exact-json-guard'

/**
 * The single place a Supabase client is constructed, kept free of `import.meta.env` so the
 * database test suites can build the SAME clients the app runs (tests/db/p146_*.test.ts,
 * tests/db/p147_*.test.ts).
 *
 * Two kinds of client exist and BOTH are built here, so the transport contract cannot diverge
 * between them:
 *
 *   - {@link createAppSupabaseClient}          the app's shared client; it owns the auth session.
 *   - {@link createAccessTokenSupabaseClient}  a client whose bearer comes from an `accessToken`
 *     provider — the identity-lease client (src/data/leased-client.ts, D-136).
 *
 * Every request and response of either kind passes through the exact-transport guard: a JSON
 * integer literal that a JavaScript number cannot hold exactly is refused (request) or quoted so
 * its digits survive (response) — see src/data/exact-json-guard.ts and docs/DECISIONS.md D-137.
 * The guard wraps the fetch that actually reaches the network and is the ONLY thing done to it:
 * authentication is decided by the `auth` / `accessToken` option alone, and no token is read,
 * stored or logged here (D-138).
 */

type PublicClientOptions = SupabaseClientOptions<'public'>

/** Everything about a client that is not the URL, the key or the guard's own reporting hook. */
export interface ClientExtras {
  /** Auth options of the app's shared client (P143: explicit storage key and storage medium). */
  auth?: PublicClientOptions['auth']
  /** The transport underneath the guard. Default: the platform `fetch`. Tests stand in for the
   *  network here; the guard still wraps it. */
  baseFetch?: typeof fetch
}

export function createAppSupabaseClient(
  url: string,
  publishableKey: string,
  transport: ExactTransportOptions = {},
  extras: ClientExtras = {},
): SupabaseClient<Database> {
  return createClient<Database>(url, publishableKey, {
    ...(extras.auth ? { auth: extras.auth } : {}),
    global: { fetch: createExactTransportFetch(extras.baseFetch ?? fetch, transport) },
  })
}

/**
 * A client authenticated by `accessToken` alone. supabase-js removes `client.auth` on such a
 * client, so there is exactly one authentication truth: whatever the provider returns for each
 * request. `auth` options are deliberately not accepted — a second, independent auth state is the
 * thing this shape exists to rule out.
 */
export function createAccessTokenSupabaseClient(
  url: string,
  publishableKey: string,
  accessToken: () => Promise<string | null>,
  transport: ExactTransportOptions = {},
  extras: Omit<ClientExtras, 'auth'> = {},
): SupabaseClient<Database> {
  return createClient<Database>(url, publishableKey, {
    accessToken,
    global: { fetch: createExactTransportFetch(extras.baseFetch ?? fetch, transport) },
  })
}
