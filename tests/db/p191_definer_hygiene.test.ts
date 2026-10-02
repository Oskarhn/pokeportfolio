import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { connectDb } from './lib/account-deletion-deps'

/**
 * P191 access-map audit (P130-13): the database-side rules every browser-reachable function must
 * satisfy, read from the catalog, plus a cross-user matrix over the financial RPCs.
 *
 *  - every SECURITY DEFINER function pins `search_path` (a definer function with a mutable path can
 *    be hijacked by an object the caller can create);
 *  - no function a browser can EXECUTE takes a user id, owner or uid parameter (a caller could name
 *    another user) — the deletion/erasure functions that do are operator-only;
 *  - sale/opening/adjustment tables, which have no write grant at all, refuse direct client writes;
 *  - user A calling any financial RPC with user B's ids changes nothing of B's.
 */

let service: TestClient
let db: pg.Client
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient
const today = new Date().toISOString().slice(0, 10)

interface BFixture {
  purchaseId: string
  lineId: string
  lotId: string
  holdingId: string
  saleId: string
}
let b: BFixture

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
  userA = await createSyntheticUser(service, 'p191-hyg-a')
  userB = await createSyntheticUser(service, 'p191-hyg-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)

  const { data: purchase, error } = await clientB
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 3,
          unit_price_minor: 1000,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  const { data: line } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  const { data: lot } = await service
    .from('acquisition_lots')
    .select('id, holding_id')
    .eq('purchase_line_id', line!.id)
    .single()
  const { data: sale, error: saleError } = await clientB
    .rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_idempotency_key: crypto.randomUUID(),
      p_lines: [{ lot_id: lot!.id, quantity: 1, unit_gross_minor: 2000 }],
    })
    .single<{ id: string }>()
  if (saleError) throw new Error(saleError.message)
  b = {
    purchaseId: purchase.id,
    lineId: line!.id,
    lotId: lot!.id,
    holdingId: lot!.holding_id,
    saleId: sale.id,
  }
})

afterAll(async () => {
  await db.end()
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

describe('definer / invoker access map (catalog)', () => {
  it('every SECURITY DEFINER function in public pins an empty search_path', async () => {
    const { rows } = await db.query<{ fn: string; cfg: string[] | null }>(
      `select p.oid::regprocedure::text as fn, p.proconfig as cfg
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef`,
    )
    expect(rows.length).toBeGreaterThan(20)
    const unsafe = rows.filter((r) => !(r.cfg ?? []).includes('search_path=""')).map((r) => r.fn)
    expect(unsafe).toEqual([])
  })

  it('every SECURITY INVOKER function pins search_path too', async () => {
    const { rows } = await db.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and not p.prosecdef
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and not coalesce('search_path=""' = any (p.proconfig), false)`,
    )
    expect(rows).toEqual([])
  })

  it('no browser-executable function takes a user id / owner / uid argument', async () => {
    const { rows } = await db.query<{ fn: string; args: string }>(
      `select p.proname as fn, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
               or has_function_privilege('anon', p.oid, 'EXECUTE'))
          and exists (select 1 from unnest(p.proargnames) as n
                       where n ~* '(^|_)(user_id|user|owner|owner_id|uid)$')`,
    )
    expect(rows).toEqual([])
  })

  it('functions that DO take a user id are not executable by anon or authenticated', async () => {
    const { rows } = await db.query<{ fn: string }>(
      `select p.proname as fn
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and exists (select 1 from unnest(p.proargnames) as n
                       where n ~* '(^|_)(user_id|user|owner|owner_id|uid)$')
          and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
               or has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('public', p.oid, 'EXECUTE'))`,
    )
    expect(rows).toEqual([])
  })

  it('anon can execute exactly one function', async () => {
    const { rows } = await db.query<{ fn: string }>(
      `select p.proname as fn from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    )
    expect(rows.map((r) => r.fn)).toEqual(['invitation_status'])
  })
})

