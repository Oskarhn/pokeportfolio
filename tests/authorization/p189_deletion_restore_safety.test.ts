import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'
import { connectDb } from '../db/lib/account-deletion-deps'
import { countOwnedRows, seedAccountLedger } from '../db/lib/account-ledger-fixture'
import {
  hashAccountId,
  parseRegistry,
  parseRegistryKey,
} from '../../scripts/restore-gate/erasure-registry'

/**
 * P189 against the DEPLOYED delete-account function, a real Auth server and the real registry sink:
 * the recoverable state machine (registry before any destructive step), what each failure leaves
 * behind, the operator-only surface, and the adversarial cases (another account, an anonymous
 * caller, a stale session, writes racing the deletion). Everything is synthetic.
 */

const KEY_TEXT = process.env.ERASURE_REGISTRY_KEY
const REGISTRY = process.env.P189_REGISTRY_FILE
const ENABLED = Boolean(KEY_TEXT && REGISTRY)
const FUNCTION_URL = `${process.env.SUPABASE_URL ?? ''}/functions/v1/delete-account`
const ANON = process.env.SUPABASE_ANON_KEY ?? ''

let service: TestClient
let db: pg.Client
const created: SyntheticUser[] = []

async function actor(label: string, seed = true) {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  const client = await signInAs(user)
  if (seed) await seedAccountLedger(service, user, client, label)
  const token = (await client.auth.getSession()).data.session!.access_token
  return { user, client, token }
}

const call = (token: string | null, body: unknown) =>
  fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

const del = (a: { user: SyntheticUser; token: string }, over: Record<string, unknown> = {}) =>
  call(a.token, { expectedUserId: a.user.id, password: a.user.password, confirm: true, ...over })

const exists = async (id: string) => Boolean((await service.auth.admin.getUserById(id)).data.user)
const rowsLeft = async (id: string) =>
  Object.values(await countOwnedRows(service, id)).reduce((a, b) => a + b, 0)
const registryHas = (id: string) =>
  parseRegistry(readFileSync(REGISTRY!, 'utf8'), parseRegistryKey(KEY_TEXT)).records.some(
    (r) => r.subject === hashAccountId(id),
  )
const requestRow = async (id: string) =>
  (
    await db.query<{ registry_state: string; last_stage: string }>(
      'select registry_state, last_stage from public.account_deletion_requests where user_id=$1',
      [id],
    )
  ).rows[0]

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
})
afterAll(async () => {
  for (const u of created) {
    await service.from('account_deletion_requests').delete().eq('user_id', u.id)
    await deleteSyntheticUser(service, u.id)
  }
  await db.end()
}, 120_000)

