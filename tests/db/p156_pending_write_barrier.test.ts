import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { seedAccountLedger, type SeededLedger } from './lib/account-ledger-fixture'
import { connectDb } from './lib/account-deletion-deps'
import {
  HeldLockSession,
  connectMonitor,
  silenceUnhandledRejection,
  waitUntilLockWaiting,
} from './lib/held-lock-session'

/**
 * P156: what a PENDING-deletion identity may still do, and what an in-flight write can still do
 * around the moment the pending row commits.
 *
 * P152 blocked one thing: new rows (AFTER INSERT). This suite pins the rule the review asked for —
 * an identity whose deletion has been authorised cannot initiate ANY user-owned write, whether it
 * inserts, edits an existing row or deletes one, directly or through an RPC — and that the moment
 * "pending" becomes true is a barrier under ordinary READ COMMITTED ordering, not a race.
 *
 * Everything is synthetic. Part 1 uses the real PostgREST path with the account's still-valid
 * bearer token (what a second tab or a stolen session would hold). Part 2 uses raw held
 * transactions with pg_stat_activity as the synchronisation primitive, never a sleep.
 */

let service: TestClient
let db: pg.Client
let monitor: pg.Client
const created: SyntheticUser[] = []

// A held transaction that outlives a failed assertion keeps its locks and would make the fixture
// cleanup time out. Every session is opened through here and released after each test.
const openSessions: HeldLockSession[] = []
async function open(userId: string): Promise<HeldLockSession> {
  const session = await HeldLockSession.beginAs(userId)
  openSessions.push(session)
  return session
}

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
  monitor = await connectMonitor()
})

afterEach(async () => {
  for (const session of openSessions.splice(0)) await session.end()
})

afterAll(async () => {
  for (const user of created) {
    await service.from('account_deletion_requests').delete().eq('user_id', user.id)
    await deleteSyntheticUser(service, user.id)
  }
  await monitor.end()
  await db.end()
}, 180_000)

const today = (): string => new Date().toISOString().slice(0, 10)
const uid = (): string => crypto.randomUUID()

interface Targets {
  user: SyntheticUser
  client: TestClient
  ledger: SeededLedger
  ids: Record<string, string>
}

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error || result.data === null) {
    throw new Error(`fixture: ${what}: ${result.error?.message ?? 'no data'}`)
  }
  return result.data
}

async function one(table: string, filter: Record<string, string>, select = 'id') {
  let q = service.from(table).select(select)
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
  const rows = must(await q.limit(1), `lookup ${table}`) as unknown as Record<string, string>[]
  if (rows.length === 0) throw new Error(`fixture: lookup ${table}: no row`)
  return rows[0]!
}

async function insertOne(table: string, row: Record<string, unknown>): Promise<string> {
  const inserted = must(
    await service.from(table).insert(row).select('id').single<{ id: string }>(),
    `insert ${table}`,
  )
  return inserted.id
}

