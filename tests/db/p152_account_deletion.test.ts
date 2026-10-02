/* eslint-disable @typescript-eslint/require-await -- the injected dependency interface is async; the fakes here are deliberately trivial */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import {
  countOwnedRows,
  seedAccountLedger,
  USER_OWNED_TABLES,
  type SeededLedger,
} from './lib/account-ledger-fixture'
import { connectDb, ownedDigests, realDeps, sharedDigest } from './lib/account-deletion-deps'
import { handleAccountDeletion } from '../../supabase/functions/_shared/account-deletion'

/**
 * P152: account deletion against a real Postgres and a real GoTrue — the synthetic A/B/C proof, the
 * write guard, atomicity, and every interrupted/retried path. Everything is synthetic and
 * disposable. The deployed HTTP function is exercised separately
 * (tests/authorization/p152_account_deletion_attacks.test.ts); here the same decision core runs
 * in-process so individual steps can be made to fail, which the deployed function deliberately
 * cannot be.
 */

let service: TestClient
let db: pg.Client
const created: SyntheticUser[] = []

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
})

afterAll(async () => {
  for (const user of created) {
    // Some users are deleted by the test itself; deleteSyntheticUser is idempotent on a missing
    // user. A leftover pending row would block the fixture's own row-cleanup inserts? No — it only
    // deletes — but clear it first so cleanup never depends on the guard's behaviour.
    await service.from('account_deletion_requests').delete().eq('user_id', user.id)
    await deleteSyntheticUser(service, user.id)
  }
  await db.end()
}, 180_000)

interface Seeded {
  user: SyntheticUser
  client: TestClient
  ledger: SeededLedger
  token: string
}

async function seeded(label: string): Promise<Seeded> {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  const client = await signInAs(user)
  const ledger = await seedAccountLedger(service, user, client, label)
  const session = await client.auth.getSession()
  return { user, client, ledger, token: session.data.session!.access_token }
}

const bodyFor = (s: Seeded) => ({
  expectedUserId: s.user.id,
  password: s.user.password,
  confirm: true,
})

const run = (deps: ReturnType<typeof realDeps>, s: Seeded, body = bodyFor(s)) =>
  handleAccountDeletion(deps, { bearerToken: s.token, body })

async function authUserExists(id: string): Promise<boolean> {
  const { data } = await service.auth.admin.getUserById(id)
  return data.user !== null
}

async function pendingRow(id: string) {
  const { data } = await service
    .from('account_deletion_requests')
    .select('user_id, attempt_count, last_stage')
    .eq('user_id', id)
    .maybeSingle<{ user_id: string; attempt_count: number; last_stage: string }>()
  return data
}

const zeroed = (counts: Record<string, number>) =>
  Object.fromEntries(Object.keys(counts).map((k) => [k, 0]))