describe.skipIf(!ENABLED)('registry before destruction', () => {
  it('a registry that cannot record leaves the account pending with ALL its data, reports an incomplete (not deleted) result, and a retry completes', async () => {
    const a = await actor('p189-reg-down')
    const before = await countOwnedRows(service, a.user.id)
    const backup = join(tmpdir(), `p189-registry-backup-${String(Date.now())}.ndjson`)
    copyFileSync(REGISTRY!, backup)
    try {
      // The sink refuses to append to a registry that no longer verifies, which is exactly "the
      // registry cannot durably record this": the function must not proceed.
      writeFileSync(REGISTRY!, `${readFileSync(REGISTRY!, 'utf8')}this is not a record\n`)
      const res = await del(a)
      const body = (await res.json()) as Record<string, unknown>
      expect(res.status).toBe(503)
      expect(body).toEqual({ error: 'deletion_incomplete', retryable: true, stage: 'registry' })

      // Nothing was destroyed and nothing is claimed.
      expect(await exists(a.user.id)).toBe(true)
      expect(await countOwnedRows(service, a.user.id)).toEqual(before)
      const row = await requestRow(a.user.id)
      expect(row).toMatchObject({ registry_state: 'not_recorded', last_stage: 'registry_failed' })
      const receipts = await db.query(
        'select 1 from public.account_erasure_receipts where subject_hash=$1',
        [hashAccountId(a.user.id)],
      )
      expect(receipts.rowCount).toBe(0)
      // ...but the account is write-blocked while the deletion is unfinished.
      const write = await a.client.from('tags').insert({ user_id: a.user.id, name: 'blocked' })
      expect(write.error?.message).toContain('account_deletion_pending')
    } finally {
      copyFileSync(backup, REGISTRY!)
    }

    const retry = await del(a)
    expect(retry.status).toBe(200)
    expect(await exists(a.user.id)).toBe(false)
    expect(await rowsLeft(a.user.id)).toBe(0)
    expect(registryHas(a.user.id)).toBe(true)
  })

  it('the database itself refuses to purge before the erasure is recorded (a future caller cannot reorder the steps)', async () => {
    const a = await actor('p189-purge-guard')
    const before = await countOwnedRows(service, a.user.id)
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.user.id })).error).toBeNull()
    const purge = await service.rpc('purge_account_data', { p_user_id: a.user.id })
    expect(purge.error?.message).toContain('account_erasure_not_recorded')
    expect(await countOwnedRows(service, a.user.id)).toEqual(before)
  })

  it('a completed deletion leaves a receipt whose hash equals the registry subject, a registry record without ids, and no millisecond noise', async () => {
    const a = await actor('p189-receipt')
    expect((await del(a)).status).toBe(200)
    const subject = hashAccountId(a.user.id)
    const receipt = await db.query<{ deletion_id: string; registry_seq: string }>(
      'select deletion_id, registry_seq from public.account_erasure_receipts where subject_hash=$1',
      [subject],
    )
    expect(receipt.rowCount).toBe(1) // SQL erasure_subject_hash() and TS hashAccountId() agree
    const registry = parseRegistry(readFileSync(REGISTRY!, 'utf8'), parseRegistryKey(KEY_TEXT))
    const record = registry.records.find((r) => r.subject === subject)!
    expect(record.deletion_id).toBe(receipt.rows[0]!.deletion_id)
    expect(String(record.seq)).toBe(receipt.rows[0]!.registry_seq)
    expect(record.deleted_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(readFileSync(REGISTRY!, 'utf8')).not.toContain(a.user.id)
    expect(readFileSync(REGISTRY!, 'utf8')).not.toContain(a.user.email)
    // The deletion request row cascaded away with the user: no tombstone with an id remains.
    expect(await requestRow(a.user.id)).toBeUndefined()
  })

  it('replaying the same deletion for a finished account is inert and adds no registry record', async () => {
    const a = await actor('p189-replay')
    expect((await del(a)).status).toBe(200)
    const count = () =>
      parseRegistry(readFileSync(REGISTRY!, 'utf8'), parseRegistryKey(KEY_TEXT)).head.records
    const n = count()
    expect((await del(a)).status).toBe(401)
    expect(count()).toBe(n)
  })
})