async function seedTargets(label: string): Promise<Targets> {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  const client = await signInAs(user)
  const ledger = await seedAccountLedger(service, user, client, label)
  const owner = user.id
  const ids: Record<string, string> = {}
  ids.retailer = (await one('retailers', { user_id: owner })).id!
  ids.location = (await one('storage_locations', { user_id: owner })).id!
  ids.tag = (await one('tags', { user_id: owner })).id!
  ids.collection = (await one('custom_collections', { user_id: owner })).id!
  ids.manual = (await one('manual_card_definitions', { user_id: owner })).id!
  ids.purchase = ledger.purchaseId
  ids.sale = ledger.saleId
  ids.opening = ledger.openingId
  ids.privateSealed = ledger.privateSealedProductId
  const lines = await service
    .from('purchase_lines')
    .select('id, line_type, card_variant_id')
    .eq('purchase_id', ledger.purchaseId)
  const lineRows = (lines.data ?? []) as {
    id: string
    line_type: string
    card_variant_id: string | null
  }[]
  ids.pikachuLine = lineRows.find((l) => l.card_variant_id === seedCatalog.pikachuVariantId)!.id
  ids.sealedLine = lineRows.find((l) => l.line_type === 'sealed')!.id
  const pikachuLot = await one(
    'acquisition_lots',
    { purchase_line_id: ids.pikachuLine },
    'id, holding_id',
  )
  ids.pikachuLot = pikachuLot.id!
  ids.pikachuHolding = pikachuLot.holding_id!
  const sealedLot = await one(
    'acquisition_lots',
    { purchase_line_id: ids.sealedLine },
    'id, holding_id',
  )
  ids.sealedLot = sealedLot.id!
  ids.sealedHolding = sealedLot.holding_id!
  ids.taggedHolding = (await one('holding_tags', { user_id: owner }, 'holding_id')).holding_id!
  ids.manualHolding = (await one('holdings', { manual_card_id: ids.manual })).id!
  ids.saleLine = (await one('sale_lines', { sale_id: ledger.saleId })).id!

  // Rows nothing else references, so a DELETE of them is a valid operation and not an FK error.
  ids.spareManual = await insertOne('manual_card_definitions', {
    user_id: owner,
    name: 'Spare',
    set_name: 's',
    collector_number: '9',
    language: 'en',
    finish: 'normal',
  })
  ids.spareHolding = await insertOne('holdings', {
    user_id: owner,
    holding_kind: 'raw_card',
    card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
    condition: 'NM',
    grading_state: 'raw',
  })
  ids.spareSealed = await insertOne('sealed_products', {
    name: `Spare box ${uid()}`,
    language: 'en',
    product_type: 'booster_pack',
    created_by_user_id: owner,
  })
  // A purchase nothing has consumed, so update_purchase / void_purchase are valid corrections.
  const spare = await client
    .rpc('create_purchase', {
      p_purchased_on: today(),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 1000,
        },
      ],
    })
    .single<{ id: string }>()
  ids.sparePurchase = must(spare, 'spare purchase').id
  ids.sparePurchaseLine = (await one('purchase_lines', { purchase_id: ids.sparePurchase })).id!
  // A gift lot of three, so reduce_holding_quantity can take one copy off it.
  const gift = await client.rpc('add_card_acquisition', {
    p_card_variant_id: seedCatalog.japaneseVariantId,
    p_condition: 'NM',
    p_origin: 'gift',
    p_cost_basis_state: 'not_paid',
    p_quantity: 3,
    p_acquired_on: today(),
  })
  if (gift.error) throw new Error(`fixture gift lot: ${gift.error.message}`)
  ids.giftHolding = (
    await one('holdings', { user_id: owner, card_variant_id: seedCatalog.japaneseVariantId })
  ).id!
  ids.giftLot = (await one('acquisition_lots', { holding_id: ids.giftHolding })).id!
  return { user, client, ledger, ids }
}

type Outcome = 'blocked' | 'succeeded' | `other:${string}`
type Result = PromiseLike<{ error: { message: string } | null; data?: unknown }>

const isPending = (message: string | undefined): boolean =>
  !!message && message.includes('account_deletion_pending')

/** Runs one PostgREST/RPC operation as the pending account and classifies what happened. */
async function attempt(op: () => Result, rowsExpected: boolean): Promise<Outcome> {
  const { error, data } = await op()
  if (error) return isPending(error.message) ? 'blocked' : `other:${error.message.slice(0, 90)}`
  // A PostgREST UPDATE/DELETE that matches no row is not an error. A zero-row result would be a
  // vacuous "pass" for the matrix, so it is reported as its own outcome.
  if (rowsExpected && Array.isArray(data) && data.length === 0) return 'other:matched no row'
  return 'succeeded'
}

interface Operation {
  name: string
  kind: 'insert' | 'update' | 'delete' | 'rpc'
  rows: boolean
  run: (t: Targets) => Result
}

