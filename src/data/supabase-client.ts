import { createAppSupabaseClient } from './supabase-factory'

/**
 * The one Supabase client for the app. RLS is the actual access-control boundary (SECURITY.md
 * §2) — the anon key is public by design and grants nothing on its own.
 *
 * Parametrized with the generated `Database` type (database.types.ts, see supabase-factory.ts).
 * Note that generated `bigint` columns type as plain `number`, which is a boundary this project
 * does not trust for money — see src/data/money.ts. The client is built by
 * `createAppSupabaseClient`, whose fetch refuses any JSON integer a JavaScript number cannot hold
 * exactly (src/data/exact-json-guard.ts).
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

export const supabase = createAppSupabaseClient(url, publishableKey)