describe('synthetic A / B / C: deleting A removes A and nothing else', () => {
  it('leaves B and C byte-identical, the catalog untouched, and A unable to come back', async () => {
    const a = await seeded('p152-abc-a')
    const b = await seeded('p152-abc-b')
    const c = await seeded('p152-abc-c')

    // Every owned table holds at least one row for every user, so "zero after" is meaningful.
    for (const s of [a, b, c]) {
      const counts = await countOwnedRows(service, s.user.id)
      for (const { table } of USER_OWNED_TABLES) {
        expect(counts[table], `${table} seeded for ${s.ledger.displayName}`).toBeGreaterThan(0)
      }
    }

    const beforeB = await ownedDigests(db, b.user.id)
    const beforeC = await ownedDigests(db, c.user.id)
    const beforeShared = await sharedDigest(db)
    const bInvitation = await service
      .from('invitations')
      .select('email, label')
      .eq('id', b.ledger.invitationId)
      .single()
    const aInvitationBefore = await service
      .from('invitations')
      .select('email, label')
      .eq('id', a.ledger.invitationId)
      .single<{ email: string; label: string | null }>()
    expect(aInvitationBefore.data?.email).toBe(a.user.email)

    const deps = realDeps(service)
    const res = await run(deps, a)
    expect(res).toEqual({ status: 200, body: { status: 'deleted' } })

    // A: gone everywhere.
    expect(await authUserExists(a.user.id)).toBe(false)
    expect(await countOwnedRows(service, a.user.id)).toEqual(
      zeroed(await countOwnedRows(service, a.user.id)),
    )
    expect(await pendingRow(a.user.id)).toBeNull()
    const relogin = await createAnonClient().auth.signInWithPassword({
      email: a.user.email,
      password: a.user.password,
    })
    expect(relogin.error).not.toBeNull()
    expect(relogin.data.session).toBeNull()
    const refresh = await createAnonClient().auth.refreshSession({
      refresh_token: (await a.client.auth.getSession()).data.session!.refresh_token,
    })
    expect(refresh.error).not.toBeNull()

    // The personal fields on the invitation that created A are scrubbed; the audit record stays.
    const aInvitation = await service
      .from('invitations')
      .select('email, label, use_count, token_hash')
      .eq('id', a.ledger.invitationId)
      .single<{ email: string; label: string | null; use_count: number; token_hash: string }>()
    expect(aInvitation.data?.email).toMatch(/^redacted-.+@redacted\.invalid$/)
    expect(aInvitation.data?.email).not.toContain(a.user.email)
    expect(aInvitation.data?.label).toBeNull()
    expect(aInvitation.data?.use_count).toBe(1)
    // …and no claim row still names A's address.
    const claims = await service.from('invitation_claims').select('email').eq('email', a.user.email)
    expect(claims.data).toEqual([])

    // A's address no longer appears in the Auth service's audit table.
    const audit = await db.query(
      `select count(*)::int as n from auth.audit_log_entries
        where payload::text ilike $1`,
      [`%${a.user.email}%`],
    )
    expect(audit.rows[0].n).toBe(0)

    // B and C: not one byte different. Neither is pending.
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)
    expect(await ownedDigests(db, c.user.id)).toEqual(beforeC)
    expect(await pendingRow(b.user.id)).toBeNull()
    expect(await pendingRow(c.user.id)).toBeNull()
    expect(await authUserExists(b.user.id)).toBe(true)
    // B's invitation still names B.
    const bInvitationAfter = await service
      .from('invitations')
      .select('email, label')
      .eq('id', b.ledger.invitationId)
      .single()
    expect(bInvitationAfter.data).toEqual(bInvitation.data)

    // The shared catalog, market data and shared sealed products: identical.
    expect(await sharedDigest(db)).toEqual(beforeShared)

    // B can still do everything: a fresh write succeeds.
    const write = await b.client.from('retailers').insert({ user_id: b.user.id, name: 'after' })
    expect(write.error).toBeNull()
  }, 120_000)

  it("A's stale access token cannot recreate a row or read anything after deletion", async () => {
    const a = await seeded('p152-stale')
    const res = await run(realDeps(service), a)
    expect(res.status).toBe(200)

    // Same JWT, still cryptographically valid until it expires: it must be inert.
    const insert = await a.client.from('retailers').insert({ user_id: a.user.id, name: 'ghost' })
    expect(insert.error?.code).toBe('23503')
    const read = await a.client.from('profiles').select('id')
    expect(read.data).toEqual([])
    const rpc = await a.client.rpc('create_purchase', {
      p_purchased_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 100,
        },
      ],
    })
    expect(rpc.error).not.toBeNull()
    expect(await countOwnedRows(service, a.user.id)).toEqual(
      zeroed(await countOwnedRows(service, a.user.id)),
    )
  }, 60_000)
})

