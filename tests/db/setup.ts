/// <reference types="node" />
import { createClient } from '@supabase/supabase-js'

/**
 * Shared harness for the database and authorization suites (docs/TESTING.md §4-5).
 *
 * Test users are created directly through the Auth admin API (service role), not through
 * `signUp` — M3 ships the invitations schema but not the redeem-invitation Edge Function (M4),
 * and local/CI Auth has public signup disabled anyway (supabase/config.toml). Creating users
 * out-of-band like this is also the correct long-term shape: synthetic test accounts should
 * never depend on the real invite-email flow.
 *
 * No generated `Database` type is wired in yet (src/data/database.types.ts arrives once
 * `pnpm db:types` has something to generate from), so clients here are untyped — `TestClient`
 * is the client shape these helpers actually return, used instead of the bare `SupabaseClient`
 * import so annotations stay structurally exact.
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Run \`pnpm db:start\` then export the values from ` +
        '`pnpm exec supabase status -o env` before running `pnpm test:db`.',
    )
  }
  return value
}

export function createServiceClient() {
  const url = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function createAnonClient() {
  const url = requireEnv('SUPABASE_URL')
  const anonKey = requireEnv('SUPABASE_ANON_KEY')
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export type TestClient = ReturnType<typeof createServiceClient>

export interface SyntheticUser {
  id: string
  email: string
  password: string
}

let counter = 0

/** Creates a confirmed, password-auth synthetic user via the service role. Never a real person. */
export async function createSyntheticUser(
  service: TestClient,
  label: string,
): Promise<SyntheticUser> {
  counter += 1
  const email = `m3-test-${label}-${Date.now()}-${counter}@example.invalid`
  const password = `Test-${crypto.randomUUID()}`

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) {
    throw new Error(`failed to create synthetic user ${label}: ${error.message}`)
  }
  return { id: data.user.id, email, password }
}

/** Returns an anon-key client authenticated as the given synthetic user. */
export async function signInAs(user: SyntheticUser): Promise<TestClient> {
  const client = createAnonClient()
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) {
    throw new Error(`failed to sign in as ${user.email}: ${error.message}`)
  }
  return client
}

export async function deleteSyntheticUser(service: TestClient, userId: string): Promise<void> {
  await service.auth.admin.deleteUser(userId)
}

/** Fixed catalog ids from supabase/seed/0001_catalog.sql. */
export const seedCatalog = {
  cardSeriesId: 'c0000000-0000-0000-0000-000000000001',
  cardSetId: 'c0000000-0000-0000-0000-000000000101',
  charizardCardId: 'c0000000-0000-0000-0000-000000000401',
  charizardVariantId: 'c0000000-0000-0000-0000-0000000a4001',
  pikachuVariantId: 'c0000000-0000-0000-0000-0000000a5801',
  grassEnergyVariantId: 'c0000000-0000-0000-0000-0000000a9901',
  sealedProductId: 'c0000000-0000-0000-0000-00000000b001',
} as const
