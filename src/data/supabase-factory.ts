import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { createExactTransportFetch, type ExactTransportOptions } from './exact-json-guard'

/**
 * The single place the app's Supabase client is constructed, kept free of `import.meta.env` so the
 * database test suites can build the SAME client the app runs (tests/db/p146_*.test.ts).
 *
 * Every request and response passes through the exact-transport guard: a JSON integer literal
 * that a JavaScript number cannot hold exactly is refused (request) or quoted so its digits
 * survive (response) — see src/data/exact-json-guard.ts and docs/DECISIONS.md D-137.
 */
export function createAppSupabaseClient(
  url: string,
  publishableKey: string,
  transport: ExactTransportOptions = {},
): SupabaseClient<Database> {
  return createClient<Database>(url, publishableKey, {
    global: { fetch: createExactTransportFetch(fetch, transport) },
  })
}