describe('the purge on its own', () => {
  it('is idempotent: a second run finds nothing and changes nothing', async () => {
    const a = await seeded('p152-idem')
    await service.rpc('begin_account_deletion', { p_user_id: a.user.id })
    const first = await service.rpc('purge_account_data', { p_user_id: a.user.id })
    expect(first.error).toBeNull()
    expect((first.data as Record<string, number>).sales).toBe(1)
    const second = await service.rpc('purge_account_data', { p_user_id: a.user.id })
    expect(second.error).toBeNull()
    const counts = second.data as Record<string, number>
    for (const [k, v] of Object.entries(counts)) {
      if (k !== 'invitations_redacted' && k !== 'complete') expect(v, k).toBe(0)
    }
    // The second run still redacts (the redemption row is kept for exactly this reason) — a
    // retry after a failed auth deletion can therefore always finish the invitation scrub.
    expect(counts.invitations_redacted).toBe(1)
    expect(counts.complete).toBe(true)
  }, 60_000)

  it('refuses an account that never authorised deletion and touches nothing', async () => {
    const a = await seeded('p152-norequest')
    const before = await ownedDigests(db, a.user.id)
    const res = await service.rpc('purge_account_data', { p_user_id: a.user.id })
    expect(res.error?.message).toContain('account_deletion_not_requested')
    expect(await ownedDigests(db, a.user.id)).toEqual(before)
  }, 60_000)

  it('scrub_account_audit_trail refuses a live, non-pending account', async () => {
    const a = await seeded('p152-scrub-live')
    const res = await service.rpc('scrub_account_audit_trail', { p_user_id: a.user.id })
    expect(res.error?.message).toContain('account_not_pending_deletion')
    const audit = await db.query(
      `select count(*)::int as n from auth.audit_log_entries where payload::text ilike $1`,
      [`%${a.user.email}%`],
    )
    expect(audit.rows[0].n).toBeGreaterThan(0)
  }, 60_000)

  it('never touches shared sealed products, even when the deleted user held them', async () => {
    const a = await seeded('p152-shared-sealed')
    await a.client.rpc('create_purchase', {
      p_purchased_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: 1,
          unit_price_minor: 1000,
        },
      ],
    })
    const before = await sharedDigest(db)
    expect((await run(realDeps(service), a)).status).toBe(200)
    expect(await sharedDigest(db)).toEqual(before)
    const stillThere = await service
      .from('sealed_products')
      .select('id')
      .eq('id', seedCatalog.sealedProductId)
    expect(stillThere.data).toHaveLength(1)
  }, 60_000)
})

/** The purge's own step order (child-first). The graph test proves this matches the function. */
const PURGE_ORDER = [
  'portfolio_recompute_queue',
  'lot_disposals',
  'sale_lines',
  'sales',
  'lot_cost_adjustments',
  'manual_valuations',
  'custom_collection_members',
  'holding_tags',
  'acquisition_lots',
  'openings',
  'purchase_lines',
  'purchases',
  'holdings',
  'portfolio_snapshots',
  'custom_collections',
  'tags',
  'retailers',
  'storage_locations',
  'manual_card_definitions',
  'sealed_products',
] as const

interface PurgeResult extends Record<string, number | boolean> {
  complete: boolean
}

