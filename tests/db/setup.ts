/// <reference types="node" />
import { createHash, randomUUID } from 'node:crypto'
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

/**
 * P105: `counter` is module-local state — safe for uniqueness WITHIN one process, but Playwright
 * (and Vitest's own worker pool) runs test files in SEPARATE processes under real parallelism,
 * each with its own independent `counter` starting at 0. Two workers calling `nextEmail` with the
 * same `label` in the same millisecond (routine once a fix elsewhere made several parallel
 * workers finish in near-lockstep — see account-boundary.spec.ts's scanner-batch case) could
 * previously produce the IDENTICAL email string across processes, which surfaced as a real
 * `claim_invitation` failure (`invitation_pending`) under `--repeat-each` at default worker
 * parallelism. A random component makes cross-process collision astronomically unlikely
 * regardless of timing or process identity, without losing the human-readable label/counter for
 * debugging failed fixture setup.
 */
function nextEmail(label: string): string {
  counter += 1
  const unique = randomUUID().slice(0, 8)
  return `m4-test-${label}-${Date.now()}-${counter}-${unique}@example.invalid`
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

/**
 * `auth.users` foreign keys that do NOT cascade — confirmed directly against `pg_constraint`
 * (P108): every other user-owned table in the schema does `ON DELETE CASCADE`. This is
 * docs/HANDOVER.md's own already-disclosed, deliberately-BACKLOGGED gap ("Sales-family cascade gap
 * ... every post-M4 user_id FK lacks ON DELETE CASCADE"), which this file does not attempt to fix
 * at the schema level (out of P108's scope, and reopening a named backlog decision needs its own
 * review, not a side effect of a test-cleanup fix). What changes here is only that
 * `deleteSyntheticUser` stops being the reason the gap is invisible: before P108,
 * `auth.admin.deleteUser`'s result was discarded entirely (P107's finding), so a synthetic user who
 * owned a sale/sealed-product/etc simply stayed in `auth.users` forever with no error surfaced
 * anywhere — masking the gap AND leaking a real row into the next run.
 *
 * The five non-cascading tables are `sales`, `sale_lines`, `lot_disposals`, `lot_cost_adjustments`
 * and `sealed_products` (`created_by_user_id`) — but `sealed_products` is also the REFERENCED side
 * of three more FKs (`purchase_lines`, `holdings`, `openings`, none cascading), and `acquisition_lots`
 * and `openings` reference each other in a genuine cycle (`acquisition_lots.opening_id` /
 * `openings.source_lot_id`). Rather than re-deriving that graph by guesswork, this mirrors the
 * REAL, already-tested deletion order `reset_my_portfolio_data()` uses for exactly this purpose
 * (`20260901120010_p43_reset_and_history.sql`, extended by `20260902120020_m16_reset_history_
 * extension.sql` for the opening/lot cycle) — the one place in the product that already hard-deletes
 * this whole graph correctly. Reset itself stops short of deleting `sealed_products` (it preserves
 * a user's own products by design); test cleanup does not have that constraint and removes them too,
 * appended after everything that references them is already gone.
 */
/**
 * A scale test (tests/db/m13_export_perf.test.ts) can leave a synthetic user owning 10,000+ rows
 * in one of these tables; a single unbounded `DELETE ... WHERE column = value` over that many rows
 * has hit Postgres' `statement_timeout` on CI's shared runners (observed on `holdings`, non-
 * deterministically — the exact table that trips it depends on runner load). Batching by id keeps
 * every individual DELETE small regardless of total row count. Matches the project's existing
 * PostgREST URL-length-safety chunk size (src/data/export/fetch-snapshot.ts's
 * MANIFEST_CHUNK_SIZE) — 1000 ids in a `.in()` filter blew the URL length limit outright
 * ("cleanup failed: URI too long", CI run 34533936324) before this was reduced to 100.
 */
const CLEANUP_BATCH_SIZE = 100

async function deleteByColumnInBatches(
  service: TestClient,
  table: string,
  column: string,
  value: string,
  context: string,
): Promise<void> {
  for (;;) {
    const { data, error: selectError } = await service
      .from(table)
      .select('id')
      .eq(column, value)
      .limit(CLEANUP_BATCH_SIZE)
    if (selectError) {
      throw new Error(`cleanup failed (${context} select): ${selectError.message}`)
    }
    const ids = data.map((row) => row.id)
    if (ids.length === 0) return
    await mustDelete(service.from(table).delete().in('id', ids), context)
    if (ids.length < CLEANUP_BATCH_SIZE) return
  }
}

async function deleteAcquisitionLotsWithOpeningInBatches(
  service: TestClient,
  userId: string,
): Promise<void> {
  const context = 'acquisition_lots.opening_id cycle-break cleanup'
  for (;;) {
    const { data, error: selectError } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userId)
      .not('opening_id', 'is', null)
      .limit(CLEANUP_BATCH_SIZE)
    if (selectError) {
      throw new Error(`cleanup failed (${context} select): ${selectError.message}`)
    }
    const ids = data.map((row) => row.id)
    if (ids.length === 0) return
    await mustDelete(service.from('acquisition_lots').delete().in('id', ids), context)
    if (ids.length < CLEANUP_BATCH_SIZE) return
  }
}

