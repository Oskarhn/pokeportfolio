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

function purchasePayload(userId: string) {
  const today = new Date().toISOString().slice(0, 10)
  return {
    user_id: userId,
    purchased_on: today,
    currency: 'NOK',
    subtotal_minor: 10_000,
    shipping_minor: 0,
    customs_minor: 0,
    discount_minor: 0,
    total_minor: 10_000,
    fx_rate_date: today,
    total_nok_minor: 10_000,
  }
}

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'purchase-a')
  userB = await createSyntheticUser(service, 'purchase-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

describe('RLS isolation: purchases and purchase_lines', () => {
  it('owner reads a purchase and its lines together (rows created by the service role)', async () => {
    const { data: purchase, error: purchaseError } = await service
      .from('purchases')
      .insert(purchasePayload(userA.id))
      .select()
      .single()
    expect(purchaseError).toBeNull()

    const { data: line, error: lineError } = await service
      .from('purchase_lines')
      .insert({
        purchase_id: purchase!.id,
        user_id: userA.id,
        line_type: 'card',
        spend_class: 'collectible',
        card_variant_id: seedCatalog.charizardVariantId,
        quantity: 1,
        unit_price_minor: 10_000,
        line_total_minor: 10_000,
        // purchase_lines_attributable_cost_matches_allocation (M8): no shipping/customs/discount
        // on this purchase, so attributable cost is exactly the line total.
        attributable_cost_minor: 10_000,
        attributable_cost_nok_minor: 10_000,
      })
      .select()
      .single()
    expect(lineError).toBeNull()

    const { data: joined, error: joinError } = await clientA
      .from('purchases')
      .select('*, purchase_lines(*)')
      .eq('id', purchase!.id)
      .single()
    expect(joinError).toBeNull()
    expect(joined?.purchase_lines).toHaveLength(1)
    expect(joined?.purchase_lines[0].id).toBe(line!.id)
  })

  it('a stranger cannot read or update another user purchase by id', async () => {
    const { data: purchase } = await service
      .from('purchases')
      .insert(purchasePayload(userA.id))
      .select()
      .single()

    const { data: readAttempt } = await clientB.from('purchases').select().eq('id', purchase!.id)
    expect(readAttempt).toEqual([])

    const { data: updateAttempt } = await clientB
      .from('purchases')
      .update({ notes: 'attacker' })
      .eq('id', purchase!.id)
      .select()
    expect(updateAttempt).toEqual([])
  })

  it('nobody can delete a purchase through the client API, not even its owner (void semantics only)', async () => {
    const { data: purchase } = await service
      .from('purchases')
      .insert(purchasePayload(userA.id))
      .select()
      .single()

    // Financial ledger rows are void-only (SECURITY.md §8) — there is no DELETE grant on
    // `purchases` for `authenticated` at all, so this must fail even for the owner.
    const { error } = await clientA.from('purchases').delete().eq('id', purchase!.id)
    expect(error).not.toBeNull()

    const { data: stillThere } = await service
      .from('purchases')
      .select('id')
      .eq('id', purchase!.id)
      .single()
    expect(stillThere?.id).toBe(purchase!.id)
  })

  it('a stranger reading through the embedded purchase_lines resource sees nothing', async () => {
    const { data: purchase } = await service
      .from('purchases')
      .insert(purchasePayload(userA.id))
      .select()
      .single()
    await service.from('purchase_lines').insert({
      purchase_id: purchase!.id,
      user_id: userA.id,
      line_type: 'card',
      spend_class: 'collectible',
      card_variant_id: seedCatalog.pikachuVariantId,
      quantity: 1,
      unit_price_minor: 500,
      line_total_minor: 500,
    })

    const { data, error } = await clientB
      .from('purchases')
      .select('*, purchase_lines(*)')
      .eq('id', purchase!.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('cannot insert a purchase_line pointing at another user purchase (S1, rejected by trigger)', async () => {
    const { data: purchaseA } = await service
      .from('purchases')
      .insert(purchasePayload(userA.id))
      .select()
      .single()

    const attack = {
      purchase_id: purchaseA!.id,
      user_id: userB.id,
      line_type: 'card' as const,
      spend_class: 'collectible' as const,
      card_variant_id: seedCatalog.pikachuVariantId,
      quantity: 1,
      unit_price_minor: 500,
      line_total_minor: 500,
    }
    expect((await clientB.from('purchase_lines').insert(attack)).error).not.toBeNull()
    // The S1 trigger holds on its own, under the service role that bypasses RLS and the gate.
    expect((await service.from('purchase_lines').insert(attack)).error).not.toBeNull()
  })

  it('cannot insert a purchase directly, claiming another user as owner (P130-13)', async () => {
    const { error } = await clientA.from('purchases').insert(purchasePayload(userB.id))
    expect(error).not.toBeNull()
  })
})