const direct = (
  name: string,
  kind: 'insert' | 'update' | 'delete',
  run: (t: Targets) => Result,
): Operation => ({ name, kind, rows: kind !== 'insert', run })
const rpc = (name: string, run: (t: Targets) => Result): Operation => ({
  name,
  kind: 'rpc',
  rows: false,
  run,
})

// Order matters only for the reproduction run against an unfixed schema (an earlier success could
// remove a later target); against the fixed schema every operation is refused and nothing changes.
const OPERATIONS: Operation[] = [
  direct('INSERT tags', 'insert', (t) =>
    t.client.from('tags').insert({ user_id: t.user.id, name: `x ${uid()}` }),
  ),
  direct('UPDATE tags.name', 'update', (t) =>
    t.client
      .from('tags')
      .update({ name: `renamed ${uid()}` })
      .eq('id', t.ids.tag!)
      .select('id'),
  ),
  direct('UPDATE retailers.name', 'update', (t) =>
    t.client
      .from('retailers')
      .update({ name: `renamed ${uid()}` })
      .eq('id', t.ids.retailer!)
      .select('id'),
  ),
  direct('UPDATE storage_locations.name', 'update', (t) =>
    t.client
      .from('storage_locations')
      .update({ name: `renamed ${uid()}` })
      .eq('id', t.ids.location!)
      .select('id'),
  ),
  direct('UPDATE custom_collections.name', 'update', (t) =>
    t.client
      .from('custom_collections')
      .update({ name: `renamed ${uid()}` })
      .eq('id', t.ids.collection!)
      .select('id'),
  ),
  direct('UPDATE holdings.notes', 'update', (t) =>
    t.client
      .from('holdings')
      .update({ notes: `edit ${uid()}` })
      .eq('id', t.ids.pikachuHolding!)
      .select('id'),
  ),
  direct('UPDATE purchases.notes', 'update', (t) =>
    t.client
      .from('purchases')
      .update({ notes: `edit ${uid()}` })
      .eq('id', t.ids.purchase!)
      .select('id'),
  ),
  direct('UPDATE purchase_lines.description', 'update', (t) =>
    t.client
      .from('purchase_lines')
      .update({ description: `edit ${uid()}` })
      .eq('id', t.ids.pikachuLine!)
      .select('id'),
  ),
  direct('UPDATE acquisition_lots.notes', 'update', (t) =>
    t.client
      .from('acquisition_lots')
      .update({ notes: `edit ${uid()}` })
      .eq('id', t.ids.pikachuLot!)
      .select('id'),
  ),
  direct('UPDATE manual_card_definitions.notes', 'update', (t) =>
    t.client
      .from('manual_card_definitions')
      .update({ notes: `edit ${uid()}` })
      .eq('id', t.ids.manual!)
      .select('id'),
  ),
  direct('UPDATE sealed_products.name (private)', 'update', (t) =>
    t.client
      .from('sealed_products')
      .update({ name: `renamed ${uid()}` })
      .eq('id', t.ids.privateSealed!)
      .select('id'),
  ),
  direct('UPDATE profiles.display_name', 'update', (t) =>
    t.client
      .from('profiles')
      .update({ display_name: `typed after pending ${uid()}` })
      .eq('id', t.user.id)
      .select('id'),
  ),
  direct('UPDATE manual_valuations.superseded_at', 'update', (t) =>
    t.client
      .from('manual_valuations')
      .update({ superseded_at: new Date().toISOString() })
      .eq('holding_id', t.ids.sealedHolding!)
      .select('id'),
  ),
  direct('DELETE holding_tags', 'delete', (t) =>
    t.client
      .from('holding_tags')
      .delete()
      .eq('holding_id', t.ids.taggedHolding!)
      .select('holding_id'),
  ),
  direct('DELETE custom_collection_members', 'delete', (t) =>
    t.client
      .from('custom_collection_members')
      .delete()
      .eq('collection_id', t.ids.collection!)
      .select('collection_id'),
  ),
  direct('DELETE tags', 'delete', (t) =>
    t.client.from('tags').delete().eq('id', t.ids.tag!).select('id'),
  ),
  direct('DELETE custom_collections', 'delete', (t) =>
    t.client.from('custom_collections').delete().eq('id', t.ids.collection!).select('id'),
  ),
  direct('DELETE manual_card_definitions', 'delete', (t) =>
    t.client.from('manual_card_definitions').delete().eq('id', t.ids.spareManual!).select('id'),
  ),
  direct('DELETE holdings', 'delete', (t) =>
    t.client.from('holdings').delete().eq('id', t.ids.spareHolding!).select('id'),
  ),
  direct('DELETE sealed_products (private)', 'delete', (t) =>
    t.client.from('sealed_products').delete().eq('id', t.ids.spareSealed!).select('id'),
  ),
  direct('DELETE retailers', 'delete', (t) =>
    t.client.from('retailers').delete().eq('id', t.ids.retailer!).select('id'),
  ),
  direct('DELETE storage_locations', 'delete', (t) =>
    t.client.from('storage_locations').delete().eq('id', t.ids.location!).select('id'),
  ),
  // ── financial creation / correction / disposal flows (RPC) ──────────────────────────────
  rpc('RPC create_purchase', (t) =>
    t.client.rpc('create_purchase', {
      p_purchased_on: today(),
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
    }),
  ),
  rpc('RPC update_purchase', (t) =>
    t.client.rpc('update_purchase', {
      p_purchase_id: t.ids.sparePurchase!,
      p_purchased_on: today(),
      p_currency: 'NOK',
      p_shipping_minor: 700,
      p_lines: [{ line_id: t.ids.sparePurchaseLine!, quantity: 1, unit_price_minor: 1000 }],
    }),
  ),
  rpc('RPC create_sale', (t) =>
    t.client.rpc('create_sale', {
      p_sold_on: today(),
      p_currency: 'NOK',
      p_idempotency_key: uid(),
      p_lines: [{ lot_id: t.ids.pikachuLot!, quantity: 1, unit_gross_minor: 15_000 }],
    }),
  ),
  rpc('RPC update_sale', (t) =>
    t.client.rpc('update_sale', {
      p_sale_id: t.ids.sale!,
      p_sold_on: today(),
      p_currency: 'NOK',
      p_lines: [
        {
          line_id: t.ids.saleLine!,
          lot_id: t.ids.pikachuLot!,
          quantity: 1,
          unit_gross_minor: 16_000,
        },
      ],
    }),
  ),
  rpc('RPC void_sale', (t) =>
    t.client.rpc('void_sale', { p_sale_id: t.ids.sale!, p_reason: 'p156' }),
  ),
  rpc('RPC void_purchase', (t) =>
    t.client.rpc('void_purchase', { p_purchase_id: t.ids.sparePurchase!, p_reason: 'p156' }),
  ),
  rpc('RPC void_acquisition_lot', (t) =>
    t.client.rpc('void_acquisition_lot', { p_lot_id: t.ids.giftLot!, p_reason: 'p156' }),
  ),
  rpc('RPC set_sealed_lot_intent', (t) =>
    t.client.rpc('set_sealed_lot_intent', { p_lot_id: t.ids.sealedLot!, p_intent: 'keep_sealed' }),
  ),
  rpc('RPC reduce_holding_quantity (disposal)', (t) =>
    t.client.rpc('reduce_holding_quantity', {
      p_holding_id: t.ids.giftHolding!,
      p_lot_reductions: [{ lot_id: t.ids.giftLot!, remove_quantity: 1 }],
    }),
  ),
  rpc('RPC remove_holdings_from_portfolio', (t) =>
    t.client.rpc('remove_holdings_from_portfolio', { p_holding_ids: [t.ids.manualHolding!] }),
  ),
  rpc('RPC set_manual_valuation', (t) =>
    t.client.rpc('set_manual_valuation', {
      p_holding_id: t.ids.sealedHolding!,
      p_value_minor: 999,
      p_note: 'p156',
    }),
  ),
  rpc('RPC clear_manual_valuation', (t) =>
    t.client.rpc('clear_manual_valuation', { p_holding_id: t.ids.sealedHolding! }),
  ),
  rpc('RPC add_card_acquisition', (t) =>
    t.client.rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_condition: 'NM',
      p_origin: 'gift',
      p_cost_basis_state: 'not_paid',
      p_quantity: 1,
      p_acquired_on: today(),
    }),
  ),
  rpc('RPC create_opening', (t) =>
    t.client.rpc('create_opening', {
      p_source_lot_id: t.ids.sealedLot!,
      p_quantity: 1,
      p_opened_on: today(),
      p_pulls: [
        { card_variant_id: seedCatalog.grassEnergyVariantId, quantity: 1, condition: 'NM' },
      ],
    }),
  ),
  rpc('RPC void_opening', (t) =>
    t.client.rpc('void_opening', { p_opening_id: t.ids.opening!, p_reason: 'p156' }),
  ),
  rpc('RPC reset_my_portfolio_data', (t) => t.client.rpc('reset_my_portfolio_data')),
]

