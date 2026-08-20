/// <reference types="node" />
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

/**
 * Shared harness for the database and authorization suites (docs/TESTING.md §4-5).
 *
 * Creating a test user changed in M4. The S2 backstop trigger means no `auth.users` row can be
 * inserted without a live invitation claim, and that holds for the Auth Admin API too — so
 * `auth.admin.createUser` on its own no longer works, by design. Fixture users therefore take
 * exactly the route the redeem-invitation function takes: issue an invitation, claim it, create
 * the user, record the redemption. Every step of it is service-role-only, which is the point:
 * nothing a browser holds can reproduce it.
 *
 * `redeemInvitation` below drives the real Edge Function over HTTP instead, and is what the
 * invite-only attack tests use. The two exist side by side deliberately — the fast path builds
 * fixtures, the real path is the thing under test.
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

function nextEmail(label: string): string {
  counter += 1
  return `m4-test-${label}-${Date.now()}-${counter}@example.invalid`
}

/** A password that always satisfies the policy in supabase/config.toml and never repeats. */
export function syntheticPassword(): string {
  return `Test-${crypto.randomUUID()}`
}

/**
 * The same SHA-256 the database computes, implemented independently here so the two are a
 * cross-check on each other rather than one shared helper being wrong in both places.
 */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function randomInvitationToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
    .toString('base64url')
    .replace(/=+$/, '')
}

/**
 * The row shapes the invitation RPCs return. The clients in this directory are deliberately
 * untyped (see eslint.config.js) — they impersonate an attacker holding nothing but a key, and
 * a generated schema type would quietly stop half these tests from compiling the moment they try
 * something the schema says is impossible. These interfaces name what the SQL actually returns,
 * at the few points a test reads a value rather than an error.
 */
export interface IssuedInvitation {
  invitation_id: string
  token: string
  invited_email: string
  expires_at: string
}

export interface InvitationStatus {
  valid: boolean
  invited_email: string | null
}

export interface DirectInvitation {
  id: string
  token: string
  email: string
}

/**
 * Writes an invitation straight into the table under the service role, with a token this process
 * generated. Used where a test needs an invitation in a specific state (expired, revoked, already
 * redeemed) that `create_invitation` deliberately refuses to produce.
 *
 * `created_by: null` is the bootstrap shape the schema allows — an invitation issued through
 * privileged database access rather than by a signed-in admin.
 */
export async function createInvitationDirect(
  service: TestClient,
  options: {
    email?: string
    label?: string
    expiresAt?: Date
    revokedAt?: Date
    maxUses?: number
    createdBy?: string
  } = {},
): Promise<DirectInvitation> {
  const email = options.email ?? nextEmail('invited')
  const token = randomInvitationToken()

  const { data, error } = await service
    .from('invitations')
    .insert({
      token_hash: hashInvitationToken(token),
      email,
      label: options.label ?? null,
      created_by: options.createdBy ?? null,
      expires_at: (options.expiresAt ?? new Date(Date.now() + 86_400_000)).toISOString(),
      revoked_at: options.revokedAt?.toISOString() ?? null,
      max_uses: options.maxUses ?? 1,
    })
    .select('id')
    .single()

  if (error) throw new Error(`failed to create invitation: ${error.message}`)
  return { id: data.id as string, token, email }
}

/**
 * Creates a confirmed, password-auth synthetic user. Never a real person, and never an address
 * that could resolve — `.invalid` is reserved by RFC 2606 precisely so it cannot.
 */
export async function createSyntheticUser(
  service: TestClient,
  label: string,
): Promise<SyntheticUser> {
  const email = nextEmail(label)
  const password = syntheticPassword()
  const invitation = await createInvitationDirect(service, { email })

  const claim = await service.rpc('claim_invitation', { p_token: invitation.token }).maybeSingle()
  const claimed = claim.data as { claim_id: string } | null
  if (claim.error || !claimed) {
    throw new Error(
      `failed to claim invitation for ${label}: ${claim.error?.message ?? 'no claim'}`,
    )
  }

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) {
    throw new Error(`failed to create synthetic user ${label}: ${error.message}`)
  }

  const finalized = await service.rpc('finalize_invitation_redemption', {
    p_claim_id: claimed.claim_id,
    p_user_id: data.user.id,
  })
  if (finalized.error) {
    throw new Error(`failed to finalize redemption for ${label}: ${finalized.error.message}`)
  }

  return { id: data.user.id, email, password }
}

/** Promotes a user to admin the only way it can be done: out of band, with the service role. */
export async function promoteToAdmin(service: TestClient, userId: string): Promise<void> {
  const { error } = await service.from('profiles').update({ is_admin: true }).eq('id', userId)
  if (error) throw new Error(`failed to promote ${userId}: ${error.message}`)
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

export interface RedeemResult {
  status: number
  body: { ok?: boolean; error?: string; message?: string; email?: string }
}

/**
 * Calls the deployed redeem-invitation Edge Function over HTTP, the way a browser does. The
 * apikey header carries the publishable/anon key, which is public by design and grants nothing —
 * the invitation token is what authorizes this request.
 */
export async function redeemInvitation(token: string, password: string): Promise<RedeemResult> {
  const url = requireEnv('SUPABASE_URL')
  const anonKey = requireEnv('SUPABASE_ANON_KEY')

  const response = await fetch(`${url}/functions/v1/redeem-invitation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ token, password }),
  })

  let body: RedeemResult['body']
  try {
    body = (await response.json()) as RedeemResult['body']
  } catch {
    body = {}
  }
  return { status: response.status, body }
}

/** Reads the public invitation pre-check the invite page uses, with the anon key. */
export async function readInvitationStatus(token: string): Promise<InvitationStatus | null> {
  const { data, error } = await createAnonClient()
    .rpc('invitation_status', { p_token: token })
    .maybeSingle()
  if (error) throw new Error(`invitation_status failed: ${error.message}`)
  return data as InvitationStatus | null
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
