import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * M11: cross-tenant attacks against sealed inventory that go beyond plain `sealed_products` CRUD
 * visibility — that half (curated-visible-to-all, a custom row invisible/uneditable/undeletable to
 * a different user, no forged `created_by_user_id`) is already covered by
 * `tests/authorization/catalog.test.ts`'s "Catalog: sealed_products curated vs. user-added
 * visibility" block (M3), unchanged and unduplicated here. What's new for M11: promoting an owned
 * custom row to curated by nulling `created_by_user_id` after the fact (not just at creation),
 * referencing another user's private product from a purchase line or a direct acquisition
 * (enforced server-side, not merely hidden from Search), and ownership of the new sealed-only
 * surfaces — `set_sealed_lot_intent` and manual valuation on a sealed holding.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm11-sealed-a')
  userB = await createSyntheticUser(service, 'm11-sealed-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

async function createCustomProduct(client: TestClient, name: string) {
  const { data, error } = await client
    .from('sealed_products')
    .insert({ name, language: 'en', product_type: 'other' })
    .select('id, created_by_user_id')
    .single()
  if (error) throw new Error(error.message)
  return data
}

describe("sealed_products: the M11-specific gaps beyond M3's own CRUD coverage", () => {
  it('a user cannot promote their own custom product to curated by nulling created_by_user_id after the fact', async () => {
    const own = await createCustomProduct(clientA, `promote-attempt-${Date.now()}`)
    const { error } = await clientA
      .from('sealed_products')
      .update({ created_by_user_id: null })
      .eq('id', own.id)
    const check = await service
      .from('sealed_products')
      .select('created_by_user_id')
      .eq('id', own.id)
      .single()
    expect(check.data?.created_by_user_id).toBe(userA.id) // still owned, never nulled
    void error
  })

  it("B cannot delete A's custom product", async () => {
    const created = await createCustomProduct(clientA, `a-delete-${Date.now()}`)
    await clientB.from('sealed_products').delete().eq('id', created.id)
    const check = await service
      .from('sealed_products')
      .select('id')
      .eq('id', created.id)
      .maybeSingle()
    expect(check.data?.id).toBe(created.id)
  })

  it("B cannot reference A's private product in a purchase line (server-side, not just hidden in search)", async () => {
    const created = await createCustomProduct(clientA, `a-purchase-ref-${Date.now()}`)
    const { error } = await clientB.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_type: 'sealed', sealed_product_id: created.id, quantity: 1, unit_price_minor: 1000 },
      ],
    })
    expect(error).not.toBeNull()

    // No holding/purchase leaked into existence for B despite the rejected call.
    const { data: holdings } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', userB.id)
      .eq('sealed_product_id', created.id)
    expect(holdings).toHaveLength(0)
  })

  it("B cannot reference A's private product via direct add (add_card_acquisition)", async () => {
    const created = await createCustomProduct(clientA, `a-direct-add-ref-${Date.now()}`)
    const { error } = await clientB.rpc('add_card_acquisition', {
      p_sealed_product_id: created.id,
      p_grading_state: 'raw',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
      p_sealed_intent: 'undecided',
    })
    expect(error).not.toBeNull()
  })

  it('A can buy their own custom product, and it stays invisible to B end-to-end', async () => {
    const created = await createCustomProduct(clientA, `a-own-purchase-${Date.now()}`)
    const { data: purchase, error } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: created.id,
            quantity: 1,
            unit_price_minor: 5000,
          },
        ],
      })
      .single<{ id: string }>()
    expect(error).toBeNull()

    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', userA.id)
      .eq('sealed_product_id', created.id)
      .single()
    expect(holding?.id).toBeTruthy()

    // B can neither see the product, the purchase, nor the holding.
    const bProduct = await clientB
      .from('sealed_products')
      .select('id')
      .eq('id', created.id)
      .maybeSingle()
    const bPurchase = await clientB
      .from('purchases')
      .select('id')
      .eq('id', purchase!.id)
      .maybeSingle()
    const bHolding = await clientB.from('holdings').select('id').eq('id', holding!.id).maybeSingle()
    expect(bProduct.data).toBeNull()
    expect(bPurchase.data).toBeNull()
    expect(bHolding.data).toBeNull()
  })
})

describe('sealed acquisition lot ownership (defence in depth, mirrors acquisition_lots_check_owner)', () => {
  it("B cannot change intent on A's sealed lot", async () => {
    const { data: acquired, error } = await clientA
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
    expect(error).toBeNull()

    const { error: attackError } = await clientB.rpc('set_sealed_lot_intent', {
      p_lot_id: acquired!.lot_id,
      p_intent: 'keep_sealed',
    })
    expect(attackError).not.toBeNull()

    const check = await service
      .from('acquisition_lots')
      .select('sealed_intent')
      .eq('id', acquired!.lot_id)
      .single()
    expect(check.data?.sealed_intent).toBe('undecided') // unchanged
  })

  it("B cannot set a manual valuation on A's sealed holding", async () => {
    const { data: acquired } = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 1,
        p_acquired_on: today,
        p_sealed_intent: 'undecided',
      })
      .single<{ holding_id: string }>()

    const { error } = await clientB.rpc('set_manual_valuation', {
      p_holding_id: acquired!.holding_id,
      p_value_minor: 999900,
    })
    expect(error).not.toBeNull()

    const check = await service
      .from('manual_valuations')
      .select('id')
      .eq('holding_id', acquired!.holding_id)
      .is('superseded_at', null)
    expect(check.data).toHaveLength(0)
  })
})
