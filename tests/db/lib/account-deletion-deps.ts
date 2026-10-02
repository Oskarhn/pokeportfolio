import pg from 'pg'
import { createAnonClient } from '../setup'
import type { TestClient } from '../setup'
import type { AccountDeletionDeps } from '../../../supabase/functions/_shared/account-deletion'
import { appendErasure, loadSinkConfig } from '../../../supabase/functions/_shared/erasure-sink'
import { USER_OWNED_TABLES } from './account-ledger-fixture'

/**
 * The real dependencies for the deletion core, built from the same calls the Edge Function makes
 * (supabase/functions/delete-account/index.ts) but running in-process against the local stack.
 *
 * Why it exists: failure injection. The deployed function contains no fault hook by design, so the
 * interrupted-deletion tests wrap THESE dependencies — real database, real Auth — and make one
 * step fail. The HTTP tests in tests/authorization/p152_account_deletion_attacks.test.ts exercise
 * the actual deployed wrapper, which is what keeps this mirror honest.
 */
export function realDeps(
  service: TestClient,
  overrides: Partial<AccountDeletionDeps> = {},
): AccountDeletionDeps & { logs: string[] } {
  const logs: string[] = []
  // The same registry client the Edge Function uses, pointed at the sink tests/db/global-setup.ts
  // runs (the test process reaches it on the loopback address of the same port).
  const sinkUrl = process.env.ERASURE_REGISTRY_URL
  const sink = loadSinkConfig({
    get: (name) =>
      name === 'ERASURE_REGISTRY_URL' && sinkUrl
        ? sinkUrl.replace('host.docker.internal', '127.0.0.1')
        : process.env[name],
  })
  const deps: AccountDeletionDeps = {
    registryConfigured: () => sink !== null,
    async prepareErasure(userId) {
      const { data, error } = await service.rpc('prepare_account_erasure', { p_user_id: userId })
      if (error || !data) throw new Error(`prepare failed: ${error?.message ?? 'no data'}`)
      const row = data as { deletion_id: string; subject_hash: string; registry_state: string }
      return {
        deletionId: row.deletion_id,
        subject: row.subject_hash,
        recorded: row.registry_state === 'recorded',
      }
    },
    async appendToRegistry(input) {
      if (sink === null) throw new Error('registry not configured')
      return appendErasure(sink, input)
    },
    async confirmErasure(userId, deletionId, seq) {
      const { error } = await service.rpc('record_account_erasure', {
        p_user_id: userId,
        p_deletion_id: deletionId,
        p_registry_seq: seq,
      })
      if (error) throw new Error(`confirm failed: ${error.message}`)
    },
    async authenticate(token) {
      const { data, error } = await service.auth.getUser(token)
      if (error) {
        const status = (error as { status?: number }).status
        if (status !== undefined && status >= 400 && status < 500) return null
        throw new Error('auth unavailable')
      }
      if (!data.user.email) return null
      const providers = new Set<string>([
        ...(data.user.identities ?? []).map((i) => i.provider),
        ...(((data.user.app_metadata as { providers?: unknown }).providers as
          string[] | undefined) ?? []),
      ])
      const verifiedFactor = (data.user.factors ?? []).some((f) => f.status === 'verified')
      return {
        id: data.user.id,
        email: data.user.email,
        passwordReauthentication: providers.has('email') && !verifiedFactor,
      }
    },
    async verifyPassword(email, password) {
      const { error } = await createAnonClient().auth.signInWithPassword({ email, password })
      if (!error) return 'ok'
      return (error as { status?: number }).status === 400 ? 'invalid' : 'unavailable'
    },
    async beginDeletion(userId) {
      const { error } = await service.rpc('begin_account_deletion', { p_user_id: userId })
      if (!error) return 'pending'
      if (error.code === '23503') return 'user_gone'
      throw new Error(`begin failed: ${error.message}`)
    },
    async purgeData(userId) {
      // Mirrors the Edge Function: call until the purge reports complete.
      for (let call = 0; call < 500; call++) {
        const { data, error } = await service.rpc('purge_account_data', { p_user_id: userId })
        if (error) {
          if (error.message.includes('account_deletion_not_requested')) return 'account_gone'
          throw new Error(`purge failed: ${error.message}`)
        }
        if ((data as { complete?: boolean } | null)?.complete === true) return 'purged'
      }
      throw new Error('purge did not converge')
    },
    async deleteAuthUser(userId) {
      const { error } = await service.auth.admin.deleteUser(userId, false)
      if (!error) return 'deleted'
      const code = (error as { code?: string }).code
      if (error.status === 404 || code === 'user_not_found') return 'not_found'
      throw new Error(`auth delete failed: ${error.message}`)
    },
    async scrubAuditTrail(userId) {
      await service.rpc('scrub_account_audit_trail', { p_user_id: userId })
    },
    async recordStage(userId, stage) {
      await service
        .from('account_deletion_requests')
        .update({ last_stage: stage })
        .eq('user_id', userId)
    },
    log(event, fields) {
      logs.push(JSON.stringify({ event, ...fields }))
    },
    ...overrides,
  }
  return Object.assign(deps, { logs })
}

