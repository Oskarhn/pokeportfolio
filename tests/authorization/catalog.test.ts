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
 * Shared catalog and market data (DATA_MODEL.md §1): readable by any authenticated user,
 * writable only by the service role. sealed_products is the one exception with per-row
 * user-created content (DATA_MODEL.md §3.3, SECURITY.md prompt §34).
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'catalog-a')
  userB = await createSyntheticUser(service, 'catalog-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

describe('Catalog: shared read, service-role-only write', () => {
  it('any authenticated user can read the seeded catalog', async () => {
    const { data, error } = await clientB
      .from('cards')
      .select()
      .eq('id', seedCatalog.charizardCardId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('an authenticated user cannot insert a card (no INSERT grant, service role only)', async () => {
    const { error } = await clientA.from('cards').insert({
      set_id: seedCatalog.cardSetId,
      local_id: '999',
      name: 'Forged Card',
    })
    expect(error).not.toBeNull()
  })

  it('an authenticated user cannot update or delete a card', async () => {
    const { error: updateError } = await clientA
      .from('cards')
      .update({ name: 'Tampered' })
      .eq('id', seedCatalog.charizardCardId)
    expect(updateError).not.toBeNull()

    const { error: deleteError } = await clientA
      .from('cards')
      .delete()
      .eq('id', seedCatalog.charizardCardId)
    expect(deleteError).not.toBeNull()
  })
})

describe('Catalog: sealed_products curated vs. user-added visibility', () => {
  it('the curated seeded sealed product is visible to every authenticated user', async () => {
    const { data, error } = await clientB
      .from('sealed_products')
      .select()
      .eq('id', seedCatalog.sealedProductId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('a user can create their own sealed product row', async () => {
    const { data, error } = await clientA
      .from('sealed_products')
      .insert({
        product_type: 'other',
        name: 'Homebrew binder set',
        language: 'en',
        created_by_user_id: userA.id,
      })
      .select()
      .single()
    expect(error).toBeNull()
    expect(data?.created_by_user_id).toBe(userA.id)
  })

  it('a user-added row is invisible to a different user', async () => {
    const { data: created } = await clientA
      .from('sealed_products')
      .insert({
        product_type: 'other',
        name: 'Private homebrew product',
        language: 'en',
        created_by_user_id: userA.id,
      })
      .select()
      .single()

    const { data } = await clientB.from('sealed_products').select().eq('id', created!.id)
    expect(data).toEqual([])
  })

  it('a user cannot create a sealed product claiming another creator, or a curated (null) one', async () => {
    const { error: spoofed } = await clientA
      .from('sealed_products')
      .insert({ product_type: 'other', name: 'x', language: 'en', created_by_user_id: userB.id })
    expect(spoofed).not.toBeNull()

    const { error: curated } = await clientA
      .from('sealed_products')
      .insert({ product_type: 'other', name: 'x', language: 'en' })
    expect(curated).not.toBeNull()
  })

  it('a user cannot edit another user added sealed product', async () => {
    const { data: created } = await clientA
      .from('sealed_products')
      .insert({
        product_type: 'other',
        name: 'Edit target',
        language: 'en',
        created_by_user_id: userA.id,
      })
      .select()
      .single()

    const { data } = await clientB
      .from('sealed_products')
      .update({ name: 'attacker-renamed' })
      .eq('id', created!.id)
      .select()
    expect(data).toEqual([])
  })
})
