import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { asUser, rawSqlAvailable, runRawSqlAsync } from './raw-sql'

/**
 * P132-A: multi-lot purchase-edit integrity (P130-01) and update_purchase's own P130-03 locking
 * slice. See supabase/migrations/20260914120000_p132_update_purchase_multilot_integrity.sql for
 * the full rule (MULTILOT_RULE / QUANTITY_CHANGE_RULE / LOCK_RULE) and
 * ai_outputs/Claude_outputs/output_130.txt (finding P130-01, P130-03) for the original audit.
 *
 * Required invariant, proven after every successful edit in this file:
 *   Σ(live sibling lot quantity)                = purchase_line.quantity
 *   Σ(live sibling lot basis, known-basis only) = purchase_line attributable basis (both currencies)
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p132a-multilot-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface LotRow {
  id: string
  quantity: number
  quantity_remaining: number
  sealed_intent: string | null
  unit_cost_basis_minor: number | null
  unit_cost_basis_nok_minor: number | null
  residual_minor: number
  residual_nok_minor: number
  cost_basis_state: string
  purchase_line_id: string | null
  voided_at: string | null
}

interface PurchaseLineRow {
  id: string
  quantity: number
  attributable_cost_minor: number
  attributable_cost_nok_minor: number
}

async function createIsolatedProduct(): Promise<string> {
  const { data, error } = await service
    .from('sealed_products')
    .insert({
      name: `p132a-isolated-${crypto.randomUUID()}`,
      language: 'en',
      product_type: 'other',
      created_by_user_id: userA.id,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return data.id
}

async function buySealed(
  client: TestClient,
  args: { quantity: number; unitPriceMinor: number; productId?: string; shippingMinor?: number },
): Promise<{ purchaseId: string; lineId: string; lotId: string; productId: string }> {
  const productId = args.productId ?? (await createIsolatedProduct())
  const { data: purchase, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: args.shippingMinor ?? 0,
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: productId,
          quantity: args.quantity,
          unit_price_minor: args.unitPriceMinor,
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
    .select('id')
    .eq('purchase_line_id', line!.id)
    .single()
  return { purchaseId: purchase.id, lineId: line!.id, lotId: lot!.id, productId }
}

async function editPurchase(
  client: TestClient,
  args: {
    purchaseId: string
    lineId: string
    quantity: number
    unitPriceMinor: number
    shippingMinor?: number
  },
) {
  return client.rpc('update_purchase', {
    p_purchase_id: args.purchaseId,
    p_purchased_on: today,
    p_currency: 'NOK',
    p_shipping_minor: args.shippingMinor ?? 0,
    p_lines: [
      { line_id: args.lineId, quantity: args.quantity, unit_price_minor: args.unitPriceMinor },
    ],
  })
}

async function liveLots(lineId: string): Promise<LotRow[]> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, sealed_intent, unit_cost_basis_minor, unit_cost_basis_nok_minor, residual_minor, residual_nok_minor, cost_basis_state, purchase_line_id, voided_at',
    )
    .eq('purchase_line_id', lineId)
    .is('voided_at', null)
    .order('id')
  if (error) throw new Error(error.message)
  return data
}

async function lineRow(lineId: string): Promise<PurchaseLineRow> {
  const { data, error } = await service
    .from('purchase_lines')
    .select('id, quantity, attributable_cost_minor, attributable_cost_nok_minor')
    .eq('id', lineId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

/** Asserts the core invariant this whole migration exists to restore. */
async function assertInvariant(lineId: string): Promise<{ line: PurchaseLineRow; lots: LotRow[] }> {
  const line = await lineRow(lineId)
  const lots = await liveLots(lineId)
  const sumQuantity = lots.reduce((s, l) => s + l.quantity, 0)
  expect(sumQuantity).toBe(line.quantity)

  const knownLots = lots.filter((l) => l.cost_basis_state === 'known')
  if (knownLots.length === lots.length && lots.length > 0) {
    const sumBasis = knownLots.reduce(
      (s, l) => s + l.unit_cost_basis_minor! * l.quantity + l.residual_minor,
      0,
    )
    const sumBasisNok = knownLots.reduce(
      (s, l) => s + l.unit_cost_basis_nok_minor! * l.quantity + l.residual_nok_minor,
      0,
    )
    expect(sumBasis).toBe(line.attributable_cost_minor)
    expect(sumBasisNok).toBe(line.attributable_cost_nok_minor)
  }
  return { line, lots }
}

