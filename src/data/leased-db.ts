import type { IdentityLease } from '../auth/identity-lease'
import { createLeasedDb, type LeasedDb } from './leased-client'
import { supabase, supabasePublishableKey, supabaseUrl } from './supabase-client'

/**
 * Binds {@link createLeasedDb} to the app's Supabase session. Kept apart from leased-client.ts so
 * that module stays free of any Vite build-environment access and can be unit-tested with a fake session.
 */

const clients = new WeakMap<IdentityLease, LeasedDb>()

/** The client for one lease; the same instance every time for the same lease. */
export function leasedDb(lease: IdentityLease): LeasedDb {
  let client = clients.get(lease)
  if (client === undefined) {
    client = createLeasedDb(lease, {
      url: supabaseUrl,
      publishableKey: supabasePublishableKey,
      getSession: () => supabase.auth.getSession(),
    })
    clients.set(lease, client)
  }
  return client
}
