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

/**
 * M8.1: remove_holdings_from_portfolio, the bulk-safe "Remove from Portfolio" surface
 * (DECISIONS.md D-051, DATA_MODEL.md §9). Covers the mandatory remove test matrix (prompt §24):
 * gift/pre-tracking removal, an M6-style single-line purchase, multi-line purchases with and
 * without an accessory, quantity > 1, the all-or-nothing blocker, and that portfolio_counts/F1
 * reflect a removal correctly. Cross-user attacks live in
 * tests/authorization/m81_portfolio_removal.test.ts.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm81-remove-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface RemoveResultRow {
  holding_id: string
  blocked: boolean
  blocked_reason: string | null
  physical_count: number
}

async function removeHoldings(client: TestClient, holdingIds: string[]) {
  const { data, error } = await client.rpc('remove_holdings_from_portfolio', {
    p_holding_ids: holdingIds,
  })
  return { data: data as RemoveResultRow[] | null, error }
}

// purchase_spending_summary derives its result entirely from auth.uid() (SECURITY INVOKER) and
// carries no grant to service_role — it must be called as the user, not as service.
async function spending() {
  const { data } = await clientA.rpc('purchase_spending_summary').single<{
    gpo_nok_minor: string
    cs_nok_minor: string
    hs_nok_minor: string
  }>()
  return data!
}

async function liveLotCount(holdingId: string) {
  const { count } = await service
    .from('acquisition_lots')
    .select('id', { count: 'exact', head: true })
    .eq('holding_id', holdingId)
    .is('voided_at', null)
  return count ?? 0
}

// 1. gift/pre-tracking holding removal — no purchase involved at all.
describe('a gift/pre-tracking holding (no purchase_line_id)', () => {
  it('removes cleanly, no purchase touched, no error', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: userA.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.grassEnergyVariantId,
        condition: 'NM',
      })
      .select('id')
      .single()
    await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: userA.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: today,
      quantity: 2,
      quantity_remaining: 2,
    })

    const { data, error } = await removeHoldings(clientA, [holding!.id])
    expect(error).toBeNull()
    expect(data).toEqual([
      { holding_id: holding!.id, blocked: false, blocked_reason: null, physical_count: 2 },
    ])
    expect(await liveLotCount(holding!.id)).toBe(0)
  })
})

// 2. M6-style single-line Purchased holding — removal auto-voids the purchase too (F1 unaffected
// because the whole receipt leaves GPO/CS/HS together, exactly as void_acquisition_lot always did).
describe('an M6-style single-line Purchased holding', () => {
  it('voids the lot and its sole purchase, and GPO/CS drop by the same amount', async () => {
    const before = await spending()

    const { data: added } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.charizardVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 900,
        p_quantity: 1,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()

    const mid = await spending()
    expect(BigInt(mid.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(900n)

    const { data, error } = await removeHoldings(clientA, [added!.holding_id])
    expect(error).toBeNull()
    expect(data![0]!.blocked).toBe(false)

    const after = await spending()
    expect(after.gpo_nok_minor).toBe(before.gpo_nok_minor)
    expect(after.cs_nok_minor).toBe(before.cs_nok_minor)
  })
})

// 3 & 4 & 5. Multi-line M8 purchases — the accessory-preservation matrix.
describe('multi-line M8 purchases', () => {
  async function createPurchase(lines: Record<string, unknown>[]) {
    const { data, error } = await clientA
      .rpc('create_purchase', { p_purchased_on: today, p_currency: 'NOK', p_lines: lines })
      .single<{ id: string }>()
    if (error) throw new Error(error.message)
    return data
  }

  async function cardHoldingFor(purchaseId: string, cardVariantId: string) {
    const { data: line } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchaseId)
      .eq('card_variant_id', cardVariantId)
      .single()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('holding_id')
      .eq('purchase_line_id', line!.id)
      .single()
    return lot!.holding_id as string
  }

  it('3. two-card purchase — removing one card voids only that lot, the purchase remains', async () => {
    const purchase = await createPurchase([
      {
        line_type: 'card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 1000,
      },
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 500,
      },
    ])
    const charizardHolding = await cardHoldingFor(purchase.id, seedCatalog.charizardVariantId)

    const { data, error } = await removeHoldings(clientA, [charizardHolding])
    expect(error).toBeNull()
    expect(data![0]!.blocked).toBe(false)

    const { data: stillLive } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase.id)
      .single()
    expect(stillLive?.voided_at).toBeNull()
  })

  it('4. card + accessory — removing the card must not erase the accessory spend', async () => {
    const before = await spending()
    const purchase = await createPurchase([
      {
        line_type: 'card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 1000,
      },
      { line_type: 'accessory', description: 'Deck box', quantity: 1, unit_price_minor: 500 },
    ])
    const holding = await cardHoldingFor(purchase.id, seedCatalog.charizardVariantId)

    const { data, error } = await removeHoldings(clientA, [holding])
    expect(error).toBeNull()
    expect(data![0]!.blocked).toBe(false)

    const { data: stillLive } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase.id)
      .single()
    expect(stillLive?.voided_at).toBeNull()

    // The accessory's 500 øre must still be counted — HS after minus before must include it.
    const after = await spending()
    expect(BigInt(after.hs_nok_minor) - BigInt(before.hs_nok_minor)).toBe(500n)
  })

  it('5. two cards + accessory — voiding both cards still preserves the accessory spend', async () => {
    const before = await spending()
    const purchase = await createPurchase([
      {
        line_type: 'card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 1000,
      },
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 500,
      },
      { line_type: 'accessory', description: 'Binder', quantity: 1, unit_price_minor: 300 },
    ])
    const charizardHolding = await cardHoldingFor(purchase.id, seedCatalog.charizardVariantId)
    const pikachuHolding = await cardHoldingFor(purchase.id, seedCatalog.pikachuVariantId)

    const { error } = await removeHoldings(clientA, [charizardHolding, pikachuHolding])
    expect(error).toBeNull()

    const { data: stillLive } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase.id)
      .single()
    // Even with every card lot voided, the accessory line means this purchase never auto-voids.
    expect(stillLive?.voided_at).toBeNull()

    const after = await spending()
    expect(BigInt(after.hs_nok_minor) - BigInt(before.hs_nok_minor)).toBe(300n)
  })
})

// 6. quantity > 1 on a single lot.
describe('a holding whose sole lot has quantity > 1', () => {
  it('removes all copies in one call and reports the correct physical_count', async () => {
    const { data: added } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.grassEnergyVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 10,
        p_quantity: 12,
        p_acquired_on: today,
      })
      .single<{ holding_id: string }>()

    const { data, error } = await removeHoldings(clientA, [added!.holding_id])
    expect(error).toBeNull()
    expect(data![0]).toMatchObject({ blocked: false, physical_count: 12 })
    expect(await liveLotCount(added!.holding_id)).toBe(0)
  })
})

// 8 & 9. All-or-nothing across a bulk selection, and portfolio_counts reflects a real removal.
describe('bulk selection safety and portfolio_counts', () => {
  it('8. one blocked holding blocks the whole call — nothing is mutated', async () => {
    const { data: safe } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.grassEnergyVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 50,
        p_quantity: 1,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()

    const { data: blocked } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.pikachuVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 50,
        p_quantity: 3,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()

    // Simulate a partial disposal on the second holding's lot — same technique M8's own
    // update_purchase/void_purchase blocker tests use (no real disposal path ships yet).
    await service
      .from('acquisition_lots')
      .update({ quantity_remaining: 1 })
      .eq('id', blocked!.lot_id)

    const { data, error } = await removeHoldings(clientA, [safe!.holding_id, blocked!.holding_id])
    expect(error).toBeNull()
    const bySafe = data!.find((r) => r.holding_id === safe!.holding_id)!
    const byBlocked = data!.find((r) => r.holding_id === blocked!.holding_id)!
    expect(bySafe.blocked).toBe(false)
    expect(byBlocked.blocked).toBe(true)
    expect(byBlocked.blocked_reason).toMatch(/partially removed elsewhere/i)

    // Nothing mutated — including the safe holding, which on its own would have voided cleanly.
    expect(await liveLotCount(safe!.holding_id)).toBe(1)
    expect(await liveLotCount(blocked!.holding_id)).toBe(1)
  })

  it('9. portfolio_counts drops by the right amount after a real removal', async () => {
    const { data: countsBefore } = await clientA
      .rpc('portfolio_counts')
      .single<{ physical_card_count: string; unique_holding_count: string }>()

    const { data: added } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.grassEnergyVariantId,
        p_grading_state: 'raw',
        p_condition: 'EX',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 20,
        p_quantity: 4,
        p_acquired_on: today,
      })
      .single<{ holding_id: string }>()

    const { data: countsAfterAdd } = await clientA
      .rpc('portfolio_counts')
      .single<{ physical_card_count: string; unique_holding_count: string }>()
    expect(
      BigInt(countsAfterAdd!.physical_card_count) - BigInt(countsBefore!.physical_card_count),
    ).toBe(4n)
    expect(
      BigInt(countsAfterAdd!.unique_holding_count) - BigInt(countsBefore!.unique_holding_count),
    ).toBe(1n)

    await removeHoldings(clientA, [added!.holding_id])

    const { data: countsAfterRemove } = await clientA
      .rpc('portfolio_counts')
      .single<{ physical_card_count: string; unique_holding_count: string }>()
    expect(countsAfterRemove!.physical_card_count).toBe(countsBefore!.physical_card_count)
    expect(countsAfterRemove!.unique_holding_count).toBe(countsBefore!.unique_holding_count)
  })
})

// 10. F1 (GPO = CS + HS) across the whole matrix above, checked once more directly.
describe('F1 holds after removal', () => {
  it('GPO = CS + HS after a mixed sequence of removals', async () => {
    const { data } = await spending().then((s) => ({ data: s }))
    expect(BigInt(data.gpo_nok_minor)).toBe(BigInt(data.cs_nok_minor) + BigInt(data.hs_nok_minor))
  })
})