describe('the sale / opening / adjustment ledgers have no client write path at all', () => {
  const TABLES = ['sales', 'sale_lines', 'lot_disposals', 'lot_cost_adjustments', 'openings']

  for (const table of TABLES) {
    it(`${table}: insert, update and delete by the owner are refused (permission denied)`, async () => {
      const ins = await clientB.from(table).insert({ user_id: userB.id })
      expect(ins.error?.code).toBe('42501')
      const upd = await clientB.from(table).update({ user_id: userB.id }).eq('user_id', userB.id)
      expect(upd.error?.code).toBe('42501')
      const del = await clientB.from(table).delete().eq('user_id', userB.id)
      expect(del.error?.code).toBe('42501')
    })
  }

  it('a sale cannot be edited or its disposal changed directly, and nothing changed', async () => {
    const before = await service.from('sales').select('*').eq('id', b.saleId).single()
    const patch = await clientB.from('sales').update({ fees_minor: 0 }).eq('id', b.saleId)
    expect(patch.error?.code).toBe('42501')
    const disposal = await clientB
      .from('lot_disposals')
      .update({ quantity: 99 })
      .eq('lot_id', b.lotId)
    expect(disposal.error?.code).toBe('42501')
    const after = await service.from('sales').select('*').eq('id', b.saleId).single()
    expect(after.data).toEqual(before.data)
  })
})

describe('user A cannot use any financial RPC on user B’s rows', () => {
  async function snapshotB() {
    const [purchase, lines, lots, holding, sale, disposals, valuation] = await Promise.all([
      service.from('purchases').select('*').eq('id', b.purchaseId).single(),
      service.from('purchase_lines').select('*').eq('purchase_id', b.purchaseId),
      service.from('acquisition_lots').select('*').eq('id', b.lotId).single(),
      service.from('holdings').select('*').eq('id', b.holdingId).single(),
      service.from('sales').select('*').eq('id', b.saleId).single(),
      service.from('lot_disposals').select('*').eq('lot_id', b.lotId),
      service.from('manual_valuations').select('*').eq('holding_id', b.holdingId),
    ])
    return JSON.stringify({ purchase, lines, lots, holding, sale, disposals, valuation })
  }

  const calls: [string, () => PromiseLike<{ error: { message: string } | null }>][] = [
    ['void_purchase', () => clientA.rpc('void_purchase', { p_purchase_id: b.purchaseId })],
    [
      'update_purchase',
      () =>
        clientA.rpc('update_purchase', {
          p_purchase_id: b.purchaseId,
          p_purchased_on: today,
          p_currency: 'NOK',
          p_lines: [{ line_id: b.lineId, line_type: 'card', quantity: 3, unit_price_minor: 1 }],
        }),
    ],
    ['void_acquisition_lot', () => clientA.rpc('void_acquisition_lot', { p_lot_id: b.lotId })],
    [
      'set_manual_valuation',
      () => clientA.rpc('set_manual_valuation', { p_holding_id: b.holdingId, p_value_minor: 1 }),
    ],
    [
      'clear_manual_valuation',
      () => clientA.rpc('clear_manual_valuation', { p_holding_id: b.holdingId }),
    ],
    [
      'set_sealed_lot_intent',
      () => clientA.rpc('set_sealed_lot_intent', { p_lot_id: b.lotId, p_intent: 'keep_sealed' }),
    ],
    [
      'reduce_holding_quantity',
      () =>
        clientA.rpc('reduce_holding_quantity', {
          p_holding_id: b.holdingId,
          p_lot_reductions: [{ lot_id: b.lotId, remove_quantity: '1' }],
        }),
    ],
    [
      'remove_holdings_from_portfolio',
      () => clientA.rpc('remove_holdings_from_portfolio', { p_holding_ids: [b.holdingId] }),
    ],
    ['void_sale', () => clientA.rpc('void_sale', { p_sale_id: b.saleId })],
    [
      'update_sale',
      () =>
        clientA.rpc('update_sale', {
          p_sale_id: b.saleId,
          p_sold_on: today,
          p_currency: 'NOK',
          p_lines: [{ lot_id: b.lotId, quantity: 1, unit_gross_minor: 1 }],
        }),
    ],
    [
      'create_sale (B’s lot)',
      () =>
        clientA.rpc('create_sale', {
          p_sold_on: today,
          p_currency: 'NOK',
          p_idempotency_key: crypto.randomUUID(),
          p_lines: [{ lot_id: b.lotId, quantity: 1, unit_gross_minor: 1 }],
        }),
    ],
    [
      'create_opening (B’s lot)',
      () =>
        clientA.rpc('create_opening', {
          p_source_lot_id: b.lotId,
          p_quantity: 1,
          p_opened_on: today,
        }),
    ],
  ]

  for (const [name, call] of calls) {
    it(`${name}: refused, and B’s ledger is byte-identical afterwards`, async () => {
      const before = await snapshotB()
      const { error } = await call()
      // clear_manual_valuation is an idempotent "make sure there is none": on a row the caller
      // cannot see it is a no-op, not an error — what matters is that B's ledger is unchanged.
      if (name !== 'clear_manual_valuation') expect(error, name).not.toBeNull()
      expect(await snapshotB()).toBe(before)
    })
  }
})