async function deleteNonCascadingUserRows(service: TestClient, userId: string): Promise<void> {
  const byUserId = async (table: string) =>
    deleteByColumnInBatches(service, table, 'user_id', userId, `${table}.user_id cleanup`)

  await byUserId('lot_disposals')
  await byUserId('sale_lines')
  await byUserId('sales')
  await byUserId('lot_cost_adjustments')
  await byUserId('manual_valuations')
  // Break the acquisition_lots <-> openings cycle before either can be deleted outright.
  await deleteAcquisitionLotsWithOpeningInBatches(service, userId)
  await byUserId('openings')
  await byUserId('acquisition_lots')
  await byUserId('purchase_lines')
  await byUserId('holdings')
  await deleteByColumnInBatches(
    service,
    'sealed_products',
    'created_by_user_id',
    userId,
    'sealed_products.created_by_user_id cleanup',
  )
}

export async function deleteSyntheticUser(service: TestClient, userId: string): Promise<void> {
  await deleteNonCascadingUserRows(service, userId)

  // P120: the admin DELETE cascades through every remaining FK to auth.users (including
  // portfolio_recompute_queue), and this project's own M12 cron worker
  // (drain_portfolio_recompute_queue) can be mid-transaction against the SAME synthetic user's
  // queue row at the exact moment a test's afterAll runs this delete — reproduced for real
  // locally (`ERROR: deadlock detected (SQLSTATE 40P01)`, Postgres log: "Process ... DELETE FROM
  // users ... blocked by process ...  select public.drain_portfolio_recompute_queue(20)").
  // Postgres's own deadlock detector always aborts one side cleanly (no corruption either way) —
  // a deadlock is by definition transient, so a bounded retry is the correct, standard handling,
  // not a workaround for a logic bug. Every other error path (403 permission, a genuinely
  // blocking FK the list above missed) still fails fast and is never retried.
  //
  // P125: the ~10k-lot export scale audit's own teardown hit a DIFFERENT transient shape twice in
  // real GitHub Actions CI — "Processing this request timed out, please retry after a moment" —
  // which is GoTrue's own generic slow-request message, not the deadlock's SQLSTATE 40P01 path,
  // and can outlast the original 100-200ms backoff when the cascade genuinely has ~10k rows to
  // remove under CI's own resource variance. Retries now also cover any error whose message
  // names this timeout shape (not just status 500), with a longer, still-bounded backoff.
  const maxAttempts = 5
  let lastError: { status?: number; message: string } | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await service.auth.admin.deleteUser(userId)
    // Idempotent by design (an afterAll can legitimately run more than once against a user
    // already gone) — only a REAL failure (permission, a blocking FK the list above missed)
    // should fail the suite, per P107's finding that this call discarded its result entirely.
    if (!error || error.status === 404) {
      return
    }
    lastError = error
    const isRetryable = error.status === 500 || /timed out/i.test(error.message)
    if (!isRetryable || attempt === maxAttempts) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
  }
  throw new Error(`failed to delete synthetic user ${userId}: ${lastError?.message}`)
}

/**
 * Runs a Supabase query/delete builder and throws on any reported error, folding `context` into
 * the message. P107's finding: several `afterAll`/`beforeAll` cleanup blocks across tests/db/**
 * called `.delete()` without checking `.error` at all — a real failure (most commonly a foreign
 * key still pointing at the row) then left a stray fixture row in place, which surfaced far later
 * and far away as a confusing unique-constraint collision on the NEXT run rather than a clear
 * cleanup error on THIS one. Use this for any cleanup delete whose success later tests or later
 * runs actually depend on.
 */
export async function mustDelete(
  builder: PromiseLike<{ error: { message: string } | null }>,
  context: string,
): Promise<void> {
  const { error } = await builder
  if (error) {
    throw new Error(`cleanup failed (${context}): ${error.message}`)
  }
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
  charizardShadowlessFirstEditionVariantId: 'c0000000-0000-0000-0000-0000000a4002',
  pikachuCardId: 'c0000000-0000-0000-0000-000000000581',
  pikachuVariantId: 'c0000000-0000-0000-0000-0000000a5801',
  grassEnergyCardId: 'c0000000-0000-0000-0000-000000000991',
  grassEnergyVariantId: 'c0000000-0000-0000-0000-0000000a9901',
  japaneseSeriesId: 'c0000000-0000-0000-0000-000000000002',
  japaneseSetId: 'c0000000-0000-0000-0000-000000000102',
  japaneseCardId: 'c0000000-0000-0000-0000-000000000701',
  japaneseVariantId: 'c0000000-0000-0000-0000-0000000a7001',
  sealedProductId: 'c0000000-0000-0000-0000-00000000b001',
} as const
