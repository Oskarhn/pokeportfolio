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

// P191 (P130-13): fixtures are written with the service role. A Data API role can no longer insert
// into the ledger tables directly (tests/db/p191_ledger_write_gate.test.ts proves the refusal), so
// what this file asserts - that RLS and the S1 owner triggers isolate users - is exercised on rows
// created the way an operator or the RPCs create them; every attack is still a client attempt.

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

// holdings_identity is a real unique constraint (user_id, holding_kind, variant, condition, ...) —
// every call site below passes a distinct `condition` so tests sharing userA don't collide on it.
async function createHolding(_client: TestClient, userId: string, condition: string) {
  const { data, error } = await service
    .from('holdings')
    .insert({
      user_id: userId,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.pikachuVariantId,
      condition,
    })
    .select()
    .single()
  if (error) throw error
  return data as { id: string }
}

/** A real, owned purchase_line — acquisition_lots with cost_basis_state='known' needs one. */
async function createOwnedPurchaseLine(_client: TestClient, userId: string) {
  const today = new Date().toISOString().slice(0, 10)
  const { data: purchase, error: purchaseError } = await service
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

  const { data: line, error: lineError } = await service
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
      // purchase_lines_attributable_cost_matches_allocation (M8): with no purchase-level
      // shipping/customs/discount, attributable cost is exactly the line total.
      attributable_cost_minor: 5_000,
      attributable_cost_nok_minor: 5_000,
    })
    .select()
    .single()
  if (lineError) throw lineError
  return line as { id: string }
}

describe('RLS isolation: holdings', () => {
  it('owner can read their own holding; a direct client insert is refused (P130-13)', async () => {
    const holding = await createHolding(clientA, userA.id, 'NM')
    const { data } = await clientA.from('holdings').select().eq('id', holding.id).single()
    expect(data?.user_id).toBe(userA.id)
    const direct = await clientA.from('holdings').insert({
      user_id: userA.id,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.charizardVariantId,
      condition: 'NM',
    })
    expect(direct.error?.code).toBe('42501')
  })

  it('a stranger cannot read, update or delete another user holding', async () => {
    const holding = await createHolding(clientA, userA.id, 'LP')

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
  it('the S1 triggers accept a lot on the owner own holding and purchase line', async () => {
    const holding = await createHolding(clientA, userA.id, 'EX')
    const line = await createOwnedPurchaseLine(clientA, userA.id)

    const { data, error } = await service
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
    const holdingA = await createHolding(clientA, userA.id, 'GD')

    const attack = {
      holding_id: holdingA.id,
      user_id: userB.id,
      origin: 'other',
      cost_basis_state: 'unknown',
      acquired_on: new Date().toISOString().slice(0, 10),
      quantity: 1,
      quantity_remaining: 1,
    }
    expect((await clientB.from('acquisition_lots').insert(attack)).error).not.toBeNull()
    // The S1 trigger holds on its own, under the service role that bypasses RLS and the gate.
    expect((await service.from('acquisition_lots').insert(attack)).error).not.toBeNull()
  })

  it('rejects a lot on B own holding that cites A purchase_line (defence in depth)', async () => {
    const holdingB = await createHolding(clientB, userB.id, 'NM')
    const lineA = await createOwnedPurchaseLine(clientA, userA.id)

    const attack = {
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
    }
    expect((await clientB.from('acquisition_lots').insert(attack)).error).not.toBeNull()
    expect((await service.from('acquisition_lots').insert(attack)).error).not.toBeNull()
  })

  it('a stranger cannot read another user lot', async () => {
    const holding = await createHolding(clientA, userA.id, 'PL')
    const line = await createOwnedPurchaseLine(clientA, userA.id)
    const { data: lot } = await service
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