describe('the purge runs in bounded batches that are safe to stop at any point', () => {
  it('rejects a batch size outside 1..100000', async () => {
    const a = await seeded('p152-batch-arg')
    await service.rpc('begin_account_deletion', { p_user_id: a.user.id })
    for (const p_max_rows of [0, -1, 100_001]) {
      const res = await service.rpc('purge_account_data', { p_user_id: a.user.id, p_max_rows })
      expect(res.error?.message, String(p_max_rows)).toContain('p_max_rows must be between')
    }
  }, 60_000)

  it('deletes at most p_max_rows per call, child-first, and only ever leaves a child-first prefix emptied', async () => {
    const a = await seeded('p152-batch-prefix')
    const b = await seeded('p152-batch-prefix-b')
    const beforeB = await ownedDigests(db, b.user.id)
    const original = await countOwnedRows(service, a.user.id)
    await service.rpc('begin_account_deletion', { p_user_id: a.user.id })

    let calls = 0
    for (;;) {
      const res = await service.rpc('purge_account_data', { p_user_id: a.user.id, p_max_rows: 3 })
      expect(res.error).toBeNull()
      const out = res.data as PurgeResult
      calls += 1
      const deleted = PURGE_ORDER.reduce((n, t) => n + Number(out[t] ?? 0), 0)
      expect(deleted, 'one call must respect the batch size').toBeLessThanOrEqual(3)

      // Prefix property: every table after the first non-empty one is exactly as it was seeded, so
      // no parent is ever removed while a child still needs it. `acquisition_lots` is left out of
      // the comparison because the function deletes it in two steps (opening-linked pull lots
      // first, ordinary lots after `openings`, which reference them); the database's own foreign
      // keys already forbid getting that wrong, and every call above succeeding proves it.
      const now = await countOwnedRows(service, a.user.id)
      const ordered = PURGE_ORDER.filter((t) => t !== 'acquisition_lots')
      const firstNonEmpty = ordered.findIndex((t) => now[t] !== 0)
      if (firstNonEmpty !== -1) {
        for (const t of ordered.slice(firstNonEmpty + 1)) {
          expect(now[t], `${t} touched before its children were gone`).toBe(original[t])
        }
      }
      if (out.complete) break
      expect(calls, 'the purge must converge').toBeLessThan(200)
    }
    expect(calls).toBeGreaterThan(3)

    const after = await countOwnedRows(service, a.user.id)
    for (const t of PURGE_ORDER) expect(after[t], t).toBe(0)
    expect((await pendingRow(a.user.id))?.last_stage).toBe('purged')
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)
  }, 120_000)

  it('a fault in a LATER batch rolls back only that batch; earlier progress stays and a retry finishes', async () => {
    const a = await seeded('p152-batch-fault')
    await service.rpc('begin_account_deletion', { p_user_id: a.user.id })
    const original = await countOwnedRows(service, a.user.id)
    await db.query(`
      create or replace function public.zz_p152_fault2() returns trigger language plpgsql as $$
      begin raise exception 'injected: fault while deleting purchases'; end $$;
      create trigger zz_p152_fault2 before delete on public.purchases
        for each row execute function public.zz_p152_fault2();
    `)
    try {
      let failed = false
      for (let i = 0; i < 100 && !failed; i++) {
        const res = await service.rpc('purge_account_data', { p_user_id: a.user.id, p_max_rows: 5 })
        if (res.error) {
          failed = true
          expect(res.error.message).toContain('injected')
        } else if ((res.data as PurgeResult).complete) break
      }
      expect(failed, 'the injected fault must surface').toBe(true)
      const mid = await countOwnedRows(service, a.user.id)
      // Earlier calls committed: the first tables in the order are gone for good…
      for (const t of ['lot_disposals', 'sale_lines', 'sales']) expect(mid[t], t).toBe(0)
      // …while the call that hit the fault rolled back as one unit, taking any tables it had
      // already deleted from with it, so nothing from `purchases` onwards has changed.
      for (const t of ['purchases', 'holdings', 'tags', 'manual_card_definitions']) {
        expect(mid[t], t).toBe(original[t])
      }
      expect(await authUserExists(a.user.id)).toBe(true)
    } finally {
      await db.query(`
        drop trigger if exists zz_p152_fault2 on public.purchases;
        drop function if exists public.zz_p152_fault2();
      `)
    }
    const retry = await run(realDeps(service), a)
    expect(retry.status).toBe(200)
    expect(await authUserExists(a.user.id)).toBe(false)
  }, 120_000)

  it('purges a large-ish account (1,500 holdings + lots + manual cards) in several bounded calls', async () => {
    const user = await createSyntheticUser(service, 'p152-batch-scale')
    created.push(user)
    const n = 1_500
    const insert = async (table: string, rows: Record<string, unknown>[]) => {
      const ids: string[] = []
      for (let i = 0; i < rows.length; i += 500) {
        const { data, error } = await service
          .from(table)
          .insert(rows.slice(i, i + 500))
          .select('id')
        if (error) throw new Error(`${table}: ${error.message}`)
        ids.push(...(data as { id: string }[]).map((r) => r.id))
      }
      return ids
    }
    const cards = await insert(
      'manual_card_definitions',
      Array.from({ length: n }, (_, i) => ({
        user_id: user.id,
        name: `Scale ${String(i)}`,
        set_name: 's',
        collector_number: String(i),
        language: 'en',
        finish: 'normal',
      })),
    )
    const holdings = await insert(
      'holdings',
      cards.map((c) => ({
        user_id: user.id,
        holding_kind: 'raw_card',
        manual_card_id: c,
        grading_state: 'raw',
      })),
    )
    await insert(
      'acquisition_lots',
      holdings.map((h) => ({
        user_id: user.id,
        holding_id: h,
        origin: 'gift',
        cost_basis_state: 'not_paid',
        acquired_on: '2026-01-20',
        quantity: 1,
        quantity_remaining: 1,
        residual_minor: 0,
      })),
    )
    await service.rpc('begin_account_deletion', { p_user_id: user.id })

    let calls = 0
    for (;;) {
      const res = await service.rpc('purge_account_data', { p_user_id: user.id, p_max_rows: 500 })
      expect(res.error).toBeNull()
      const out = res.data as PurgeResult
      calls += 1
      const deleted = PURGE_ORDER.reduce((sum, t) => sum + Number(out[t] ?? 0), 0)
      expect(deleted).toBeLessThanOrEqual(500)
      if (out.complete) break
      expect(calls).toBeLessThan(50)
    }
    // 4,500 rows at 500 per call cannot fit in fewer than nine calls.
    expect(calls).toBeGreaterThanOrEqual(9)
    const counts = await countOwnedRows(service, user.id)
    for (const t of PURGE_ORDER) expect(counts[t], t).toBe(0)
    expect((await service.auth.admin.deleteUser(user.id)).error).toBeNull()
  }, 180_000)
})