describe('P156 part 1 — a pending identity cannot write through any browser-reachable path', () => {
  let t: Targets
  const outcomes = new Map<string, Outcome>()

  beforeAll(async () => {
    t = await seedTargets('p156-matrix')
    const begun = await service.rpc('begin_account_deletion', { p_user_id: t.user.id })
    expect(begun.error).toBeNull()
    // The still-valid bearer is exactly what a second tab or a stolen session would hold.
    for (const op of OPERATIONS) outcomes.set(op.name, await attempt(() => op.run(t), op.rows))
  }, 240_000)

  it.each(OPERATIONS.map((o) => [o.name, o.kind] as const))(
    '%s (%s) is refused with account_deletion_pending',
    (name) => {
      expect(outcomes.get(name)).toBe('blocked')
    },
  )

  it('every operation is a real attempt: none was refused for an unrelated reason', () => {
    const vacuous = [...outcomes.entries()].filter(([, o]) => o !== 'blocked' && o !== 'succeeded')
    expect(vacuous).toEqual([])
  })

  it('the refused attempts changed nothing: the account still has its rows and its profile', async () => {
    const holdings = await service
      .from('holdings')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', t.user.id)
    expect(holdings.count).toBeGreaterThan(3)
    const profile = await service
      .from('profiles')
      .select('display_name')
      .eq('id', t.user.id)
      .single()
    expect((profile.data as { display_name: string | null }).display_name).toBe(
      'Synthetic p156-matrix',
    )
  })

  it('a pending account can still READ its own data (an export started earlier keeps working)', async () => {
    const { data, error } = await t.client.from('holdings').select('id').limit(5)
    expect(error).toBeNull()
    expect((data ?? []).length).toBeGreaterThan(0)
  })
})