/** A raw Postgres connection to the same database, for DDL fault injection and content digests. */
export async function connectDb(): Promise<pg.Client> {
  const url = process.env.DB_URL
  if (!url) throw new Error('DB_URL is not set (see tests/db/setup.ts)')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return client
}

/**
 * One digest per owned table for one user — content, not just row count, so "B was not touched"
 * means byte-identical rows rather than merely the same number of them.
 */
export async function ownedDigests(db: pg.Client, userId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const { table, column } of USER_OWNED_TABLES) {
    const res = await db.query<{ d: string }>(
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
         from public.${table} t where t.${column} = $1`,
      [userId],
    )
    out[table] = res.rows[0]!.d
  }
  return out
}

/** Digest of the whole shared catalog plus market data — must never change under a deletion. */
export async function sharedDigest(db: pg.Client): Promise<string> {
  const tables = [
    'card_series',
    'card_sets',
    'cards',
    'card_variants',
    'fx_rates',
    'price_snapshots',
  ]
  const parts: string[] = []
  for (const t of tables) {
    const res = await db.query<{ d: string }>(
      `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as d from public.${t} x`,
    )
    parts.push(res.rows[0]!.d)
  }
  const shared = await db.query<{ d: string }>(
    `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as d
       from public.sealed_products x where x.created_by_user_id is null`,
  )
  parts.push(shared.rows[0]!.d)
  return parts.join(':')
}

/**
 * begin_account_deletion followed by the restore-safe record, exactly as the Edge Function orders
 * it (P189): the database refuses to purge until the erasure is recorded, so a suite that drives
 * the purge directly has to go through this first. The record goes to the REAL registry sink the
 * suites start (tests/db/global-setup.ts), so the database's witness copy and the registry agree.
 */
export async function recordErasure(
  service: TestClient,
  userId: string,
): Promise<{ error: { message: string } | null }> {
  const deps = realDeps(service)
  try {
    const prepared = await deps.prepareErasure(userId)
    if (!prepared.recorded) {
      const receipt = await deps.appendToRegistry({
        deletionId: prepared.deletionId,
        subject: prepared.subject,
        deletedAt: new Date().toISOString().replace(/.d{3}Z$/, 'Z'),
      })
      await deps.confirmErasure(userId, receipt.deletionId, receipt.seq)
    }
  } catch (e) {
    return { error: { message: (e as Error).message } }
  }
  return { error: null }
}

export async function beginRecorded(
  service: TestClient,
  userId: string,
): Promise<{ error: { message: string } | null }> {
  const begun = await service.rpc('begin_account_deletion', { p_user_id: userId })
  if (begun.error) return { error: begun.error }
  return recordErasure(service, userId)
}