describe('P130-01 reproduction, now fixed', () => {
  it('5 sealed units, split 2 to keep_sealed, then an ordinary price edit — no phantom units, no fabricated basis', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 5,
      unitPriceMinor: 10000,
    })

    const split = await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: lotId,
      p_intent: 'keep_sealed',
      p_quantity: 2,
    })
    expect(split.error).toBeNull()
    await assertInvariant(lineId)

    const { error: editError } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 5,
      unitPriceMinor: 12000,
    })
    expect(editError).toBeNull()

    const { line, lots } = await assertInvariant(lineId)
    expect(line.quantity).toBe(5)
    expect(line.attributable_cost_nok_minor).toBe(60000)
    expect(lots).toHaveLength(2)
    // The exact regression P130 recorded: before the fix this was 8 units / 90000 øre.
    expect(lots.reduce((s, l) => s + l.quantity, 0)).toBe(5)
    expect(
      lots.reduce(
        (s, l) => s + l.unit_cost_basis_nok_minor! * l.quantity + l.residual_nok_minor,
        0,
      ),
    ).toBe(60000)
  })
})

describe('legitimate splits remain legitimate', () => {
  it('a split not followed by any edit is untouched by this migration', async () => {
    const { lineId, lotId } = await buySealed(clientA, { quantity: 4, unitPriceMinor: 5000 })
    const split = await clientA
      .rpc('set_sealed_lot_intent', { p_lot_id: lotId, p_intent: 'planned_to_open', p_quantity: 1 })
      .single<LotRow>()
    expect(split.error).toBeNull()

    const { line, lots } = await assertInvariant(lineId)
    expect(line.quantity).toBe(4)
    expect(lots).toHaveLength(2)
    const byIntent = new Map(lots.map((l) => [l.sealed_intent, l.quantity]))
    expect(byIntent.get('planned_to_open')).toBe(1)
    expect(byIntent.get('undecided')).toBe(3)
  })

  it('three-way split (three intents) survives a metadata-only edit intact', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 6,
      unitPriceMinor: 8000,
    })
    const split1 = await clientA
      .rpc('set_sealed_lot_intent', { p_lot_id: lotId, p_intent: 'keep_sealed', p_quantity: 2 })
      .single<LotRow>()
    expect(split1.error).toBeNull()
    // Split again off the ORIGINAL (undecided) remainder, producing a third live sibling.
    const split2 = await clientA
      .rpc('set_sealed_lot_intent', { p_lot_id: lotId, p_intent: 'planned_to_open', p_quantity: 1 })
      .single<LotRow>()
    expect(split2.error).toBeNull()

    const before = await assertInvariant(lineId)
    expect(before.lots).toHaveLength(3)
    const beforeByIntent = new Map(before.lots.map((l) => [l.sealed_intent, l.quantity]))
    expect(beforeByIntent.get('keep_sealed')).toBe(2)
    expect(beforeByIntent.get('planned_to_open')).toBe(1)
    expect(beforeByIntent.get('undecided')).toBe(3)

    // Change notes only (quantity/price unchanged) — every sibling's quantity AND intent must
    // survive exactly.
    const { error } = await clientA.rpc('update_purchase', {
      p_purchase_id: purchaseId,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_notes: 'corrected retailer name',
      p_lines: [{ line_id: lineId, quantity: 6, unit_price_minor: 8000 }],
    })
    expect(error).toBeNull()

    const { line, lots } = await assertInvariant(lineId)
    expect(line.quantity).toBe(6)
    expect(lots).toHaveLength(3)
    const afterByIntent = new Map(lots.map((l) => [l.sealed_intent, l.quantity]))
    expect(afterByIntent).toEqual(beforeByIntent)
    // Basis unchanged too — a metadata-only edit at the same price/shipping/discount must not
    // even move the residual around.
    for (const lot of lots) {
      const original = before.lots.find((l) => l.id === lot.id)!
      expect(lot.unit_cost_basis_nok_minor).toBe(original.unit_cost_basis_nok_minor)
      expect(lot.residual_nok_minor).toBe(original.residual_nok_minor)
    }
  })
})

describe('metadata-only edit preserves siblings', () => {
  it('editing only p_notes on a split line changes nothing about its lots', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 3,
      unitPriceMinor: 9999,
    })
    await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: lotId,
      p_intent: 'keep_sealed',
      p_quantity: 1,
    })
    const before = await assertInvariant(lineId)

    const { error } = await clientA.rpc('update_purchase', {
      p_purchase_id: purchaseId,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_notes: 'no financial change',
      p_lines: [{ line_id: lineId, quantity: 3, unit_price_minor: 9999 }],
    })
    expect(error).toBeNull()

    const after = await assertInvariant(lineId)
    expect(
      after.lots.map((l) => [l.id, l.quantity, l.unit_cost_basis_nok_minor, l.residual_nok_minor]),
    ).toEqual(
      before.lots.map((l) => [l.id, l.quantity, l.unit_cost_basis_nok_minor, l.residual_nok_minor]),
    )
  })
})