describe('the write guard: a pending account accepts no new rows', () => {
  it('blocks direct inserts, RPC writes and mixed-user bulk inserts, and only for the pending user', async () => {
    const a = await seeded('p152-guard-a')
    const b = await seeded('p152-guard-b')
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.user.id })).error).toBeNull()

    // Direct table insert as A's own session.
    const direct = await a.client.from('retailers').insert({ user_id: a.user.id, name: 'blocked' })
    expect(direct.error?.message).toContain('account_deletion_pending')

    // The RPC path (create_purchase is SECURITY INVOKER, create_sale/opening are DEFINER).
    const today = new Date().toISOString().slice(0, 10)
    const purchase = await a.client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 100,
        },
      ],
    })
    expect(purchase.error?.message).toContain('account_deletion_pending')

    // A private sealed product is guarded on created_by_user_id.
    const sealed = await a.client.from('sealed_products').insert({
      name: 'blocked box',
      language: 'en',
      product_type: 'booster_pack',
      created_by_user_id: a.user.id,
    })
    expect(sealed.error?.message).toContain('account_deletion_pending')

    // A bulk insert containing one pending user's row aborts atomically, B's row included.
    const before = (await countOwnedRows(service, b.user.id)).retailers
    const mixed = await service.from('retailers').insert([
      { user_id: b.user.id, name: 'b-in-mixed-batch' },
      { user_id: a.user.id, name: 'a-in-mixed-batch' },
    ])
    expect(mixed.error?.message).toContain('account_deletion_pending')
    expect((await countOwnedRows(service, b.user.id)).retailers).toBe(before)

    // B, not pending, is completely unaffected.
    const fine = await b.client.from('retailers').insert({ user_id: b.user.id, name: 'still fine' })
    expect(fine.error).toBeNull()
    const catalogSealed = await service.from('sealed_products').insert({
      name: `catalog box ${crypto.randomUUID()}`,
      language: 'en',
      product_type: 'booster_pack',
    })
    expect(catalogSealed.error).toBeNull()

    // A can still READ (it is their own data) — the guard is about creating rows, not access.
    const read = await a.client.from('retailers').select('id')
    expect(read.error).toBeNull()
  }, 90_000)

  it('a client cannot clear its own pending state to get around the guard', async () => {
    const a = await seeded('p152-guard-self')
    await service.rpc('begin_account_deletion', { p_user_id: a.user.id })
    const del = await a.client.from('account_deletion_requests').delete().eq('user_id', a.user.id)
    expect(del.error).not.toBeNull()
    expect(await pendingRow(a.user.id)).not.toBeNull()
    const read = await a.client.from('account_deletion_requests').select('user_id')
    expect(read.error).not.toBeNull()
  }, 60_000)
})