// ── Part 2: the barrier ──────────────────────────────────────────────────────────────────────

async function freshUser(label: string): Promise<SyntheticUser> {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  return user
}

const insertTag = (s: HeldLockSession, userId: string, name: string) =>
  s.query('insert into public.tags (user_id, name) values ($1, $2) returning id', [userId, name])

const tagCount = async (userId: string, name: string): Promise<number> =>
  (
    await db.query<{ n: number }>(
      'select count(*)::int as n from public.tags where user_id = $1 and name = $2',
      [userId, name],
    )
  ).rows[0]!.n

const isBlockedByPending = (e: unknown): boolean =>
  e instanceof Error && e.message.includes('account_deletion_pending')

const begins = (s: HeldLockSession, userId: string) =>
  silenceUnhandledRejection(s.query('select public.begin_account_deletion($1)', [userId]))

describe('P156 part 2 — pending is a barrier under READ COMMITTED, not a race', () => {
  it('a write in flight BEFORE pending forces begin_account_deletion to wait, so the purge sees the row', async () => {
    const a = await freshUser('p156-inflight-before')
    const writer = await open(a.id)
    const name = `inflight ${uid()}`
    await insertTag(writer, a.id, name) // statement ran; the transaction is still open

    const begin = await open(a.id)
    const pending = begins(begin, a.id)
    await waitUntilLockWaiting(monitor, begin.pid) // begin is parked behind the writer
    expect(await tagCount(a.id, name)).toBe(0) // the writer has not committed

    await writer.commit()
    await pending
    await begin.commit()

    // The writer's row committed BEFORE pending did, so every purge batch can see it.
    expect(await tagCount(a.id, name)).toBe(1)
    const purge = await service.rpc('purge_account_data', { p_user_id: a.id })
    expect(purge.error).toBeNull()
    expect(await tagCount(a.id, name)).toBe(0)
  })

  it('a write that reaches the database AFTER pending is refused, even if its transaction started before', async () => {
    const a = await freshUser('p156-inflight-after')
    const writer = await open(a.id)
    // Open, and has run a read only — no guarded statement yet.
    await writer.query('select count(*) from public.tags where user_id = $1', [a.id])

    expect((await service.rpc('begin_account_deletion', { p_user_id: a.id })).error).toBeNull()

    const name = `late ${uid()}`
    let refusal: unknown
    try {
      await insertTag(writer, a.id, name)
    } catch (e) {
      refusal = e
    }
    expect(isBlockedByPending(refusal)).toBe(true)
    await writer.end()
    expect(await tagCount(a.id, name)).toBe(0)
  })

  it('a writer that arrives while pending is being committed waits, then is refused (fresh snapshot)', async () => {
    const a = await freshUser('p156-arrive-during')
    const begin = await open(a.id)
    await begin.query('select public.begin_account_deletion($1)', [a.id]) // not committed yet

    const writer = await open(a.id)
    const name = `arrives ${uid()}`
    const attemptWrite = silenceUnhandledRejection(insertTag(writer, a.id, name))
    await waitUntilLockWaiting(monitor, writer.pid)

    await begin.commit()
    let refusal: unknown
    try {
      await attemptWrite
    } catch (e) {
      refusal = e
    }
    expect(isBlockedByPending(refusal)).toBe(true)
    await writer.end()
    expect(await tagCount(a.id, name)).toBe(0)
  })

  it('an UPDATE holding a row lock when deletion starts is drained, and the next UPDATE is refused', async () => {
    const a = await freshUser('p156-update-lock')
    const tagId = await insertOne('tags', { user_id: a.id, name: 'orig' })

    const writer = await open(a.id)
    await writer.query('update public.tags set name = $1 where id = $2', ['edited', tagId])

    const begin = await open(a.id)
    const pending = begins(begin, a.id)
    await waitUntilLockWaiting(monitor, begin.pid)
    await writer.commit()
    await pending
    await begin.commit()

    const second = await open(a.id)
    let refusal: unknown
    try {
      await second.query('update public.tags set name = $1 where id = $2', ['edited again', tagId])
    } catch (e) {
      refusal = e
    }
    expect(isBlockedByPending(refusal)).toBe(true)
    await second.end()
    const row = await db.query<{ name: string }>('select name from public.tags where id = $1', [
      tagId,
    ])
    expect(row.rows[0]!.name).toBe('edited')
  })

  it('a multi-step write that resolved its inputs before pending is refused at its first write', async () => {
    const a = await freshUser('p156-multistep')
    const manualId = await insertOne('manual_card_definitions', {
      user_id: a.id,
      name: 'Manual',
      set_name: 's',
      collector_number: '1',
      language: 'en',
      finish: 'normal',
    })

    const writer = await open(a.id)
    // Step 1 of the "purchase": resolve the manual-card definition (a read).
    const resolved = await writer.query(
      'select id from public.manual_card_definitions where id = $1',
      [manualId],
    )
    expect(resolved).toHaveLength(1)
    // Deletion is authorised in another session between step 1 and step 2.
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.id })).error).toBeNull()
    // Step 2: the ledger write.
    let refusal: unknown
    try {
      await writer.query(
        "insert into public.holdings (user_id, holding_kind, manual_card_id, grading_state, condition) values ($1, 'raw_card', $2, 'raw', 'NM')",
        [a.id, manualId],
      )
    } catch (e) {
      refusal = e
    }
    expect(isBlockedByPending(refusal)).toBe(true)
    await writer.end()
    const holdings = await db.query<{ n: number }>(
      'select count(*)::int as n from public.holdings where user_id = $1',
      [a.id],
    )
    expect(holdings.rows[0]!.n).toBe(0)
  })

  it('a sale that started before pending commits first, and the purge then removes it', async () => {
    const a = await freshUser('p156-sale-drain')
    const client = await signInAs(a)
    await seedAccountLedger(service, a, client, 'p156-sale-drain')
    const lot = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', a.id)
      .gt('quantity_remaining', 0)
      .not('purchase_line_id', 'is', null)
      .limit(1)
      .single<{ id: string }>()

    const seller = await open(a.id)
    await seller.query('select public.create_sale($1::date, $2, $3::jsonb, $4::uuid)', [
      today(),
      'NOK',
      JSON.stringify([{ lot_id: lot.data!.id, quantity: 1, unit_gross_minor: 1000 }]),
      uid(),
    ])
    const begin = await open(a.id)
    const pending = begins(begin, a.id)
    await waitUntilLockWaiting(monitor, begin.pid)
    await seller.commit()
    await pending
    await begin.commit()

    const count = async () =>
      (
        await db.query<{ n: number }>(
          'select count(*)::int as n from public.sales where user_id = $1',
          [a.id],
        )
      ).rows[0]!.n
    expect(await count()).toBe(2) // the fixture's sale plus the one drained above
    for (let i = 0; i < 50; i++) {
      const purge = await service.rpc('purge_account_data', { p_user_id: a.id })
      expect(purge.error).toBeNull()
      if ((purge.data as { complete: boolean }).complete) break
    }
    expect(await count()).toBe(0)
  })

  it('other accounts are never held up by, or refused because of, a neighbour being pending', async () => {
    const a = await freshUser('p156-neighbour-a')
    const b = await freshUser('p156-neighbour-b')
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.id })).error).toBeNull()
    const writerB = await open(b.id)
    await insertTag(writerB, b.id, 'b writes fine')
    await writerB.commit()
    expect(await tagCount(b.id, 'b writes fine')).toBe(1)
  })

  it('the service role and operator sessions (no user identity) are not blocked, so purge and cleanup work', async () => {
    const a = await freshUser('p156-service-context')
    await insertOne('tags', { user_id: a.id, name: 'seeded before' })
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.id })).error).toBeNull()
    const purge = await service.rpc('purge_account_data', { p_user_id: a.id })
    expect(purge.error).toBeNull()
    expect((purge.data as { tags: number }).tags).toBe(1)
    expect((purge.data as { complete: boolean }).complete).toBe(true)
  })

  it('concurrent begin_account_deletion calls converge on one row and never deadlock', async () => {
    const a = await freshUser('p156-double-begin')
    const results = await Promise.all([
      service.rpc('begin_account_deletion', { p_user_id: a.id }),
      service.rpc('begin_account_deletion', { p_user_id: a.id }),
      service.rpc('begin_account_deletion', { p_user_id: a.id }),
    ])
    for (const r of results) expect(r.error).toBeNull()
    const rows = await db.query<{ attempt_count: number }>(
      'select attempt_count from public.account_deletion_requests where user_id = $1',
      [a.id],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.attempt_count).toBe(3)
  })
})

