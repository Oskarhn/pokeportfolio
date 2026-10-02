import { createAuthSessionStorage, deriveAuthStorageKey } from '../auth/session-storage'
import { createAppSupabaseClient } from './supabase-factory'

/**
 * The one Supabase client for the app. RLS is the actual access-control boundary (SECURITY.md
 * §2) — the anon key is public by design and grants nothing on its own.
 *
 * Parametrized with the generated `Database` type (database.types.ts, see supabase-factory.ts).
 * Note that generated `bigint` columns type as plain `number`, which is a boundary this project
 * does not trust for money — see src/data/money.ts. The client is built by
 * `createAppSupabaseClient`, whose fetch refuses any JSON integer a JavaScript number cannot hold
 * exactly (src/data/exact-json-guard.ts). Identity-bound writes use a leased client instead
 * (src/data/leased-client.ts), built by the same factory, so both carry the same guard.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!url || !publishableKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set. Copy .env.example to ' +
      '.env.local and fill in the values from the Supabase project dashboard — see ' +
      'docs/DEVELOPMENT.md §2.',
  )
}

/** Exposed for leased clients (P145), which need the same project and key but not the shared auth. */
export const supabaseUrl: string = url
export const supabasePublishableKey: string = publishableKey

/**
 * P143: the session's storage key and storage medium are stated explicitly instead of left to
 * supabase-js's defaults, so a deliberate sign-out can prove the stored session is gone (see
 * src/auth/session-storage.ts). Both are documented client options; the key is exactly the one
 * supabase-js derives by default, so browsers already signed in keep their session.
 */
export const AUTH_STORAGE_KEY = deriveAuthStorageKey(url)
export const authSessionStorage = createAuthSessionStorage()

export const supabase = createAppSupabaseClient(
  url,
  publishableKey,
  {},
  { auth: { storageKey: AUTH_STORAGE_KEY, storage: authSessionStorage } },
)