describe('interrupted and retried deletion', () => {
  it('fails BEFORE cleanup: pending, write-blocked, data intact — and a retry completes', async () => {
    const a = await seeded('p152-fail-before')
    const b = await seeded('p152-fail-before-b')
    const beforeA = await ownedDigests(db, a.user.id)
    const beforeB = await ownedDigests(db, b.user.id)

    const res = await run(
      realDeps(service, {
        purgeData: async () => {
          throw new Error('injected: crash before any cleanup')
        },
      }),
      a,
    )
    expect(res).toEqual({
      status: 500,
      body: { error: 'deletion_incomplete', retryable: true, stage: 'data' },
    })
    expect((await pendingRow(a.user.id))?.last_stage).toBe('purge_failed')
    expect(await ownedDigests(db, a.user.id)).toEqual(beforeA)
    // Not "an apparently normal, writable account".
    const write = await a.client.from('retailers').insert({ user_id: a.user.id, name: 'nope' })
    expect(write.error?.message).toContain('account_deletion_pending')
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)

    const retry = await run(realDeps(service), a)
    expect(retry.status).toBe(200)
    expect(await authUserExists(a.user.id)).toBe(false)
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)
  }, 90_000)

  it('fails DURING the database cleanup: the whole purge rolls back, nothing is half-deleted', async () => {
    const a = await seeded('p152-fail-during')
    const beforeA = await ownedDigests(db, a.user.id)

    // A real fault, in the real database: deleting this user's sale lines raises. By then the
    // purge has already deleted lot_disposals and the recompute queue in the same transaction —
    // if the transaction were not atomic those would stay deleted.
    await db.query(`
      create or replace function public.zz_p152_fault() returns trigger language plpgsql as $$
      begin raise exception 'injected: fault while deleting sale_lines'; end $$;
      create trigger zz_p152_fault before delete on public.sale_lines
        for each row execute function public.zz_p152_fault();
    `)
    try {
      const res = await run(realDeps(service), a)
      expect(res.status).toBe(500)
      expect(res.body).toMatchObject({ error: 'deletion_incomplete', stage: 'data' })
      // Atomic: every owned table is exactly as it was.
      expect(await ownedDigests(db, a.user.id)).toEqual(beforeA)
      expect(await authUserExists(a.user.id)).toBe(true)
      expect(await pendingRow(a.user.id)).not.toBeNull()
    } finally {
      await db.query(`
        drop trigger if exists zz_p152_fault on public.sale_lines;
        drop function if exists public.zz_p152_fault();
      `)
    }

    const retry = await run(realDeps(service), a)
    expect(retry.status).toBe(200)
    expect(await authUserExists(a.user.id)).toBe(false)
  }, 90_000)

  it('fails BEFORE the Auth Admin call: data is gone, login remains, account stays blocked; retry finishes', async () => {
    const a = await seeded('p152-fail-auth')
    const b = await seeded('p152-fail-auth-b')
    const beforeB = await ownedDigests(db, b.user.id)

    const res = await run(
      realDeps(service, {
        deleteAuthUser: async () => {
          throw new Error('injected: Auth Admin unreachable')
        },
      }),
      a,
    )
    expect(res).toEqual({
      status: 500,
      body: { error: 'deletion_incomplete', retryable: true, stage: 'login' },
    })
    const counts = await countOwnedRows(service, a.user.id)
    for (const { table } of USER_OWNED_TABLES) {
      // What remains is exactly the shell that goes with the auth user.
      if (!['profiles', 'invitation_redemptions'].includes(table))
        expect(counts[table], table).toBe(0)
    }
    // The profile shell holds no personal text any more.
    const profile = await service
      .from('profiles')
      .select('display_name, default_storage_location_id')
      .eq('id', a.user.id)
      .single()
    expect(profile.data).toEqual({ display_name: null, default_storage_location_id: null })
    expect((await pendingRow(a.user.id))?.last_stage).toBe('auth_delete_failed')

    // Still write-blocked, so this is not a normal usable account.
    const write = await a.client.from('retailers').insert({ user_id: a.user.id, name: 'nope' })
    expect(write.error?.message).toContain('account_deletion_pending')

    // Retry with the same bearer and a fresh password completes without re-doing destructive work.
    const retry = await run(realDeps(service), a)
    expect(retry.status).toBe(200)
    expect(await authUserExists(a.user.id)).toBe(false)
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)
  }, 90_000)

  it('fails AFTER Auth deletion but before the response: the account is gone, replay is inert', async () => {
    const a = await seeded('p152-fail-after')
    const b = await seeded('p152-fail-after-b')
    const beforeB = await ownedDigests(db, b.user.id)

    const res = await run(
      realDeps(service, {
        deleteAuthUser: async (userId) => {
          const { error } = await service.auth.admin.deleteUser(userId, false)
          if (error) throw new Error(error.message)
          throw new Error('injected: connection dropped after the login was deleted')
        },
      }),
      a,
    )
    // From the caller's side this looks like a failure…
    expect(res.status).toBe(500)
    // …but the account is fully gone, including the pending record (it cascaded away).
    expect(await authUserExists(a.user.id)).toBe(false)
    expect(await pendingRow(a.user.id)).toBeNull()
    expect(await countOwnedRows(service, a.user.id)).toEqual(
      zeroed(await countOwnedRows(service, a.user.id)),
    )

    // The client's replay of the same request is refused as unauthenticated: it cannot act on
    // anyone, and cannot resurrect anything.
    const replay = await run(realDeps(service), a)
    expect(replay).toEqual({ status: 401, body: { error: 'unauthenticated' } })

    // The audit residue the interrupted request never got to scrub is still removable afterwards,
    // because the guard on the scrub function is "user gone or pending".
    const scrub = await service.rpc('scrub_account_audit_trail', { p_user_id: a.user.id })
    expect(scrub.error).toBeNull()
    const audit = await db.query(
      `select count(*)::int as n from auth.audit_log_entries where payload::text ilike $1`,
      [`%${a.user.email}%`],
    )
    expect(audit.rows[0].n).toBe(0)
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)
  }, 90_000)

  it('an expired or revoked bearer is refused and touches nothing', async () => {
    const a = await seeded('p152-revoked')
    const before = await ownedDigests(db, a.user.id)
    await service.auth.admin.signOut(a.token, 'global')
    const res = await run(realDeps(service), a)
    expect(res.status).toBe(401)
    expect(await ownedDigests(db, a.user.id)).toEqual(before)
    expect(await pendingRow(a.user.id)).toBeNull()
  }, 60_000)

  it('an already-deleted account replayed a second time is a plain 401', async () => {
    const a = await seeded('p152-twice')
    expect((await run(realDeps(service), a)).status).toBe(200)
    expect((await run(realDeps(service), a)).status).toBe(401)
  }, 60_000)

  it('parallel requests for the same account converge; every response is a success or a retryable failure', async () => {
    const a = await seeded('p152-parallel')
    const b = await seeded('p152-parallel-b')
    const beforeB = await ownedDigests(db, b.user.id)

    const results = await Promise.all([1, 2, 3, 4].map(() => run(realDeps(service), a)))
    for (const r of results) {
      const ok = r.status === 200
      const benign =
        r.status === 401 ||
        ((r.status === 500 || r.status === 503) &&
          'retryable' in r.body &&
          r.body.retryable === true)
      expect(ok || benign, JSON.stringify(r)).toBe(true)
    }
    expect(results.some((r) => r.status === 200)).toBe(true)
    // If a racer lost with a retryable error, one more attempt converges (or finds it already gone).
    if (await authUserExists(a.user.id)) {
      expect((await run(realDeps(service), a)).status).toBe(200)
    }
    expect(await authUserExists(a.user.id)).toBe(false)
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)
  }, 120_000)
})