describe('NULL / unknown cost basis is never fabricated', () => {
  it('a single unknown-basis purchase-linked lot: price edit updates quantity/date only, basis stays NULL', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 2,
      unitPriceMinor: 5000,
    })
    // Force the lot into 'unknown' cost-basis state directly — no product code path produces this
    // for a purchase-linked lot today (see the migration header), so this is a deliberate
    // out-of-band fixture exercising the defensive branch, the same technique the M11 suite's own
    // direct-acquisition tests use for 'unknown'.
    const { error: forceError } = await service
      .from('acquisition_lots')
      .update({
        cost_basis_state: 'unknown',
        unit_cost_basis_minor: null,
        unit_cost_basis_nok_minor: null,
      })
      .eq('id', lotId)
    expect(forceError).toBeNull()

    const { error } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 3,
      unitPriceMinor: 6000,
    })
    expect(error).toBeNull()

    const lots = await liveLots(lineId)
    expect(lots).toHaveLength(1)
    const lot = lots[0]!
    expect(lot.quantity).toBe(3)
    expect(lot.quantity_remaining).toBe(3)
    expect(lot.unit_cost_basis_minor).toBeNull()
    expect(lot.unit_cost_basis_nok_minor).toBeNull()
  })

  it('split siblings that are all unknown-basis: edit moves only acquired_on, never fabricates a basis', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 4,
      unitPriceMinor: 5000,
    })
    const split = await clientA
      .rpc('set_sealed_lot_intent', { p_lot_id: lotId, p_intent: 'keep_sealed', p_quantity: 1 })
      .single<LotRow>()
    expect(split.error).toBeNull()

    const { error: forceError } = await service
      .from('acquisition_lots')
      .update({
        cost_basis_state: 'unknown',
        unit_cost_basis_minor: null,
        unit_cost_basis_nok_minor: null,
      })
      .eq('purchase_line_id', lineId)
      .is('voided_at', null)
    expect(forceError).toBeNull()

    const { error } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 4,
      unitPriceMinor: 5000, // quantity unchanged (4 == 3+1) — the only legal edit for 2 siblings
    })
    expect(error).toBeNull()

    const lots = await liveLots(lineId)
    expect(lots).toHaveLength(2)
    for (const lot of lots) {
      expect(lot.unit_cost_basis_minor).toBeNull()
      expect(lot.unit_cost_basis_nok_minor).toBeNull()
    }
    expect(lots.reduce((s, l) => s + l.quantity, 0)).toBe(4)
  })
})

describe('odd remainder allocates exactly', () => {
  it('a shipping charge that does not divide evenly across a 4/3 split still sums exactly (F6)', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 7,
      unitPriceMinor: 10000,
    })
    const split = await clientA
      .rpc('set_sealed_lot_intent', { p_lot_id: lotId, p_intent: 'keep_sealed', p_quantity: 3 })
      .single<LotRow>()
    expect(split.error).toBeNull()

    // attributable = 70000 (unit*qty) + 100 (shipping, whole line) = 70100, not evenly divisible
    // by the 4/3 weight split — floor(70100*4/7)=40057 rem 1, floor(70100*3/7)=30042 rem 6, so the
    // single extra minor unit goes to the larger-remainder sibling (weight 3) by the allocator's
    // own documented tie-break (FINANCIAL_MODEL.md §4.2).
    const { error } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 7,
      unitPriceMinor: 10000,
      shippingMinor: 100,
    })
    expect(error).toBeNull()

    const { line, lots } = await assertInvariant(lineId)
    expect(line.attributable_cost_nok_minor).toBe(70100)
    expect(lots).toHaveLength(2)
    const byQty = new Map(lots.map((l) => [l.quantity, l]))
    expect(byQty.get(4)!.unit_cost_basis_nok_minor! * 4 + byQty.get(4)!.residual_nok_minor).toBe(
      40057,
    )
    expect(byQty.get(3)!.unit_cost_basis_nok_minor! * 3 + byQty.get(3)!.residual_nok_minor).toBe(
      30043,
    )
    expect(40057 + 30043).toBe(70100)
  })
})

