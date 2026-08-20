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

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'holding-a')
  userB = await createSyntheticUser(service, 'holding-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

async function createHolding(client: TestClient, userId: string) {
  const { data, error } = await client
    .from('holdings')
    .insert({
      user_id: userId,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.pikachuVariantId,
      condition: 'NM',
    })
    .select()
    .single()
  if (error) throw error
  return data as { id: string }
}

/** A real, owned purchase_line — acquisition_lots with cost_basis_state='known' needs one. */
async function createOwnedPurchaseLine(client: TestClient, userId: string) {
  const today = new Date().toISOString().slice(0, 10)
  const { data: purchase, error: purchaseError } = await client
    .from('purchases')
    .insert({
      user_id: userId,
      purchased_on: today,
      currency: 'NOK',
      subtotal_minor: 5_000,
      total_minor: 5_000,
      fx_rate_date: today,
      total_nok_minor: 5_000,
    })
    .select()
    .single()
  if (purchaseError) throw purchaseError

  const { data: line, error: lineError } = await client
    .from('purchase_lines')
    .insert({
      purchase_id: purchase!.id,
      user_id: userId,
      line_type: 'card',
      spend_class: 'collectible',
      card_variant_id: seedCatalog.pikachuVariantId,
      quantity: 1,
      unit_price_minor: 5_000,
      line_total_minor: 5_000,
    })
    .select()
    .single()
  if (lineError) throw lineError
  return line as { id: string }
}

describe('RLS isolation: holdings', () => {
  it('owner can create and read their own holding', async () => {
    const holding = await createHolding(clientA, userA.id)
    const { data } = await clientA.from('holdings').select().eq('id', holding.id).single()
    expect(data?.user_id).toBe(userA.id)
  })

  it('a stranger cannot read, update or delete another user holding', async () => {
    const holding = await createHolding(clientA, userA.id)

    const { data: read } = await clientB.from('holdings').select().eq('id', holding.id)
    expect(read).toEqual([])

    const { data: update } = await clientB
      .from('holdings')
      .update({ is_favorite: true })
      .eq('id', holding.id)
      .select()
    expect(update).toEqual([])

    const { data: del } = await clientB.from('holdings').delete().eq('id', holding.id).select()
    expect(del).toEqual([])
  })

  it('cannot insert a holding claiming another user as owner', async () => {
    const { error } = await clientA.from('holdings').insert({
      user_id: userB.id,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.pikachuVariantId,
      condition: 'NM',
    })
    expect(error).not.toBeNull()
  })
})

describe('RLS isolation: acquisition_lots (S1 child-parent ownership)', () => {
  it('owner can create a lot on their own holding, linked to their own purchase line', async () => {
    const holding = await createHolding(clientA, userA.id)
    const line = await createOwnedPurchaseLine(clientA, userA.id)

    const { data, error } = await clientA
      .from('acquisition_lots')
      .insert({
        holding_id: holding.id,
        user_id: userA.id,
        origin: 'purchase',
        cost_basis_state: 'known',
        purchase_line_id: line.id,
        acquired_on: new Date().toISOString().slice(0, 10),
        quantity: 1,
        quantity_remaining: 1,
        unit_cost_basis_minor: 5_000,
        cost_basis_currency: 'NOK',
        unit_cost_basis_nok_minor: 5_000,
      })
      .select()
      .single()
    expect(error).toBeNull()
    expect(data?.user_id).toBe(userA.id)
  })

  it('rejects a lot with user_id=B pointing at A holding (critical cross-tenant attack)', async () => {
    const holdingA = await createHolding(clientA, userA.id)

    const { error } = await clientB.from('acquisition_lots').insert({
      holding_id: holdingA.id,
      user_id: userB.id,
      origin: 'other',
      cost_basis_state: 'unknown',
      acquired_on: new Date().toISOString().slice(0, 10),
      quantity: 1,
      quantity_remaining: 1,
    })
    expect(error).not.toBeNull()
  })

  it('rejects a lot on B own holding that cites A purchase_line (defence in depth)', async () => {
    const holdingB = await createHolding(clientB, userB.id)
    const lineA = await createOwnedPurchaseLine(clientA, userA.id)

    const { error } = await clientB.from('acquisition_lots').insert({
      holding_id: holdingB.id,
      user_id: userB.id,
      origin: 'purchase',
      cost_basis_state: 'known',
      purchase_line_id: lineA.id,
      acquired_on: new Date().toISOString().slice(0, 10),
      quantity: 1,
      quantity_remaining: 1,
      unit_cost_basis_minor: 5_000,
      cost_basis_currency: 'NOK',
      unit_cost_basis_nok_minor: 5_000,
    })
    expect(error).not.toBeNull()
  })

  it('a stranger cannot read another user lot', async () => {
    const holding = await createHolding(clientA, userA.id)
    const line = await createOwnedPurchaseLine(clientA, userA.id)
    const { data: lot } = await clientA
      .from('acquisition_lots')
      .insert({
        holding_id: holding.id,
        user_id: userA.id,
        origin: 'purchase',
        cost_basis_state: 'known',
        purchase_line_id: line.id,
        acquired_on: new Date().toISOString().slice(0, 10),
        quantity: 2,
        quantity_remaining: 2,
        unit_cost_basis_minor: 2_500,
        cost_basis_currency: 'NOK',
        unit_cost_basis_nok_minor: 2_500,
      })
      .select()
      .single()

    const { data } = await clientB.from('acquisition_lots').select().eq('id', lot!.id)
    expect(data).toEqual([])
  })
})