describe('cross-user references fail closed', () => {
  it("another user's row pointing at A's private sealed product blocks A's purge without touching B", async () => {
    const a = await seeded('p152-xref-a')
    const b = await seeded('p152-xref-b')
    // Constructed by the service role: the FK check ignores RLS, so a user who somehow learned the
    // (random, unguessable) id could do the same. The requirement is that it can neither delete
    // B's data nor half-delete A's.
    const xref = await service.from('holdings').insert({
      user_id: b.user.id,
      holding_kind: 'sealed',
      sealed_product_id: a.ledger.privateSealedProductId,
      grading_state: 'raw',
    })
    // The seeded lot already made A's own holding for this product; B's is a separate row.
    expect(xref.error).toBeNull()

    const beforeA = await ownedDigests(db, a.user.id)
    const beforeB = await ownedDigests(db, b.user.id)
    const res = await run(realDeps(service), a)
    expect(res.status).toBe(500)
    expect(await ownedDigests(db, a.user.id)).toEqual(beforeA)
    expect(await ownedDigests(db, b.user.id)).toEqual(beforeB)
    expect(await authUserExists(a.user.id)).toBe(true)

    // Once the stray reference is gone, the same request finishes.
    await service
      .from('holdings')
      .delete()
      .eq('user_id', b.user.id)
      .eq('sealed_product_id', a.ledger.privateSealedProductId)
    expect((await run(realDeps(service), a)).status).toBe(200)
  }, 120_000)
})

describe('storage cleanup', () => {
  it('is not applicable: no bucket, no object and no storage policy exists for user data', async () => {
    const buckets = await db.query('select count(*)::int as n from storage.buckets')
    const objects = await db.query('select count(*)::int as n from storage.objects')
    expect(buckets.rows[0].n).toBe(0)
    expect(objects.rows[0].n).toBe(0)
    const policies = await db.query(
      `select count(*)::int as n from pg_policies where schemaname = 'storage'`,
    )
    expect(policies.rows[0].n).toBe(0)
  })
})