describe('multiple intents preserved across an edit', () => {
  it('keep_sealed / planned_to_open / undecided all survive a price correction with their own exact basis share', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 5,
      unitPriceMinor: 20000,
    })
    await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: lotId,
      p_intent: 'keep_sealed',
      p_quantity: 2,
    })
    await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: lotId,
      p_intent: 'planned_to_open',
      p_quantity: 1,
    })
    // Remaining 2 units stay 'undecided' on the original lot.

    const before = await assertInvariant(lineId)
    expect(before.lots).toHaveLength(3)

    const { error } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 5,
      unitPriceMinor: 21000,
    })
    expect(error).toBeNull()

    const { line, lots } = await assertInvariant(lineId)
    expect(line.attributable_cost_nok_minor).toBe(105000)
    expect(lots).toHaveLength(3)
    const byIntent = new Map(lots.map((l) => [l.sealed_intent, l.quantity]))
    expect(byIntent.get('keep_sealed')).toBe(2)
    expect(byIntent.get('planned_to_open')).toBe(1)
    expect(byIntent.get('undecided')).toBe(2)
  })
})

describe('ambiguous quantity change follows the explicit fail-closed rule', () => {
  it('refuses to change quantity on a line with 2 live siblings, naming the domain error', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 5,
      unitPriceMinor: 10000,
    })
    await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: lotId,
      p_intent: 'keep_sealed',
      p_quantity: 2,
    })
    const before = await assertInvariant(lineId)

    const { error } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 6,
      unitPriceMinor: 10000,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('multi-lot-quantity-ambiguous')

    // Nothing was written — same all-or-nothing posture as every other correction RPC in this
    // codebase (P28's "nothing is written until every entry has validated").
    const after = await assertInvariant(lineId)
    expect(after.line.quantity).toBe(before.line.quantity)
    expect(after.lots).toEqual(before.lots)
  })

  it('an ordinary, never-split line can still freely change quantity', async () => {
    const { purchaseId, lineId } = await buySealed(clientA, { quantity: 2, unitPriceMinor: 10000 })
    const { error } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 5,
      unitPriceMinor: 10000,
    })
    expect(error).toBeNull()
    const { line, lots } = await assertInvariant(lineId)
    expect(line.quantity).toBe(5)
    expect(lots).toHaveLength(1)
    expect(lots[0]!.quantity).toBe(5)
  })
})

describe('a disposed sibling blocks the whole edit (P130-03 blocker, re-checked under lock)', () => {
  it('one sibling with a live sale refuses the edit for the whole line', async () => {
    const { purchaseId, lineId, lotId } = await buySealed(clientA, {
      quantity: 5,
      unitPriceMinor: 10000,
    })
    const split = await clientA
      .rpc('set_sealed_lot_intent', { p_lot_id: lotId, p_intent: 'keep_sealed', p_quantity: 2 })
      .single<LotRow>()
    expect(split.error).toBeNull()
    const siblingLotId = split.data!.id

    const sale = await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_idempotency_key: crypto.randomUUID(),
        p_lines: [{ lot_id: siblingLotId, quantity: 1, unit_gross_minor: 15000 }],
      })
      .single<{ id: string }>()
    expect(sale.error).toBeNull()

    const { error } = await editPurchase(clientA, {
      purchaseId,
      lineId,
      quantity: 5,
      unitPriceMinor: 12000,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('already been partially disposed')
  })
})

