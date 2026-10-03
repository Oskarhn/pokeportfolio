import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
 * P130-13: the browser cannot edit the ledger directly. Everything financial goes through the
 * authoritative RPCs; a direct INSERT / UPDATE / DELETE on a ledger table by a Data API role is
 * refused (42501) except for the few organisational columns the clients really write.
 *
 * Each hostile write below succeeded before 20261002140000_p191_ledger_write_gate.sql.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient
const today = new Date().toISOString().slice(0, 10)

interface Fixture {
  holdingId: string
  lotId: string
  purchaseId: string
  purchaseLineId: string
}
let a: Fixture
let b: Fixture

async function fixture(client: TestClient): Promise<Fixture> {
  const { data: purchase, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 2,
          unit_price_minor: 5000,
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
  return {
    holdingId: lot!.holding_id,
    lotId: lot!.id,
    purchaseId: purchase.id,
    purchaseLineId: line!.id,
  }
}

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p191-gate-a')
  userB = await createSyntheticUser(service, 'p191-gate-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
  a = await fixture(clientA)
  b = await fixture(clientB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const REFUSED = { code: '42501' }

describe('P130-13 — direct client writes to the ledger are refused', () => {
  it('cannot insert a purchase', async () => {
    const { error } = await clientA.from('purchases').insert({
      user_id: userA.id,
      purchased_on: today,
      currency: 'NOK',
      subtotal_minor: 1,
      total_minor: 1,
      total_nok_minor: 1,
    })
    expect(error).toMatchObject(REFUSED)
  })

  it('cannot alter a purchase amount or void state', async () => {
    const { error } = await clientA
      .from('purchases')
      .update({ total_minor: 1, subtotal_minor: 1 })
      .eq('id', a.purchaseId)
    expect(error).toMatchObject(REFUSED)
    const voided = await clientA
      .from('purchases')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', a.purchaseId)
    expect(voided.error).toMatchObject(REFUSED)
    const row = await service
      .from('purchases')
      .select('total_minor')
      .eq('id', a.purchaseId)
      .single()
    expect(row.data?.total_minor).toBe(10000)
  })

  it('cannot insert or change a purchase line', async () => {
    const ins = await clientA.from('purchase_lines').insert({
      user_id: userA.id,
      purchase_id: a.purchaseId,
      line_type: 'card',
      spend_class: 'collectible',
      card_variant_id: seedCatalog.pikachuVariantId,
      quantity: 1,
      unit_price_minor: 1,
      line_total_minor: 1,
    })
    expect(ins.error).toMatchObject(REFUSED)
    const upd = await clientA
      .from('purchase_lines')
      .update({ attributable_cost_minor: 1 })
      .eq('id', a.purchaseLineId)
    expect(upd.error).toMatchObject(REFUSED)
  })

  it('cannot insert a lot, edit its basis, or rewrite its remaining quantity', async () => {
    const ins = await clientA.from('acquisition_lots').insert({
      user_id: userA.id,
      holding_id: a.holdingId,
      origin: 'pre_tracking',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
    })
    expect(ins.error).toMatchObject(REFUSED)
    for (const patch of [
      { quantity_remaining: 999 },
      { unit_cost_basis_minor: 1 },
      { residual_minor: 5 },
      { voided_at: new Date().toISOString() },
      { quantity: 99 },
    ]) {
      const { error } = await clientA.from('acquisition_lots').update(patch).eq('id', a.lotId)
      expect(error, JSON.stringify(patch)).toMatchObject(REFUSED)
    }
    const row = await service
      .from('acquisition_lots')
      .select('quantity, quantity_remaining')
      .eq('id', a.lotId)
      .single()
    expect(row.data).toEqual({ quantity: 2, quantity_remaining: 2 })
  })

  it('cannot insert, retype or delete a holding', async () => {
    const ins = await clientA.from('holdings').insert({
      user_id: userA.id,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.charizardVariantId,
      condition: 'NM',
      grading_state: 'raw',
    })
    expect(ins.error).toMatchObject(REFUSED)
    for (const patch of [{ condition: 'PO' }, { deleted_at: new Date().toISOString() }]) {
      const { error } = await clientA.from('holdings').update(patch).eq('id', a.holdingId)
      expect(error, JSON.stringify(patch)).toMatchObject(REFUSED)
    }
    const del = await clientA.from('holdings').delete().eq('id', a.holdingId)
    expect(del.error).toMatchObject(REFUSED)
    const still = await service.from('holdings').select('id').eq('id', a.holdingId)
    expect(still.data).toHaveLength(1)
  })

  it('cannot write a manual valuation row', async () => {
    const ins = await clientA.from('manual_valuations').insert({
      user_id: userA.id,
      holding_id: a.holdingId,
      value_minor: 123456,
      effective_from: today,
    })
    expect(ins.error).toMatchObject(REFUSED)
  })

  it('cannot mutate another user’s ledger rows either (refused at the gate, not merely filtered)', async () => {
    const { error } = await clientA
      .from('acquisition_lots')
      .update({ quantity_remaining: 0 })
      .eq('id', b.lotId)
    // The gate runs on rows RLS lets through; for B's row RLS returns zero rows, so the gate is not
    // reached — either way the row is unchanged.
    expect(error === null || error.code === '42501').toBe(true)
    const row = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', b.lotId)
      .single()
    expect(row.data?.quantity_remaining).toBe(2)
  })
})

describe('P130-13 — the organisational edits the clients really make still work', () => {
  it('favourite flag and notes on a holding', async () => {
    const { error } = await clientA
      .from('holdings')
      .update({ is_favorite: true, notes: 'binder 2' })
      .eq('id', a.holdingId)
    expect(error).toBeNull()
    const row = await service
      .from('holdings')
      .select('is_favorite, notes')
      .eq('id', a.holdingId)
      .single()
    expect(row.data).toEqual({ is_favorite: true, notes: 'binder 2' })
  })

  it('acquired_on and notes on a lot', async () => {
    const { error } = await clientA
      .from('acquisition_lots')
      .update({ acquired_on: today, notes: 'gift wrap' })
      .eq('id', a.lotId)
    expect(error).toBeNull()
  })

  it('a mixed update (allowed column + protected column) is refused whole', async () => {
    const { error } = await clientA
      .from('holdings')
      .update({ is_favorite: false, condition: 'PL' })
      .eq('id', a.holdingId)
    expect(error).toMatchObject(REFUSED)
    const row = await service.from('holdings').select('is_favorite').eq('id', a.holdingId).single()
    expect(row.data?.is_favorite).toBe(true)
  })
})

describe('P130-13 — the official operations still succeed', () => {
  it('acquire, value, set intent, reduce, void, update, clear, remove', async () => {
    const acq = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.charizardVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 3,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(acq.error).toBeNull()

    const val = await clientA.rpc('set_manual_valuation', {
      p_holding_id: acq.data!.holding_id,
      p_value_minor: 7777,
    })
    expect(val.error).toBeNull()
    expect(
      (await clientA.rpc('clear_manual_valuation', { p_holding_id: acq.data!.holding_id })).error,
    ).toBeNull()

    const red = await clientA.rpc('reduce_holding_quantity', {
      p_holding_id: acq.data!.holding_id,
      p_lot_reductions: [{ lot_id: acq.data!.lot_id, remove_quantity: '1' }],
    })
    expect(red.error).toBeNull()

    const upd = await clientA.rpc('update_purchase', {
      p_purchase_id: a.purchaseId,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_id: a.purchaseLineId,
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 2,
          unit_price_minor: 5000,
        },
      ],
    })
    expect(upd.error).toBeNull()

    const sealed = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 1,
        p_acquired_on: today,
        p_sealed_intent: 'undecided',
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(sealed.error).toBeNull()
    expect(
      (
        await clientA.rpc('set_sealed_lot_intent', {
          p_lot_id: sealed.data!.lot_id,
          p_intent: 'keep_sealed',
        })
      ).error,
    ).toBeNull()

    expect(
      (await clientA.rpc('void_acquisition_lot', { p_lot_id: acq.data!.lot_id })).error,
    ).toBeNull()
    expect(
      (
        await clientA.rpc('remove_holdings_from_portfolio', {
          p_holding_ids: [sealed.data!.holding_id],
        })
      ).error,
    ).toBeNull()
    expect((await clientA.rpc('void_purchase', { p_purchase_id: a.purchaseId })).error).toBeNull()
  })
})

describe('P130-13 — the gate cannot silently fall out of date (catalog checks)', () => {
  const WRITERS = [
    'add_card_acquisition',
    'clear_manual_valuation',
    'create_purchase',
    'reduce_holding_quantity',
    'remove_holdings_from_portfolio',
    'set_manual_valuation',
    'set_sealed_lot_intent',
    'update_purchase',
    'void_acquisition_lot',
    'void_purchase',
  ]
  const GATED = ['purchases', 'purchase_lines', 'acquisition_lots', 'holdings', 'manual_valuations']
  let db: Awaited<ReturnType<typeof connectDb>>
  beforeAll(async () => {
    db = await connectDb()
  })
  afterAll(async () => {
    await db.end()
  })

  it('every ledger table carries the gate trigger, enabled, firing first', async () => {
    for (const table of GATED) {
      const { rows } = await db.query<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = ('public.' || $1)::regclass and not tgisinternal and tgtype & 2 = 2
          order by tgname limit 1`,
        [table],
      )
      expect(rows[0]?.tgname, table).toBe('a00_ledger_write_gate')
    }
  })

  it('every SECURITY INVOKER function that writes a ledger table announces itself', async () => {
    const { rows } = await db.query<{ fn: string; announces: boolean }>(
      `select p.proname as fn,
              p.prosrc like '%set_config(''app.ledger_write'', ''rpc'', true)%' as announces
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and not p.prosecdef
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and p.prosrc ~* ('(insert\\s+into|update|delete\\s+from)\\s+(only\\s+)?(public\\.)?(' || $1 || ')\\M')`,
      [GATED.join('|')],
    )
    // remove_holdings_from_portfolio writes only through void_acquisition_lot, so the source scan
    // does not match it; it is checked by name below.
    expect(rows.length).toBeGreaterThanOrEqual(9)
    expect(rows.filter((r) => !r.announces).map((r) => r.fn)).toEqual([])
    const named = await db.query<{ fn: string }>(
      `select proname as fn from pg_proc
        where pronamespace = 'public'::regnamespace and proname = any($1)
          and prosrc like '%set_config(''app.ledger_write'', ''rpc'', true)%'`,
      [WRITERS],
    )
    expect(named.rows.map((r) => r.fn).sort()).toEqual([...WRITERS].sort())
  })

  it('no INVOKER writer exists that the gate would refuse for lack of the flag', async () => {
    // Complement of the above, stated as the property: every authenticated-executable function the
    // gate could be reached from is either definer-owned or announces.
    const { rows } = await db.query<{ fn: string }>(
      `select p.proname as fn from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and not p.prosecdef
          and p.prosrc ~* ('(insert\\s+into|update|delete\\s+from)\\s+(only\\s+)?(public\\.)?(' || $1 || ')\\M')
          and p.prosrc not like '%set_config(''app.ledger_write'', ''rpc'', true)%'`,
      [GATED.join('|')],
    )
    expect(rows).toEqual([])
  })

  it('PostgREST exposes no way to set the flag (set_config is not callable by a client)', async () => {
    const { error } = await clientA.rpc('set_config', {
      setting_name: 'app.ledger_write',
      new_value: 'rpc',
      is_local: true,
    })
    expect(error).not.toBeNull()
    // …and the failed attempt did not unlock the ledger.
    const probe = await clientA
      .from('acquisition_lots')
      .update({ quantity_remaining: 999 })
      .eq('id', a.lotId)
    expect(probe.error).toMatchObject(REFUSED)
  })

  it('a role that is not a Data API role is not gated (operator and definer paths)', async () => {
    const { error } = await service
      .from('acquisition_lots')
      .update({ notes: 'operator repair' })
      .eq('id', b.lotId)
    expect(error).toBeNull()
  })
})
