import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * P28: cross-tenant attacks against reduce_holding_quantity (SECURITY.md §3.3, TESTING.md §4-5).
 * The RPC derives ownership entirely from auth.uid() — there is no user_id argument to forge — so
 * what is tested is what a caller CAN supply: another user's lot id (alone or mixed with their
 * own), another user's holding id as the target, and no session at all.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p28-auth-a')
  userB = await createSyntheticUser(service, 'p28-auth-b')
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

async function giftLotFor(userId: string, cardVariantId: string) {
  const { data: holding } = await service
    .from('holdings')
    .insert({
      user_id: userId,
      holding_kind: 'raw_card',
      card_variant_id: cardVariantId,
      condition: 'NM',
    })
    .select('id')
    .single<{ id: string }>()
  const { data: lot } = await service
    .from('acquisition_lots')
    .insert({
      holding_id: holding!.id,
      user_id: userId,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: today,
      quantity: 2,
      quantity_remaining: 2,
    })
    .select('id')
    .single<{ id: string }>()
  return { holdingId: holding!.id, lotId: lot!.id }
}

describe('reduce_holding_quantity: cross-tenant isolation', () => {
  it("B cannot reduce A's lot by id — not even when naming it against B's own holding", async () => {
    const a = await giftLotFor(userA.id, seedCatalog.charizardVariantId)
    const b = await giftLotFor(userB.id, seedCatalog.grassEnergyVariantId)

    // Directly targeting the foreign lot.
    const direct = await clientB.rpc('reduce_holding_quantity', {
      p_holding_id: b.holdingId,
      p_lot_reductions: JSON.stringify([{ lot_id: a.lotId, remove_quantity: 1 }]),
    })
    expect(direct.error).not.toBeNull()

    // And aiming the whole call at the foreign holding.
    const aimedAtForeignHolding = await clientB.rpc('reduce_holding_quantity', {
      p_holding_id: a.holdingId,
      p_lot_reductions: JSON.stringify([{ lot_id: a.lotId, remove_quantity: 1 }]),
    })
    expect(aimedAtForeignHolding.error).not.toBeNull()

    // Nothing anywhere moved.
    for (const lotId of [a.lotId, b.lotId]) {
      const { data: lot } = await service
        .from('acquisition_lots')
        .select('quantity_remaining')
        .eq('id', lotId)
        .single<{ quantity_remaining: number }>()
      expect(lot!.quantity_remaining).toBe(2)
    }
  })

  it('a mixed selection of own + forged ids is rejected wholesale — no partial mutation', async () => {
    const a = await giftLotFor(userA.id, seedCatalog.pikachuVariantId)
    const b1 = await giftLotFor(userB.id, seedCatalog.charizardShadowlessFirstEditionVariantId)

    // Two lots on B's holding so a partial first-entry success would be observable.
    const { data: secondLot } = await service
      .from('acquisition_lots')
      .insert({
        holding_id: b1.holdingId,
        user_id: userB.id,
        origin: 'pre_tracking',
        cost_basis_state: 'unknown',
        acquired_on: today,
        quantity: 1,
        quantity_remaining: 1,
      })
      .select('id')
      .single<{ id: string }>()

    const { error } = await clientB.rpc('reduce_holding_quantity', {
      p_holding_id: b1.holdingId,
      p_lot_reductions: JSON.stringify([
        { lot_id: b1.lotId, remove_quantity: 1 },
        { lot_id: a.lotId, remove_quantity: 1 },
      ]),
    })
    expect(error).not.toBeNull()

    const { data: bLotAfter } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', b1.lotId)
      .single<{ quantity_remaining: number }>()
    expect(bLotAfter!.quantity_remaining).toBe(2)

    const { data: secondAfter } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', secondLot!.id)
      .single<{ quantity_remaining: number }>()
    expect(secondAfter!.quantity_remaining).toBe(1)

    const { data: aLotAfter } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', a.lotId)
      .single<{ quantity_remaining: number }>()
    expect(aLotAfter!.quantity_remaining).toBe(2)
  })

  it('anon cannot call reduce_holding_quantity at all', async () => {
    const a = await giftLotFor(userA.id, seedCatalog.charizardVariantId)
    const { error } = await createAnonClient().rpc('reduce_holding_quantity', {
      p_holding_id: a.holdingId,
      p_lot_reductions: JSON.stringify([{ lot_id: a.lotId, remove_quantity: 1 }]),
    })
    expect(error).not.toBeNull()
  })
})
