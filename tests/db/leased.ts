import { IdentityAuthority, type IdentityLease } from '../../src/auth/identity-lease'
import type { ExactTransportOptions } from '../../src/data/exact-json-guard'
import { createLeasedDb, type LeasedDb } from '../../src/data/leased-client'
import type { createAppSupabaseClient } from '../../src/data/supabase-factory'

/**
 * The PRODUCTION leased client (src/data/leased-client.ts -> src/data/supabase-factory.ts), bound
 * to a signed-in test client's live session, for the database suites (P147).
 *
 * Nothing here re-implements a rule: `createLeasedDb` is the same function the app calls, the
 * lease is a real `IdentityAuthority` lease, and the session lookup is the real `getSession()` of
 * the signed-in client the suite already holds — so a test that goes through it exercises the
 * composed request path (identity check -> bearer -> exact-transport guard -> PostgREST).
 */
export interface LeasedHarness {
  db: LeasedDb
  lease: IdentityLease
  /** Drive the tab's observed identity: `authority.observe(otherUserId)` ends `lease`. */
  authority: IdentityAuthority
}

export function leasedHarness(
  signedIn: ReturnType<typeof createAppSupabaseClient>,
  userId: string,
  transport: ExactTransportOptions = {},
  overrides: { fetch?: typeof fetch } = {},
): LeasedHarness {
  const authority = new IdentityAuthority()
  authority.observe(userId)
  const lease = authority.begin(userId)
  const db = createLeasedDb(lease, {
    url: process.env.SUPABASE_URL as string,
    publishableKey: process.env.SUPABASE_ANON_KEY as string,
    getSession: () => signedIn.auth.getSession(),
    transport,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  })
  return { db, lease, authority }
}
