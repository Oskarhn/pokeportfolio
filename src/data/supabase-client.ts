import { createClient } from '@supabase/supabase-js'

/**
 * The one Supabase client for the app. RLS is the actual access-control boundary (SECURITY.md
 * §2) — the anon key is public by design and grants nothing on its own.
 *
 * Not yet parametrized with the generated `Database` type (`pnpm db:types` writes
 * src/data/database.types.ts) — this file is the client boundary M3 establishes; typed query
 * helpers arrive with the feature work that needs them (M5+), per the "no placeholder
 * repositories" rule in CLAUDE.md.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy .env.example to .env.local ' +
      'and fill in the values from the Supabase project dashboard — see docs/DEVELOPMENT.md §2.',
  )
}

export const supabase = createClient(url, anonKey)