describe.skipIf(!rawSqlAvailable())(
  'update_purchase vs create_sale: deterministic held-lock race (P130-03)',
  () => {
    it('sale locks first: update_purchase blocks, then sees the disposal and refuses', async () => {
      const { lineId, lotId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 10000 })
      const { data: line } = await service
        .from('purchase_lines')
        .select('purchase_id')
        .eq('id', lineId)
        .single()
      const realPurchaseId = line!.purchase_id as string

      const saleSql = asUser(
        userA.id,
        `select (public.create_sale(p_sold_on => current_date, p_currency => 'NOK', p_lines => '[{"lot_id":"${lotId}","quantity":1,"unit_gross_minor":2500}]'::jsonb, p_idempotency_key => gen_random_uuid())).id;\nselect pg_sleep(4);`,
      )
      const updateSql = asUser(
        userA.id,
        `select (public.update_purchase(p_purchase_id => '${realPurchaseId}', p_purchased_on => current_date, p_currency => 'NOK', p_lines => '[{"line_id":"${lineId}","quantity":3,"unit_price_minor":12000}]'::jsonb)).id;`,
      )

      const salePromise = runRawSqlAsync(saleSql)
      await new Promise((r) => setTimeout(r, 1500))
      const updatePromise = runRawSqlAsync(updateSql)
      const [saleResult, updateResult] = await Promise.all([salePromise, updatePromise])

      expect(saleResult.code).toBe(0)
      expect(updateResult.code).not.toBe(0)
      expect(updateResult.output).toContain('already been partially disposed')

      const { data: lot } = await service
        .from('acquisition_lots')
        .select('quantity, quantity_remaining')
        .eq('id', lotId)
        .single()
      // D1 held: the update never got to reset quantity_remaining back over the live sale.
      expect(lot!.quantity - lot!.quantity_remaining).toBe(1)
    }, 15_000)

    it('update_purchase locks first: create_sale blocks, then safely sees the updated basis', async () => {
      const { lineId, lotId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 10000 })
      const { data: line } = await service
        .from('purchase_lines')
        .select('purchase_id')
        .eq('id', lineId)
        .single()
      const realPurchaseId = line!.purchase_id as string

      const updateSql = asUser(
        userA.id,
        `select (public.update_purchase(p_purchase_id => '${realPurchaseId}', p_purchased_on => current_date, p_currency => 'NOK', p_lines => '[{"line_id":"${lineId}","quantity":3,"unit_price_minor":13000}]'::jsonb)).id;\nselect pg_sleep(4);`,
      )
      const saleSql = asUser(
        userA.id,
        `select (public.create_sale(p_sold_on => current_date, p_currency => 'NOK', p_lines => '[{"lot_id":"${lotId}","quantity":1,"unit_gross_minor":2500}]'::jsonb, p_idempotency_key => gen_random_uuid())).id;`,
      )

      const updatePromise = runRawSqlAsync(updateSql)
      await new Promise((r) => setTimeout(r, 1500))
      const salePromise = runRawSqlAsync(saleSql)
      const [updateResult, saleResult] = await Promise.all([updatePromise, salePromise])

      expect(updateResult.code).toBe(0)
      expect(saleResult.code).toBe(0)

      const { data: saleLine } = await service
        .from('sale_lines')
        .select('cost_basis_at_sale_nok_minor')
        .eq('lot_id', lotId)
        .single()
      // The sale, unblocked only after the edit committed, must freeze the POST-edit basis
      // (13000/unit), never the stale pre-edit 10000.
      expect(saleLine!.cost_basis_at_sale_nok_minor).toBe(13000)
    }, 15_000)
  },
)

describe('property: random valid split/edit sequences preserve the invariant', () => {
  it('quantity and basis sums stay exact across randomized splits and edits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }), // initial quantity
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 0, maxLength: 3 }), // split fractions (mod remaining)
        fc.array(
          fc.record({
            unitPriceMinor: fc.integer({ min: 1, max: 50_000 }),
            shippingMinor: fc.integer({ min: 0, max: 500 }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        async (initialQuantity, splitFractions, edits) => {
          const { purchaseId, lineId, lotId } = await buySealed(clientA, {
            quantity: initialQuantity,
            unitPriceMinor: 10000,
          })

          // Apply a bounded sequence of legitimate partial splits off the ORIGINAL lot, each
          // taking at most half of whatever remains on it (so it never runs out) — mirrors real
          // usage (successive "some of what's left" corrections) rather than exhausting the lot
          // on the first split.
          const intents = ['keep_sealed', 'planned_to_open'] as const
          for (let i = 0; i < splitFractions.length; i++) {
            const { data: current } = await service
              .from('acquisition_lots')
              .select('quantity_remaining')
              .eq('id', lotId)
              .single()
            const remaining = current!.quantity_remaining as number
            if (remaining <= 1) break
            const take = 1 + (splitFractions[i]! % Math.max(1, remaining - 1))
            const { error } = await clientA.rpc('set_sealed_lot_intent', {
              p_lot_id: lotId,
              p_intent: intents[i % intents.length],
              p_quantity: take,
            })
            expect(error).toBeNull()
          }

          await assertInvariant(lineId)

          // Every edit in this generator keeps quantity unchanged (the only always-legal case
          // regardless of sibling count) and only varies price/shipping.
          for (const edit of edits) {
            const { error } = await editPurchase(clientA, {
              purchaseId,
              lineId,
              quantity: initialQuantity,
              unitPriceMinor: edit.unitPriceMinor,
              shippingMinor: edit.shippingMinor,
            })
            expect(error).toBeNull()
            await assertInvariant(lineId)
          }
        },
      ),
      { numRuns: 20 },
    )
  }, 60_000)
})
