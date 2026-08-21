import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M7 schema/constraint tests (docs/TESTING.md §5): custom_collections' ownership trigger (S1) and
 * the C1 invariant — deleting a collection removes membership only, never a holding, lot or
 * transaction (DATA_MODEL.md §5.2.1). Service-role client — bypasses RLS but never a trigger or
 * FK, which is what is under test here; cross-tenant *application* attacks (RLS) live in
 * tests/authorization/m7_portfolio.test.ts.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm7-constraints-a')
  userB = await createSyntheticUser(service, 'm7-constraints-b')
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

let manualCardCounter = 0

/** Each call creates its own manual_card_definitions row, so `holdings_identity` (scoped by
 *  user + coalesce(card_variant_id, sealed_product_id, manual_card_id) + condition + ...) never
 *  collides across the several holdings one test file creates for the same owner — unlike reusing
 *  a fixed seedCatalog variant + condition pair, which a second call for the same owner would
 *  conflict with. */
async function createHolding(owner: SyntheticUser) {
  manualCardCounter += 1
  const { data: manualCard, error: manualError } = await service
    .from('manual_card_definitions')
    .insert({
      user_id: owner.id,
      name: `M7 constraint test card ${Date.now()}-${manualCardCounter}`,
    })
    .select('id')
    .single()
  if (manualError) throw manualError

  const { data, error } = await service
    .from('holdings')
    .insert({
      user_id: owner.id,
      holding_kind: 'raw_card',
      manual_card_id: manualCard.id,
      condition: 'NM',
    })
    .select('id')
    .single()
  if (error) throw error

  const { error: lotError } = await service.from('acquisition_lots').insert({
    holding_id: data.id,
    user_id: owner.id,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: today,
    quantity: 1,
    quantity_remaining: 1,
  })
  if (lotError) throw lotError

  return data.id as string
}

describe('custom_collection_members: ownership trigger (S1)', () => {
  it('rejects a membership row whose user_id does not match the collection owner', async () => {
    const { data: collection } = await service
      .from('custom_collections')
      .insert({ user_id: userA.id, name: 'A collection' })
      .select('id')
      .single()
    const holdingId = await createHolding(userA)

    const { error } = await service.from('custom_collection_members').insert({
      collection_id: collection!.id,
      holding_id: holdingId,
      user_id: userB.id, // mismatched — must be rejected
    })
    expect(error).not.toBeNull()
  })

  it('rejects a membership row whose user_id does not match the holding owner', async () => {
    const { data: collection } = await service
      .from('custom_collections')
      .insert({ user_id: userA.id, name: 'Another collection' })
      .select('id')
      .single()
    const strangersHoldingId = await createHolding(userB)

    const { error } = await service.from('custom_collection_members').insert({
      collection_id: collection!.id,
      holding_id: strangersHoldingId,
      user_id: userA.id,
    })
    expect(error).not.toBeNull()
  })

  it('accepts a membership row where both parents belong to the same user', async () => {
    const { data: collection } = await service
      .from('custom_collections')
      .insert({ user_id: userA.id, name: 'A real binder' })
      .select('id')
      .single()
    const holdingId = await createHolding(userA)

    const { error } = await service.from('custom_collection_members').insert({
      collection_id: collection!.id,
      holding_id: holdingId,
      user_id: userA.id,
    })
    expect(error).toBeNull()
  })
})

describe('custom_collections: invariant C1', () => {
  it('deleting a collection removes membership only — the holding, lot and quantity survive', async () => {
    const holdingId = await createHolding(userA)
    const { data: collection } = await service
      .from('custom_collections')
      .insert({ user_id: userA.id, name: 'Trade Binder' })
      .select('id')
      .single()
    await service
      .from('custom_collection_members')
      .insert({ collection_id: collection!.id, holding_id: holdingId, user_id: userA.id })

    const { error: deleteError } = await service
      .from('custom_collections')
      .delete()
      .eq('id', collection!.id)
    expect(deleteError).toBeNull()

    const { data: membershipAfter } = await service
      .from('custom_collection_members')
      .select('collection_id')
      .eq('collection_id', collection!.id)
    expect(membershipAfter).toEqual([])

    const { data: holdingAfter } = await service
      .from('holdings')
      .select('id, deleted_at')
      .eq('id', holdingId)
      .single()
    expect(holdingAfter?.deleted_at).toBeNull()

    const { data: lotsAfter } = await service
      .from('acquisition_lots')
      .select('id, quantity_remaining, voided_at')
      .eq('holding_id', holdingId)
    expect(lotsAfter).toHaveLength(1)
    expect(lotsAfter?.[0]?.quantity_remaining).toBe(1)
    expect(lotsAfter?.[0]?.voided_at).toBeNull()
  })

  it('one holding may belong to several collections at once, independently removable', async () => {
    const holdingId = await createHolding(userA)
    const { data: c1 } = await service
      .from('custom_collections')
      .insert({ user_id: userA.id, name: 'Collection 1' })
      .select('id')
      .single()
    const { data: c2 } = await service
      .from('custom_collections')
      .insert({ user_id: userA.id, name: 'Collection 2' })
      .select('id')
      .single()

    await service.from('custom_collection_members').insert([
      { collection_id: c1!.id, holding_id: holdingId, user_id: userA.id },
      { collection_id: c2!.id, holding_id: holdingId, user_id: userA.id },
    ])

    await service
      .from('custom_collection_members')
      .delete()
      .eq('collection_id', c1!.id)
      .eq('holding_id', holdingId)

    const { data: remaining } = await service
      .from('custom_collection_members')
      .select('collection_id')
      .eq('holding_id', holdingId)
    expect(remaining).toEqual([{ collection_id: c2!.id }])
  })
})