describe.skipIf(!ENABLED)('the operator-only surface', () => {
  it('abort_account_deletion releases an unrecorded deletion, refuses a recorded one, and is not callable by any API role', async () => {
    const a = await actor('p189-abort')
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.user.id })).error).toBeNull()
    expect(
      (await service.rpc('abort_account_deletion', { p_user_id: a.user.id })).error,
    ).not.toBeNull() // service_role: no
    expect(
      (await a.client.rpc('abort_account_deletion', { p_user_id: a.user.id })).error,
    ).not.toBeNull()
    expect(
      (await createAnonClient().rpc('abort_account_deletion', { p_user_id: a.user.id })).error,
    ).not.toBeNull()

    const released = await db.query<{ ok: boolean }>(
      'select public.abort_account_deletion($1) as ok',
      [a.user.id],
    )
    expect(released.rows[0]!.ok).toBe(true)
    const write = await a.client.from('tags').insert({ user_id: a.user.id, name: 'writable again' })
    expect(write.error).toBeNull() // the account works again

    // Recorded erasure: abort refuses (the registry already holds it).
    const b = await actor('p189-abort-recorded', false)
    expect((await service.rpc('begin_account_deletion', { p_user_id: b.user.id })).error).toBeNull()
    const prep = await service.rpc('prepare_account_erasure', { p_user_id: b.user.id })
    const info = prep.data as { deletion_id: string }
    expect(
      (
        await service.rpc('record_account_erasure', {
          p_user_id: b.user.id,
          p_deletion_id: info.deletion_id,
          p_registry_seq: 999_001,
        })
      ).error,
    ).toBeNull()
    await expect(db.query('select public.abort_account_deletion($1)', [b.user.id])).rejects.toThrow(
      /account_erasure_already_recorded/,
    )
    // clean the synthetic receipt this test wrote by hand (it is not in the registry)
    await db.query('delete from public.account_erasure_receipts where deletion_id=$1', [
      info.deletion_id,
    ])
  })

  it.each([
    ['restore_gate_check', { p_registry: [], p_head_seq: 0 }],
    ['restore_gate_apply', { p_registry: [], p_dry_run: true }],
    ['restore_gate_scan', { p_subjects: [] }],
    ['restore_gate_postcheck', { p_registry: [], p_head_seq: 0, p_head_mac: 'x', p_records: 0 }],
  ])('%s is not callable by anon, authenticated or service_role', async (fn, args) => {
    const a = await actor(`p189-gate-${fn.slice(13, 18)}`, false)
    for (const client of [createAnonClient(), a.client, service]) {
      const r = await client.rpc(fn as never, args as never)
      expect(r.error, fn).not.toBeNull()
    }
  })

  it('the erasure tables are not readable or writable through the API roles', async () => {
    const a = await actor('p189-tables', false)
    for (const t of ['account_erasure_receipts', 'restore_gate_runs'] as const) {
      expect((await createAnonClient().from(t).select('*')).data ?? []).toEqual([])
      expect((await a.client.from(t).select('*')).error).not.toBeNull()
      expect((await a.client.from(t).insert({} as never)).error).not.toBeNull()
    }
    expect(
      (await a.client.rpc('prepare_account_erasure', { p_user_id: a.user.id })).error,
    ).not.toBeNull()
    expect(
      (
        await a.client.rpc('record_account_erasure', {
          p_user_id: a.user.id,
          p_deletion_id: a.user.id,
          p_registry_seq: 1,
        })
      ).error,
    ).not.toBeNull()
  })
})

