import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@shared/data/database.types'
import type { BackendConfig } from '../config/backend-config'
import { createSpikeFetch, type SpikeFetchOptions } from '../net/spike-fetch'
import type { SessionStorage } from './chunked-session-storage'

/** Explicit, so a deliberate sign-out can delete exactly this key through the adapter (P143 idea). */
export const AUTH_STORAGE_KEY = 'pokeportfolio-spike-auth'

export interface NativeClientDeps {
  storage: SessionStorage
  /** Transport under the guards. Default: the platform `fetch`. Tests stand in for the network. */
  baseFetch?: typeof fetch
  fetchOptions?: SpikeFetchOptions
}

/**
 * The one Supabase client of the native app. Options follow Supabase's React Native guidance
 * (docs read 2026-09-20): a custom storage adapter, `autoRefreshToken`, `persistSession`, and
 * `detectSessionInUrl: false` (there is no browser URL to parse; deep-link handling is a later step).
 * The foreground-only refresh loop is attached separately (`attachForegroundRefresh`).
 *
 * The client carries the PUBLISHABLE key only (loadBackendConfig refuses anything else) and every
 * request goes through the read-only policy + exact-transport guard (net/spike-fetch.ts).
 */
export function createNativeClient(
  config: BackendConfig,
  deps: NativeClientDeps,
): SupabaseClient<Database> {
  return createClient<Database>(config.url, config.publishableKey, {
    auth: {
      storage: deps.storage,
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: createSpikeFetch(deps.baseFetch ?? fetch, deps.fetchOptions) },
  })
}

export async function removeStoredSession(storage: SessionStorage): Promise<void> {
  await storage.removeItem(AUTH_STORAGE_KEY)
  await storage.removeItem(`${AUTH_STORAGE_KEY}-user`)
}