// ── Part 3: coverage — a table added later cannot be forgotten ───────────────────────────────

// Owned by an auth user but not writable by any signed-in account: written only by service-role
// flows, which carry no caller identity, so the caller-keyed barrier has nothing to check there.
const NOT_BARRIERED = new Set([
  'account_deletion_requests', // no browser privilege at all (RLS on, no policy, no grant)
  'invitation_claims', // written by the service-role redemption flow only
  'invitation_redemptions', // same
])

describe('P156 part 3 — the barrier covers every table a signed-in account can write', () => {
  it('every table with a foreign key to auth.users, or a browser write privilege, carries the barrier', async () => {
    const owned = await db.query<{ relname: string }>(`
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind in ('r', 'p')
         and (
           exists (
             select 1 from pg_constraint con
              where con.conrelid = c.oid and con.contype = 'f'
                and con.confrelid = 'auth.users'::regclass
           )
           or has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE')
           or has_any_column_privilege('authenticated', c.oid, 'UPDATE')
         )
       order by 1`)
    const barriered = await db.query<{ relname: string }>(`
      select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = 'account_deletion_barrier' and not t.tgisinternal order by 1`)
    const want = owned.rows.map((r) => r.relname).filter((n) => !NOT_BARRIERED.has(n))
    expect(barriered.rows.map((r) => r.relname)).toEqual(want)
    expect(want.length).toBeGreaterThanOrEqual(20)
  })

  it('the barrier is a BEFORE statement trigger on INSERT, UPDATE and DELETE (no bypass parameter)', async () => {
    const defs = await db.query<{ def: string }>(`
      select pg_get_triggerdef(t.oid) as def from pg_trigger t
       where t.tgname = 'account_deletion_barrier' and not t.tgisinternal`)
    expect(defs.rows.length).toBeGreaterThanOrEqual(20)
    for (const { def } of defs.rows) {
      expect(def).toMatch(/BEFORE INSERT OR DELETE OR UPDATE ON/)
      expect(def).toMatch(
        /FOR EACH STATEMENT EXECUTE FUNCTION (public.)?account_deletion_caller_guard\(\)/,
      )
      expect(def).not.toMatch(/WHEN/)
    }
  })

  it('the guard is SECURITY DEFINER with an empty search_path, and no browser role can execute it', async () => {
    const fn = await db.query<{
      secdef: boolean
      config: string[] | null
      anon: boolean
      auth: boolean
      pub: boolean
    }>(`
      select p.prosecdef as secdef, p.proconfig as config,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0) as pub
        from pg_proc p where p.oid = 'public.account_deletion_caller_guard()'::regprocedure`)
    const row = fn.rows[0]!
    expect(row.secdef).toBe(true)
    expect(row.config).toContain('search_path=""')
    expect(row.anon).toBe(false)
    expect(row.auth).toBe(false)
    expect(row.pub).toBe(false)
  })

  it('a caller with no identity (service role, operator) takes no advisory lock and is never refused', async () => {
    const a = await freshUser('p156-no-identity')
    const tagId = await insertOne('tags', { user_id: a.id, name: 'before pending' })
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.id })).error).toBeNull()
    const locksBefore = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory'",
    )
    // The service role edits and deletes the pending account's own rows: allowed — that is what the
    // purge and operator repair are. (Inserting INTO a pending account is refused by P152's
    // owner-keyed guard regardless of caller; a separate test in p152_account_deletion.test.ts.)
    const edited = await service.from('tags').update({ name: 'operator edit' }).eq('id', tagId)
    expect(edited.error).toBeNull()
    const removed = await service.from('tags').delete().eq('id', tagId)
    expect(removed.error).toBeNull()
    const locksAfter = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory'",
    )
    expect(locksAfter.rows[0]!.n).toBe(locksBefore.rows[0]!.n)
  })
})