describe.skipIf(!ENABLED)('adversarial: who can delete whom, and what survives', () => {
  it("A cannot delete B: A's token naming B is refused and B is untouched; B's token naming A likewise", async () => {
    const a = await actor('p189-adv-a')
    const b = await actor('p189-adv-b')
    const bBefore = await countOwnedRows(service, b.user.id)
    const aBefore = await countOwnedRows(service, a.user.id)
    expect(
      (await call(a.token, { expectedUserId: b.user.id, password: b.user.password, confirm: true }))
        .status,
    ).toBe(409)
    expect(
      (await call(a.token, { expectedUserId: b.user.id, password: a.user.password, confirm: true }))
        .status,
    ).toBe(409)
    expect(
      (await call(b.token, { expectedUserId: a.user.id, password: a.user.password, confirm: true }))
        .status,
    ).toBe(409)
    expect(await exists(a.user.id)).toBe(true)
    expect(await exists(b.user.id)).toBe(true)
    expect(await countOwnedRows(service, b.user.id)).toEqual(bBefore)
    expect(await countOwnedRows(service, a.user.id)).toEqual(aBefore)
    expect(registryHas(a.user.id)).toBe(false)
    expect(registryHas(b.user.id)).toBe(false)
  })

  it('an anonymous caller, the public key as a bearer and a malformed body are refused before anything is recorded', async () => {
    const a = await actor('p189-adv-anon')
    expect(
      (await call(null, { expectedUserId: a.user.id, password: a.user.password, confirm: true }))
        .status,
    ).toBe(401)
    expect(
      (await call(ANON, { expectedUserId: a.user.id, password: a.user.password, confirm: true }))
        .status,
    ).toBe(401)
    expect((await call(a.token, { expectedUserId: a.user.id })).status).toBe(400)
    expect(await exists(a.user.id)).toBe(true)
    expect(registryHas(a.user.id)).toBe(false)
  })

  it('a stale session cannot write, read or sign in after the account is gone', async () => {
    const a = await actor('p189-adv-stale')
    expect((await del(a)).status).toBe(200)
    const insert = await a.client.from('tags').insert({ user_id: a.user.id, name: 'ghost' })
    expect(insert.error).not.toBeNull()
    const rpc = await a.client.rpc('create_purchase', {
      p_purchased_on: '2026-10-02',
      p_currency: 'NOK',
      p_shipping_minor: 0,
      p_lines: [],
    } as never)
    expect(rpc.error).not.toBeNull()
    expect(await rowsLeft(a.user.id)).toBe(0)
    const refreshed = await createAnonClient().auth.setSession({
      access_token: a.token,
      refresh_token: (await a.client.auth.getSession()).data.session?.refresh_token ?? 'x',
    })
    expect(refreshed.data.user).toBeNull() // Auth no longer knows the account
    const login = await createAnonClient().auth.signInWithPassword({
      email: a.user.email,
      password: a.user.password,
    })
    expect(login.error).not.toBeNull()
  })

  it('writes racing the deletion either land before it and are erased, or fail closed; nothing survives', async () => {
    const a = await actor('p189-adv-race')
    let stop = false
    const outcomes: boolean[] = []
    const writer = (async () => {
      let n = 0
      while (!stop && n < 400) {
        n += 1
        const r = await a.client
          .from('tags')
          .insert({ user_id: a.user.id, name: `race ${String(n)}` })
        outcomes.push(r.error === null)
        if (r.error !== null) {
          // once refused, it must stay refused: the barrier is permanent from the pending commit on
          stop = true
        }
      }
    })()
    const res = await del(a)
    stop = true
    await writer
    expect(res.status).toBe(200)
    expect(await exists(a.user.id)).toBe(false)
    expect(await rowsLeft(a.user.id)).toBe(0)
    // After the first failure there is no later success.
    const firstFail = outcomes.indexOf(false)
    if (firstFail >= 0) expect(outcomes.slice(firstFail).every((o) => !o)).toBe(true)
  })

  it('a database failure during the purge surfaces only the closed vocabulary: no SQL, table, function or fault text', async () => {
    const a = await actor('p189-adv-sqlerr')
    await db.query(`
      create or replace function public.zz_p189_fault() returns trigger language plpgsql as $$
      begin raise exception 'p189 injected: relation "purchases" violates secret constraint'; end $$;
      create trigger zz_p189_fault before delete on public.purchases for each statement execute function public.zz_p189_fault();`)
    try {
      const res = await del(a)
      const text = await res.text()
      expect(res.status).toBe(500)
      expect(JSON.parse(text)).toEqual({
        error: 'deletion_incomplete',
        retryable: true,
        stage: 'data',
      })
      expect(text).not.toMatch(
        /injected|purchases|constraint|zz_p189|purge_account_data|PGRST|SQL/i,
      )
      expect(await exists(a.user.id)).toBe(true) // login still there: "deleted" was never claimed
    } finally {
      await db.query(
        'drop trigger if exists zz_p189_fault on public.purchases; drop function if exists public.zz_p189_fault();',
      )
    }
    expect((await del(a)).status).toBe(200) // and the retry completes
    expect(registryHas(a.user.id)).toBe(true)
  })
})
